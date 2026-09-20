const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  safeStorage,
  shell,
  clipboard,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { pathToFileURL } = require("node:url");
const {
  lineDecoder,
  argumentsFor,
  normalize,
  MODES,
  providerEnv,
  isNewerVersion,
  skillSearchQuery,
  normalizeGitHubRepository,
  isSkillRepository,
  dependencyDownloadUrls,
  installPlan,
  id,
} = require("./core.cjs");
const exec = promisify(execFile);
if (process.env.CCB_TEST_USER_DATA)
  app.setPath("userData", process.env.CCB_TEST_USER_DATA);
// The UI has no GPU-heavy content. Software rendering avoids driver crashes on older
// and virtualized Windows machines, which are common among the app's target users.
app.disableHardwareAcceleration();
let win,
  db,
  state,
  run = null,
  persistTimer,
  stateEmitTimer,
  authProcess = null,
  installProcess = null,
  exitAfterRun = false,
  closePromptOpen = false;
const pending = new Map();
const home = os.homedir();
const releasesPage = "https://github.com/DongfangYanxu2024/cc-board/releases";
const githubApiHeaders = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": `cc-board/${app.getVersion()}`,
};
const skillSearchCache = new Map();
let featuredSkillCache = null;
function persist() {
  if (db && state)
    db.prepare("INSERT OR REPLACE INTO state(id, payload) VALUES (1, ?)").run(
      JSON.stringify(state),
    );
}
function saveSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 200);
}
function emit(type, data) {
  if (win && !win.isDestroyed())
    win.webContents.send("board:event", { type, ...data });
}
function publicState() {
  return {
    ...state,
    providers: state.providers.map(({ secret, extraEnv, ...p }) => ({
      ...p,
      hasKey: Boolean(secret),
    })),
    running: run ? { sessionId: run.session.id, mode: run.mode } : null,
  };
}
function update() {
  if (!stateEmitTimer) {
    stateEmitTimer = setTimeout(() => {
      stateEmitTimer = null;
      emit("state", { state: publicState() });
    }, 32);
  }
  saveSoon();
}
function normalizedState(value) {
  const source = value && typeof value === "object" ? value : {};
  const sessions = Array.isArray(source.sessions)
    ? source.sessions.map((session) => ({
        ...session,
        title: typeof session.title === "string" ? session.title : "未命名对话",
        cwd: typeof session.cwd === "string" ? session.cwd : "",
        messages: Array.isArray(session.messages) ? session.messages : [],
        runs: Array.isArray(session.runs) ? session.runs : [],
        pinned: session.pinned === true,
        archived: session.archived === true,
      }))
    : [];
  return {
    sessions,
    providers: Array.isArray(source.providers) ? source.providers : [],
    settings:
      source.settings && typeof source.settings === "object"
        ? source.settings
        : {},
  };
}
function encrypt(text) {
  if (!safeStorage.isEncryptionAvailable())
    throw Error("系统加密存储不可用，无法保存密钥");
  return safeStorage.encryptString(text).toString("base64");
}
function decrypt(text) {
  return safeStorage.decryptString(Buffer.from(text, "base64"));
}
function redact(text) {
  let out = String(text || "");
  const secrets = state.providers.flatMap((p) => {
    try {
      return p.secret ? [decrypt(p.secret)] : [];
    } catch {
      return [];
    }
  });
  for (const key of secrets)
    if (key.length >= 4) out = out.split(key).join("[密钥已隐藏]");
  return out.replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "[密钥已隐藏]");
}
function message(session, role, text, extra = {}) {
  const m = { id: id(), role, text: redact(text), time: Date.now(), ...extra };
  session.messages.push(m);
  session.updated = Date.now();
  return m;
}
function requireDirectory(value) {
  try {
    if (
      typeof value !== "string" ||
      !path.isAbsolute(value) ||
      !fs.statSync(value).isDirectory()
    )
      throw Error();
  } catch {
    throw Error("工作文件夹不存在或不可访问，请重新选择");
  }
  return value;
}
function createSessionRecord(cwd) {
  return {
    id: id(),
    title: "新对话",
    cwd: requireDirectory(cwd),
    created: Date.now(),
    updated: Date.now(),
    messages: [],
    runs: [],
    providerId: "native",
    model: "",
    mode: "default",
    pinned: false,
    archived: false,
  };
}
async function findCli() {
  const candidates = [
    process.env.CCB_TEST_CLI_PATH,
    state.settings.cliPath,
    path.join(home, ".local", "bin", "claude.exe"),
    path.join(home, ".claude", "local", "claude.exe"),
  ].filter(Boolean);
  try {
    const r = await exec("where.exe", ["claude"], {
      windowsHide: true,
      timeout: 5000,
    });
    candidates.push(
      ...r.stdout
        .trim()
        .split(/\r?\n/)
        .filter((p) => p.toLowerCase().endsWith(".exe")),
    );
  } catch {}
  for (const candidate of candidates)
    if (
      path.isAbsolute(candidate) &&
      fs.existsSync(candidate) &&
      candidate.toLowerCase().endsWith(".exe")
    )
      return candidate;
  return null;
}
async function detectExecutable(command, args, candidates = []) {
  const paths = candidates.filter(Boolean);
  try {
    const found = await exec("where.exe", [command], {
      windowsHide: true,
      timeout: 5000,
    });
    paths.push(...found.stdout.trim().split(/\r?\n/).filter(Boolean));
  } catch {}
  let detectedError = null;
  for (const executable of [...new Set(paths)]) {
    if (!path.isAbsolute(executable)) continue;
    try {
      const result = await exec(executable, args, {
        windowsHide: true,
        timeout: 10000,
      });
      return {
        installed: true,
        path: executable,
        version: String(result.stdout || result.stderr || "已安装").trim(),
      };
    } catch (error) {
      if (fs.existsSync(executable))
        detectedError = {
          installed: true,
          path: executable,
          version: null,
          error: redact(error.message),
        };
    }
  }
  return detectedError || { installed: false, path: null, version: null };
}
async function environment() {
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const localAppData = process.env.LOCALAPPDATA || "";
  const [cliPath, git, node, winget] = await Promise.all([
    findCli(),
    detectExecutable("git", ["--version"], [
      path.join(programFiles, "Git", "cmd", "git.exe"),
    ]),
    detectExecutable("node", ["--version"], [
      path.join(programFiles, "nodejs", "node.exe"),
    ]),
    detectExecutable("winget", ["--version"], [
      localAppData
        ? path.join(localAppData, "Microsoft", "WindowsApps", "winget.exe")
        : "",
    ]),
  ]);
  let version = null,
    error = null,
    auth = null;
  if (cliPath) {
    try {
      version = (
        await exec(cliPath, ["--version"], {
          windowsHide: true,
          timeout: 15000,
        })
      ).stdout.trim();
    } catch (e) {
      error = redact(e.message);
    }
    try {
      const status = await exec(cliPath, ["auth", "status"], {
        windowsHide: true,
        timeout: 15000,
      });
      const value = JSON.parse(status.stdout || "{}");
      auth = {
        loggedIn: Boolean(value.loggedIn),
        method: value.authMethod || value.authType || null,
        email: typeof value.email === "string" ? value.email : null,
      };
    } catch (e) {
      try {
        const value = JSON.parse(e.stdout || "{}");
        auth = { loggedIn: Boolean(value.loggedIn), method: null, email: null };
      } catch {
        auth = { loggedIn: false, method: null, email: null };
      }
    }
  }
  return {
    appVersion: app.getVersion(),
    cliPath,
    version,
    auth,
    error,
    dependencies: { git, node, winget },
    ccSwitch: fs.existsSync(path.join(home, ".cc-switch", "cc-switch.db")),
    dataPath: app.getPath("userData"),
  };
}
async function checkUpdate() {
  let response;
  try {
    response = await fetch(
      "https://api.github.com/repos/DongfangYanxu2024/cc-board/releases?per_page=10",
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": `cc-board/${app.getVersion()}`,
        },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      },
    );
  } catch {
    throw Error("无法连接 GitHub，请检查网络后重试");
  }
  if (!response.ok)
    throw Error(`GitHub 更新服务返回 HTTP ${response.status}，请稍后重试`);
  const releases = await response.json();
  const latest = Array.isArray(releases)
    ? releases.find(
        (release) =>
          !release.draft && /^v?\d+\.\d+\.\d+/.test(release.tag_name || ""),
      )
    : null;
  const current = app.getVersion();
  if (!latest)
    return { current, latest: null, hasUpdate: false, url: releasesPage };
  return {
    current,
    latest: latest.tag_name.replace(/^v/i, ""),
    hasUpdate: isNewerVersion(latest.tag_name, current),
    name: latest.name || latest.tag_name,
    prerelease: Boolean(latest.prerelease),
    publishedAt: latest.published_at || null,
    url: latest.html_url || releasesPage,
  };
}
async function githubJson(url) {
  let response;
  try {
    response = await fetch(url, {
      headers: githubApiHeaders,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw Error("无法连接 GitHub，请检查网络后重试");
  }
  if (response.status === 403 || response.status === 429)
    throw Error("GitHub 搜索次数暂时受限，请稍后再试");
  if (!response.ok)
    throw Error(`GitHub 返回 HTTP ${response.status}，请稍后重试`);
  return response.json();
}
async function searchSkills(data = {}) {
  const displayQuery = String(data.query || "").trim().slice(0, 80);
  if (process.env.CCB_SMOKE_SKILLS === "1")
    return {
      query: displayQuery,
      results: [
        {
          id: 1,
          fullName: "anthropics/skills",
          description: "Anthropic official skill examples",
          url: "https://github.com/anthropics/skills",
          stars: 42000,
          forks: 3900,
          updatedAt: "2026-01-01T00:00:00Z",
          language: "Python",
          license: "Apache-2.0",
          topics: ["skills", "claude-code"],
          official: true,
        },
      ],
    };
  const minimumStars = Number(data.minimumStars);
  const query = skillSearchQuery(data.query, minimumStars);
  const cacheKey = query.toLowerCase();
  const cached = skillSearchCache.get(cacheKey);
  if (cached && Date.now() - cached.time < 5 * 60 * 1000) return cached.value;
  const params = new URLSearchParams({
    q: query,
    sort: "stars",
    order: "desc",
    per_page: "24",
  });
  const payload = await githubJson(
    `https://api.github.com/search/repositories?${params}`,
  );
  const repositories = Array.isArray(payload.items) ? payload.items : [];
  if (!displayQuery) {
    try {
      if (!featuredSkillCache || Date.now() - featuredSkillCache.time >= 10 * 60 * 1000) {
        const featuredParams = new URLSearchParams({
          q: "org:anthropics skills in:name,description,readme",
          sort: "stars",
          order: "desc",
          per_page: "10",
        });
        const featured = await githubJson(
          `https://api.github.com/search/repositories?${featuredParams}`,
        );
        featuredSkillCache = {
          time: Date.now(),
          items: Array.isArray(featured.items) ? featured.items : [],
        };
      }
      repositories.push(...featuredSkillCache.items);
    } catch {
      // The general results are still useful when GitHub throttles this optional
      // official-source lookup.
    }
  }
  const results = repositories
    .map(normalizeGitHubRepository)
    .filter(isSkillRepository)
    .filter(
      (repo, index, all) =>
        repo && all.findIndex((item) => item?.fullName === repo.fullName) === index,
    );
  const value = { results, query: displayQuery };
  skillSearchCache.set(cacheKey, { time: Date.now(), value });
  return value;
}
function safeUrl(value) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" &&
    !(
      u.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)
    )
  )
    throw Error("API 地址应使用 HTTPS；本机服务可使用 HTTP");
  if (u.username || u.password || u.search || u.hash)
    throw Error("API 地址不能包含密码、查询参数或片段");
  return u.toString().replace(/\/$/, "");
}
function extractProvider(name, config, sourceId) {
  const e = config.env || {};
  const baseUrl = e.ANTHROPIC_BASE_URL;
  if (!baseUrl) return null;
  const secret = e.ANTHROPIC_AUTH_TOKEN || e.ANTHROPIC_API_KEY;
  // Import only known model aliases, never arbitrary executable environment variables.
  const extraEnv = Object.fromEntries(
    Object.entries(e).filter(
      ([k, v]) =>
        /^ANTHROPIC_DEFAULT_(HAIKU|SONNET|OPUS)_MODEL$/.test(k) &&
        typeof v === "string",
    ),
  );
  return {
    id: sourceId,
    name,
    baseUrl: safeUrl(baseUrl),
    model: e.ANTHROPIC_MODEL || "",
    authType: e.ANTHROPIC_AUTH_TOKEN ? "token" : "apiKey",
    secret: secret ? encrypt(secret) : "",
    extraEnv,
    source: "CC Switch / 原生配置",
  };
}
async function importProviders() {
  const { DatabaseSync } = require("node:sqlite");
  const file = path.join(home, ".cc-switch", "cc-switch.db");
  let imported = 0,
    skipped = 0;
  const candidates = [];
  if (fs.existsSync(file)) {
    const source = new DatabaseSync(file, { readOnly: true });
    try {
      for (const row of source
        .prepare(
          "SELECT id, name, settings_config FROM providers WHERE app_type = 'claude'",
        )
        .all()) {
        try {
          candidates.push(
            extractProvider(
              row.name,
              JSON.parse(row.settings_config),
              "ccswitch-" + row.id,
            ),
          );
        } catch {
          skipped++;
        }
      }
    } finally {
      source.close();
    }
  }
  const configPath = path.join(home, ".claude", "settings.json");
  if (fs.existsSync(configPath)) {
    try {
      candidates.push(
        extractProvider(
          "当前 Claude Code 配置",
          JSON.parse(fs.readFileSync(configPath, "utf8")),
          "claude-current",
        ),
      );
    } catch {
      skipped++;
    }
  }
  for (const p of candidates.filter(Boolean)) {
    const i = state.providers.findIndex((x) => x.id === p.id);
    if (i >= 0)
      state.providers[i] = {
        ...p,
        secret: p.secret || state.providers[i].secret || "",
      };
    else state.providers.push(p);
    imported++;
  }
  update();
  return { imported, skipped };
}
async function approvalServer(current) {
  const server = http.createServer((req, res) => {
    if (
      req.method !== "POST" ||
      req.url !== "/approve" ||
      req.headers.authorization !== `Bearer ${current.token}` ||
      req.headers.origin
    ) {
      res.writeHead(403);
      return res.end("{}");
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) req.destroy();
    });
    req.on("end", () => {
      if (run !== current || current.stopping)
        return res.end(
          JSON.stringify({ behavior: "deny", message: "任务已停止" }),
        );
      let request;
      try {
        request = JSON.parse(body);
      } catch {
        res.writeHead(400);
        return res.end("{}");
      }
      const requestId = id();
      const input = request.input || {};
      const approval = {
        requestId,
        sessionId: current.session.id,
        tool: request.tool_name || "未知工具",
        input: JSON.parse(redact(JSON.stringify(input))),
      };
      const timer = setTimeout(
        () => finish(false, "审批等待超过 10 分钟"),
        600000,
      );
      function finish(allow, reason = "") {
        clearTimeout(timer);
        pending.delete(requestId);
        if (!res.writableEnded)
          res.end(
            JSON.stringify(
              allow
                ? { behavior: "allow", updatedInput: input }
                : { behavior: "deny", message: reason || "用户拒绝了本次操作" },
            ),
          );
        message(
          current.session,
          "audit",
          `${allow ? "已允许" : "已拒绝"}：${approval.tool}`,
        );
        emit("approvalClosed", { requestId });
        update();
      }
      pending.set(requestId, { finish, sessionId: current.session.id });
      res.on("close", () => {
        if (pending.has(requestId)) finish(false, "审批连接关闭");
      });
      emit("approval", approval);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}
function finishRun(current, code, error) {
  if (current.finished) return;
  current.finished = true;
  for (const p of [...pending.values()])
    if (p.sessionId === current.session.id) p.finish(false, "任务结束");
  current.server?.close();
  current.server?.closeAllConnections();
  if (error) message(current.session, "error", error);
  else if (current.stopping)
    message(
      current.session,
      "system",
      "已停止。已执行的文件操作不会自动撤销。",
    );
  else if (!current.resultReceived)
    message(
      current.session,
      "error",
      `Claude Code 未返回完整结果（退出码 ${code ?? "未知"}）。${current.stderr ? "\n" + current.stderr : ""}`,
    );
  if (run === current) run = null;
  update();
  persist();
  if (exitAfterRun && !run) {
    exitAfterRun = false;
    setImmediate(() => app.quit());
  }
}
async function startRun(data) {
  if (run) throw Error("请先停止或等待当前任务结束");
  const s = state.sessions.find((x) => x.id === data.sessionId);
  if (!s) throw Error("会话不存在");
  const prompt = String(data.prompt || "").trim();
  if (!prompt || prompt.length > 100000)
    throw Error("请输入 1–100000 字符的内容");
  if (!fs.existsSync(s.cwd) || !fs.statSync(s.cwd).isDirectory())
    throw Error("工作文件夹不存在，请重新选择");
  const cli = await findCli();
  if (!cli)
    throw Error("未检测到原生 Claude Code。请在设置中安装或选择 claude.exe。");
  const mode = data.mode;
  if (!MODES.includes(mode)) throw Error("权限模式无效");
  if (mode === "bypassPermissions") {
    if (data.bypassConfirmed !== true)
      throw Error("完全自动模式需要在风险确认区中明确确认");
  }
  const profile = state.providers.find((p) => p.id === data.providerId);
  if (data.providerId !== "native" && !profile) throw Error("服务商不存在");
  if (s.claudeSessionId && s.providerId && s.providerId !== data.providerId) {
    const answer = await dialog.showMessageBox(win, {
      type: "warning",
      message: "切换服务商并继续此会话？",
      detail:
        "历史对话和工作内容可能发送给新服务商。协议不兼容时需要新建会话。",
      buttons: ["取消", "继续"],
      defaultId: 0,
      cancelId: 0,
    });
    if (answer.response !== 1) return { cancelled: true };
  }
  // Recheck after asynchronous dialogs.
  if (run) throw Error("另一个任务正在运行");
  const current = {
    session: s,
    mode,
    token: id() + id(),
    stderr: "",
    textMessage: null,
    resultReceived: false,
    stopping: false,
  };
  run = current;
  try {
    current.server = await approvalServer(current);
    const helper = path
      .join(__dirname, "permission-server.cjs")
      .replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep);
    const mcp = {
      mcpServers: {
        ccboard: {
          command: process.execPath,
          args: [helper],
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            CCB_PORT: String(current.server.address().port),
            CCB_TOKEN: current.token,
            CCB_VERSION: app.getVersion(),
          },
        },
      },
    };
    const args = argumentsFor({
      session: s.claudeSessionId,
      mode,
      model: String(data.model || profile?.model || ""),
      mcp,
    });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.CLAUDECODE;
    if (profile) {
      for (const k of Object.keys(env))
        if (k.startsWith("ANTHROPIC_") || /^CLAUDE_CODE_USE_/.test(k))
          delete env[k];
      const override = {
        ANTHROPIC_AUTH_TOKEN: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_MODEL: "",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "",
        CLAUDE_CODE_USE_BEDROCK: "0",
        CLAUDE_CODE_USE_VERTEX: "0",
        CLAUDE_CODE_USE_FOUNDRY: "0",
        ...providerEnv(profile, decrypt),
      };
      Object.assign(env, override);
      // Keep credentials out of the process command line. The non-secret endpoint
      // and model overrides still mask conflicting values from global settings.
      const settingsEnv = Object.fromEntries(
        Object.entries(override).filter(
          ([key]) => !/AUTH_TOKEN|API_KEY/.test(key),
        ),
      );
      args.push("--settings", JSON.stringify({ env: settingsEnv }));
    }
    s.providerId = data.providerId;
    s.model = data.model || profile?.model || "";
    s.mode = mode;
    if (!s.messages.some((m) => m.role === "user"))
      s.title = prompt.slice(0, 32);
    message(s, "user", prompt);
    message(s, "audit", `本次运行：${profile?.name || "原生配置"} · ${mode}`);
    const child = spawn(cli, args, {
      cwd: s.cwd,
      env,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    current.child = child;
    function onEvent(raw) {
      const e = normalize(raw);
      if (!e) return;
      if (e.kind === "session") s.claudeSessionId = e.sessionId;
      if (e.kind === "delta") {
        if (!current.textMessage)
          current.textMessage = message(s, "assistant", "");
        current.textMessage.text += redact(e.text);
      }
      if (e.kind === "assistant") {
        const text = e.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        if (text) {
          if (current.textMessage) current.textMessage.text = redact(text);
          else message(s, "assistant", text);
        }
        current.textMessage = null;
        for (const block of e.content)
          if (block.type === "tool_use")
            message(s, "tool", JSON.stringify(block.input, null, 2), {
              tool: block.name,
              toolId: block.id,
            });
      }
      if (e.kind === "tool_result")
        for (const block of e.content)
          if (block.type === "tool_result")
            message(
              s,
              "toolResult",
              typeof block.content === "string"
                ? block.content
                : JSON.stringify(block.content),
              { toolId: block.tool_use_id, error: Boolean(block.is_error) },
            );
      if (e.kind === "result" && !current.resultReceived) {
        current.resultReceived = true;
        if (e.error) message(s, "error", e.text || "Claude Code 返回错误");
        else if (
          e.text &&
          !s.messages.some(
            (m) => m.role === "assistant" && m.text === redact(e.text),
          )
        )
          message(s, "assistant", e.text);
        s.runs.push({
          id: id(),
          time: Date.now(),
          providerId: data.providerId,
          model: s.model,
          usage: e.usage,
          cost: e.cost,
        });
        if (e.denials.length)
          message(s, "system", `有 ${e.denials.length} 项工具请求被拒绝。`);
      }
      update();
    }
    const decoder = lineDecoder(onEvent, (line) => {
      current.stderr = redact(line).slice(-6000);
    });
    child.stdout.on("data", (chunk) => {
      try {
        decoder.write(chunk);
      } catch (e) {
        current.stderr = e.message;
        void stopRun();
      }
    });
    child.stderr.on("data", (chunk) => {
      current.stderr = redact(current.stderr + chunk.toString()).slice(-6000);
    });
    child.stdin.on("error", () => {});
    child.once("error", (e) => finishRun(current, null, e.message));
    child.once("close", (code) => {
      try {
        decoder.end();
      } catch {}
      finishRun(current, code);
    });
    child.stdin.end(prompt);
    update();
    return { started: true };
  } catch (e) {
    finishRun(current, null, e.message);
    throw e;
  }
}
async function stopRun() {
  const current = run;
  if (!current) return;
  current.stopping = true;
  for (const p of [...pending.values()]) p.finish(false, "用户停止任务");
  if (current.child?.pid) {
    try {
      await exec(
        "taskkill.exe",
        ["/PID", String(current.child.pid), "/T", "/F"],
        { windowsHide: true, timeout: 10000 },
      );
    } catch {
      current.child.kill();
    }
  }
  // Do not report idle until the process close event confirms termination.
  update();
}
function cleanInstallerOutput(value) {
  return redact(value)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r(?!\n)/g, "\n")
    .trim();
}
async function installDependency(data = {}) {
  if (run) throw Error("运行中不能安装");
  if (installProcess) throw Error("另一个安装任务正在进行中");
  const target = String(data.target || "");
  const current = await environment();
  const plan = installPlan(target, current.dependencies.winget.path || "");
  if (!plan.command) return { manual: true, url: plan.manualUrl };
  const names = { claude: "Claude Code", git: "Git for Windows", node: "Node.js LTS" };
  emit("install", {
    target,
    status: "running",
    text: `正在安装 ${names[target]}…`,
  });
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(plan.command, plan.args, {
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      installProcess = child;
      let output = "";
      const collect = (chunk) => {
        output = cleanInstallerOutput(output + chunk.toString()).slice(-8000);
        emit("install", { target, status: "running", text: output });
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      const timer = setTimeout(() => child.kill(), 10 * 60 * 1000);
      child.once("error", (error) => {
        clearTimeout(timer);
        installProcess = null;
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        installProcess = null;
        if (code === 0) resolve();
        else reject(Error(output || `安装程序退出码：${code}`));
      });
    });
    emit("install", { target, status: "verifying", text: "安装完成，正在重新检测…" });
    const refreshed = await environment();
    emit("install", {
      target,
      status: "success",
      text: `${names[target]} 安装完成。`,
    });
    return refreshed;
  } catch (e) {
    emit("install", {
      target,
      status: "error",
      text: "安装失败：" + redact(e.message),
      fallbackUrl: plan.manualUrl,
    });
    throw Error(`安装 ${names[target]} 失败，可改用官方下载入口`);
  }
}
async function installCli() {
  return installDependency({ target: "claude" });
}
async function authLogin() {
  if (run) throw Error("任务运行中不能登录");
  if (authProcess) throw Error("登录流程已经在进行中");
  const cli = await findCli();
  if (!cli) throw Error("请先安装或选择 Claude Code");
  emit("install", {
    target: "claude",
    status: "auth",
    text: "正在打开 Claude 官方登录页面，请在浏览器中完成登录…",
  });
  return new Promise((resolve, reject) => {
    const child = spawn(cli, ["auth", "login"], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    authProcess = child;
    let output = "";
    const collect = (chunk) => {
      output = redact(output + chunk.toString()).slice(-8000);
      emit("install", { target: "claude", status: "auth", text: output });
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill(), 300000);
    child.once("error", (error) => {
      clearTimeout(timer);
      authProcess = null;
      reject(Error(`无法启动登录：${redact(error.message)}`));
    });
    child.once("close", async (code) => {
      clearTimeout(timer);
      authProcess = null;
      if (code !== 0) return reject(Error(output || "Claude 登录未完成"));
      emit("install", {
        target: "claude",
        status: "success",
        text: "Claude 登录完成。",
      });
      resolve(await environment());
    });
  });
}
const actions = {
  state: () => publicState(),
  environment,
  markEnvironmentGuideSeen: () => {
    state.settings.environmentGuideSeen = true;
    update();
    return { saved: true };
  },
  pickFolder: async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"],
    });
    return r.canceled ? null : r.filePaths[0];
  },
  pickCli: async () => {
    const r = await dialog.showOpenDialog(win, {
      filters: [{ name: "Claude Code", extensions: ["exe"] }],
      properties: ["openFile"],
    });
    if (!r.canceled) {
      state.settings.cliPath = r.filePaths[0];
      persist();
    }
    return environment();
  },
  createSession: (data) => {
    const s = createSessionRecord(data.cwd);
    state.sessions.unshift(s);
    update();
    return s.id;
  },
  renameSession: (data) => {
    const s = state.sessions.find((s) => s.id === data.id);
    if (s) {
      s.title = String(data.title).trim().slice(0, 80) || "未命名对话";
      update();
    }
  },
  archiveSession: (data) => {
    if (run?.session.id === data.id) throw Error("运行中的会话不能归档");
    const s = state.sessions.find((s) => s.id === data.id);
    if (s) {
      s.archived = !s.archived;
      update();
    }
  },
  setSessionPinned: (data) => {
    const s = state.sessions.find((session) => session.id === data.id);
    if (!s) throw Error("会话不存在");
    s.pinned = data.pinned === true;
    update();
    return { pinned: s.pinned };
  },
  createSessionInSameFolder: (data) => {
    const source = state.sessions.find((session) => session.id === data.id);
    if (!source) throw Error("会话不存在");
    const s = createSessionRecord(source.cwd);
    state.sessions.unshift(s);
    update();
    return s.id;
  },
  deleteSession: async (data) => {
    if (run?.session.id === data.id) throw Error("运行中的会话不能删除");
    const index = state.sessions.findIndex((session) => session.id === data.id);
    if (index < 0) throw Error("会话不存在");
    const target = state.sessions[index];
    const answer = await dialog.showMessageBox(win, {
      type: "warning",
      message: `永久删除“${target.title}”？`,
      detail:
        "消息、用量和会话关联将从 cc-board 删除且无法恢复。不会删除工作目录中的文件，也不会清除 Claude Code 自身保存的历史记录。",
      buttons: ["取消", "永久删除"],
      cancelId: 0,
      defaultId: 0,
    });
    if (answer.response !== 1) return { cancelled: true };
    if (run?.session.id === data.id) throw Error("运行中的会话不能删除");
    const confirmedIndex = state.sessions.findIndex(
      (session) => session.id === data.id,
    );
    if (confirmedIndex < 0) throw Error("会话已经不存在");
    state.sessions.splice(confirmedIndex, 1);
    update();
    persist();
    return { deleted: true };
  },
  copyMessage: async (data) => {
    const s = state.sessions.find((session) => session.id === data.sessionId);
    const item = s?.messages.find((entry) => entry.id === data.messageId);
    if (!item) throw Error("消息不存在");
    const text = String(item.text || "");
    await clipboard.writeText(text);
    return { copied: true, length: text.length };
  },
  start: startRun,
  stop: stopRun,
  approve: (data) => {
    const p = pending.get(data.requestId);
    if (!p) throw Error("审批已过期");
    p.finish(data.allow === true);
  },
  saveProvider: (data) => {
    const existing = state.providers.find((p) => p.id === data.id);
    const p = {
      id: existing?.id || id(),
      name: String(data.name || "")
        .trim()
        .slice(0, 80),
      baseUrl: safeUrl(data.baseUrl),
      model: String(data.model || "").slice(0, 200),
      authType: data.authType === "apiKey" ? "apiKey" : "token",
      secret: data.key ? encrypt(String(data.key)) : existing?.secret || "",
      extraEnv: existing?.extraEnv || {},
      source: "手动配置",
    };
    if (!p.name) throw Error("请填写服务商名称");
    if (existing) Object.assign(existing, p);
    else state.providers.push(p);
    update();
    return p.id;
  },
  clearProviderKey: async (data) => {
    if (run) throw Error("请等待当前任务结束后再修改服务商");
    const provider = state.providers.find((item) => item.id === data.id);
    if (!provider) throw Error("服务商不存在");
    const answer = await dialog.showMessageBox(win, {
      type: "warning",
      message: `清除“${provider.name}”保存的密钥？`,
      detail: "此操作只清除 cc-board 中的加密副本，不会修改 CC Switch。",
      buttons: ["取消", "清除"],
      cancelId: 0,
      defaultId: 0,
    });
    if (answer.response !== 1) return { cancelled: true };
    provider.secret = "";
    update();
    return { cleared: true };
  },
  deleteProvider: async (data) => {
    if (run) throw Error("请等待当前任务结束后再删除服务商");
    const index = state.providers.findIndex((item) => item.id === data.id);
    if (index < 0) throw Error("服务商不存在");
    const answer = await dialog.showMessageBox(win, {
      type: "warning",
      message: `删除“${state.providers[index].name}”？`,
      detail:
        "只删除 cc-board 中的配置。历史记录仍会保留；从 CC Switch 导入的配置可以再次导入。",
      buttons: ["取消", "删除"],
      cancelId: 0,
      defaultId: 0,
    });
    if (answer.response !== 1) return { cancelled: true };
    state.providers.splice(index, 1);
    update();
    return { deleted: true };
  },
  importProviders,
  testProvider: async (data) => {
    const p = state.providers.find((p) => p.id === data.id);
    if (!p) throw Error("请先保存服务商");
    if (!p.model) throw Error("请填写实际模型 ID 后再测试");
    const answer = await dialog.showMessageBox(win, {
      message: "发送最小测试请求？",
      detail:
        "将向此服务商发送“Reply OK”，可能产生少量费用。仅验证基础消息接口，工具调用兼容性仍需实际任务验证。",
      buttons: ["取消", "测试"],
      cancelId: 0,
      defaultId: 1,
    });
    if (answer.response !== 1) return { cancelled: true };
    const headers = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (p.secret) {
      if (p.authType === "apiKey") headers["x-api-key"] = decrypt(p.secret);
      else headers.authorization = "Bearer " + decrypt(p.secret);
    }
    const endpoint =
      p.baseUrl.replace(/\/$/, "") +
      (p.baseUrl.endsWith("/v1") ? "/messages" : "/v1/messages");
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        model: p.model,
        max_tokens: 8,
        messages: [{ role: "user", content: "Reply OK" }],
      }),
    });
    if (!response.ok)
      throw Error(
        `服务商返回 HTTP ${response.status}，请检查地址、密钥与模型 ID`,
      );
    const payload = await response.json();
    if (!Array.isArray(payload.content))
      throw Error("接口返回格式不符合 Anthropic Messages 协议");
    return { ok: true };
  },
  installCli,
  installDependency,
  openDependencyDownload: (data) => {
    const url = dependencyDownloadUrls[String(data.target || "")];
    if (!url) throw Error("不支持的下载项目");
    return shell.openExternal(url);
  },
  authLogin,
  checkUpdate,
  searchSkills,
  openReleases: () => shell.openExternal(releasesPage),
  openGitHub: (data) => {
    const url = new URL(String(data.url || ""));
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.username ||
      url.password ||
      url.port
    )
      throw Error("只能打开 GitHub 仓库链接");
    return shell.openExternal(url.toString());
  },
  commandDocs: () =>
    shell.openExternal("https://code.claude.com/docs/zh-CN/commands"),
  skillDocs: () =>
    shell.openExternal("https://code.claude.com/docs/zh-CN/skills"),
  docs: () => shell.openExternal("https://code.claude.com/docs/en/setup"),
  exportSession: async (data) => {
    const s = state.sessions.find((s) => s.id === data.id);
    if (!s) throw Error("会话不存在");
    const r = await dialog.showSaveDialog(win, {
      defaultPath: "cc-board-chat.md",
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!r.canceled)
      fs.writeFileSync(
        r.filePath,
        "# " +
          s.title +
          "\n\n" +
          s.messages.map((m) => `## ${m.role}\n\n${m.text}`).join("\n\n"),
        "utf8",
      );
  },
};
async function runDesktopSmoke(index) {
  const output = process.env.CCB_SMOKE_OUTPUT;
  if (!output) return;
  const cwd = process.env.CCB_SMOKE_CWD;
  const fail = (message) => {
    throw Error(message);
  };
  try {
    const first = await win.webContents.executeJavaScript(
      `({ heading: document.body.innerText.includes('今天，一起做点什么？') || document.body.innerText.includes('首次使用检查'), api: Boolean(window.board) })`,
    );
    if (!first.heading || !first.api) fail("欢迎页或安全 IPC 桥未加载");
    const ui = await win.webContents.executeJavaScript(`(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const button = text => [...document.querySelectorAll('button')].find(node => node.textContent.includes(text));
      button('模型与服务商')?.click(); await wait(180);
      if (!document.querySelector('.provider-form')) {
        button('模型与服务商')?.click(); await wait(120);
      }
      if (!document.querySelector('.provider-form')) throw Error('服务商表单未显示');
      try {
        await window.board.invoke('saveProvider', { name: '本地测试服务', model: 'test-model', baseUrl: 'http://127.0.0.1:9999', authType: 'token', key: ${JSON.stringify(process.env.CCB_SMOKE_KEY || "")} });
      } catch (error) { throw Error('保存服务商失败：' + error.message); }
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (document.body.innerText.includes('本地测试服务')) break;
        await wait(100);
      }
      let importResult = null;
      try {
        importResult = ${JSON.stringify(process.env.CCB_SMOKE_IMPORT === "1")} ? await window.board.invoke('importProviders') : null;
      } catch (error) { throw Error('导入服务商失败：' + error.message); }
      let sessionId;
      let sameFolderId;
      try {
        sessionId = await window.board.invoke('createSession', { cwd: ${JSON.stringify(cwd)} });
        await window.board.invoke('renameSession', { id: sessionId, title: '保存的中文历史' });
        await window.board.invoke('setSessionPinned', { id: sessionId, pinned: true });
        sameFolderId = await window.board.invoke('createSessionInSameFolder', { id: sessionId });
      } catch (error) { throw Error('保存历史失败：' + error.message); }
      return { sessionId, sameFolderId, providerVisible: document.body.innerText.includes('本地测试服务'), importResult };
    })()`);
    if (!ui.providerVisible) fail("服务商保存后未显示");
    const originalSession = state.sessions.find((item) => item.id === ui.sessionId);
    const sameFolderSession = state.sessions.find(
      (item) => item.id === ui.sameFolderId,
    );
    if (
      !sameFolderSession ||
      sameFolderSession.cwd !== originalSession.cwd ||
      sameFolderSession.messages.length ||
      sameFolderSession.runs.length ||
      sameFolderSession.claudeSessionId
    )
      fail("同一文件夹新建对话没有保持空白会话");
    const copyText = "复制中文消息\n```js\nconst ok = true;\n```";
    const copyItem = message(originalSession, "assistant", copyText);
    await win.webContents.executeJavaScript(
      `window.board.invoke('copyMessage', { sessionId: ${JSON.stringify(ui.sessionId)}, messageId: ${JSON.stringify(copyItem.id)} })`,
    );
    const copiedText = await clipboard.readText();
    if (String(copiedText).replace(/\r\n/g, "\n") !== copyText)
      fail("消息复制内容不完整");
    originalSession.messages.pop();
    const originalDialog = dialog.showMessageBox;
    try {
      dialog.showMessageBox = async () => ({ response: 1 });
      await win.webContents.executeJavaScript(
        `window.board.invoke('deleteSession', { id: ${JSON.stringify(ui.sameFolderId)} })`,
      );
    } finally {
      dialog.showMessageBox = originalDialog;
    }
    if (state.sessions.some((item) => item.id === ui.sameFolderId))
      fail("永久删除后会话仍然存在");
    persist();
    await win.loadFile(index);
    const restored = await win.webContents.executeJavaScript(
      `(async () => {
        for (let attempt = 0; attempt < 30; attempt += 1) {
          if (document.body.innerText.includes('保存的中文历史')) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return { history: document.body.innerText.includes('保存的中文历史'), state: await window.board.invoke('state') };
      })()`,
    );
    const loadedState = restored.state;
    if (
      !restored.history ||
      !loadedState.sessions.some((item) => item.id === ui.sessionId)
    )
      fail("历史记录重载失败");
    let skillsUi = null;
    if (process.env.CCB_SMOKE_SKILLS === "1") {
      skillsUi = await win.webContents.executeJavaScript(`(async () => {
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const button = text => [...document.querySelectorAll('button')].find(node => node.textContent.includes(text));
        button('技能商场')?.click(); await wait(120);
        const marketVisible = Boolean(document.querySelector('input[aria-label="搜索 GitHub Skills"]'));
        const officialVisible = document.body.innerText.includes('anthropics/skills');
        button('/plan')?.click(); await wait(40);
        const commandFilled = document.querySelector('textarea[aria-label="消息输入框"]')?.value.startsWith('/plan');
        const textarea = document.querySelector('textarea[aria-label="消息输入框"]');
        const inputSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        inputSetter.call(textarea, '最高权限弹窗鼠标测试');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        const permission = document.querySelector('select[aria-label="权限模式"]');
        const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        selectSetter.call(permission, 'bypassPermissions');
        permission.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(40);
        document.querySelector('button[aria-label="发送消息"]')?.click();
        await wait(80);
        const riskVisible = Boolean(document.querySelector('.risk-panel'));
        const riskCancel = document.querySelector('.risk-panel .secondary');
        const riskRect = riskCancel?.getBoundingClientRect();
        const riskPointerTarget = riskRect
          ? document.elementFromPoint(riskRect.left + riskRect.width / 2, riskRect.top + riskRect.height / 2)
          : null;
        const riskClickable = Boolean(riskCancel && (riskPointerTarget === riskCancel || riskCancel.contains(riskPointerTarget)));
        riskCancel?.click();
        button('设置与环境')?.click(); await wait(120);
        const setupVisible = document.body.innerText.includes('首次使用检查');
        const nodeOptional = document.body.innerText.includes('安装版 cc-board 不依赖 Node.js');
        const ccSwitchOptional = document.body.innerText.includes('CC Switch（可选）');
        return { marketVisible, officialVisible, commandFilled, riskVisible, riskClickable, setupVisible, nodeOptional, ccSwitchOptional };
      })()`);
      if (!skillsUi.marketVisible || !skillsUi.officialVisible)
        fail("技能商场或 GitHub 搜索结果未显示");
      if (!skillsUi.commandFilled) fail("原生指令未填入消息框");
      if (!skillsUi.riskVisible) fail("完全自动模式风险确认区未显示");
      if (!skillsUi.riskClickable) fail("完全自动模式风险确认区被其他界面遮挡");
      if (!skillsUi.setupVisible || !skillsUi.nodeOptional || !skillsUi.ccSwitchOptional)
        fail("首次使用环境检查或可选依赖说明未显示");
    }
    let nativeBridge = null;
    if (process.env.CCB_SMOKE_NATIVE === "1") {
      nativeBridge = await win.webContents.executeJavaScript(`(async () => {
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const started = await window.board.invoke('start', {
          sessionId: ${JSON.stringify(ui.sessionId)},
          prompt: 'Run the local bridge integration test and finish.',
          mode: 'default',
          providerId: 'native',
          model: ${JSON.stringify(process.env.CCB_SMOKE_MODEL || "claude-sonnet-4-6")}
        });
        if (!started?.started) throw Error('原生任务未启动');
        const deadline = Date.now() + 45000;
        let approved = false;
        while (Date.now() < deadline) {
          const allow = [...document.querySelectorAll('button')].find(node => node.textContent.includes('允许本次'));
          if (allow && !approved) { allow.click(); approved = true; }
          const current = await window.board.invoke('state');
          if (!current.running) {
            const selected = current.sessions.find(item => item.id === ${JSON.stringify(ui.sessionId)});
            return { approved, messages: selected?.messages || [] };
          }
          await wait(40);
        }
        throw Error('原生桥接任务超时');
      })()`);
      if (!nativeBridge.approved) fail("审批卡没有在界面中完成允许操作");
      if (!nativeBridge.messages.some((item) => item.role === "assistant"))
        fail("原生桥接未返回助手消息");
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    let png;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        png = await win.webContents.capturePage();
        break;
      } catch (error) {
        if (attempt === 3)
          throw Error(`界面截图失败：${String(error?.message || error)}`);
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    fs.writeFileSync(output.replace(/\.json$/i, ".png"), png.toPNG());
    fs.writeFileSync(
      output,
      JSON.stringify(
        {
          ok: true,
          providerCount: loadedState.providers.length,
          sessionCount: loadedState.sessions.length,
          pinnedSession: Boolean(
            loadedState.sessions.find((item) => item.id === ui.sessionId)?.pinned,
          ),
          keyProtected:
            !process.env.CCB_SMOKE_KEY ||
            !JSON.stringify(loadedState).includes(process.env.CCB_SMOKE_KEY),
          nativeBridge: nativeBridge
            ? {
                approved: nativeBridge.approved,
                messageCount: nativeBridge.messages.length,
              }
            : null,
          importResult: ui.importResult,
          skillsUi,
        },
        null,
        2,
      ),
    );
    app.quit();
  } catch (error) {
    fs.writeFileSync(
      output,
      JSON.stringify(
        { ok: false, error: String(error?.stack || error) },
        null,
        2,
      ),
    );
    app.exit(1);
  }
}
app
  .whenReady()
  .then(async () => {
    const { DatabaseSync } = require("node:sqlite");
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    db = new DatabaseSync(path.join(app.getPath("userData"), "cc-board.db"));
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY, payload TEXT NOT NULL)",
    );
    const row = db.prepare("SELECT payload FROM state WHERE id=1").get();
    state = normalizedState(row ? JSON.parse(row.payload) : null);
    win = new BrowserWindow({
      width: 1280,
      height: 850,
      minWidth: 940,
      minHeight: 640,
      title: "cc-board",
      backgroundColor: "#f8f9fb",
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const index = path.join(__dirname, "..", "dist", "index.html");
    const trustedUrl = pathToFileURL(index).href;
    ipcMain.handle("board", async (event, action, data = {}) => {
      if (
        event.sender !== win.webContents ||
        event.senderFrame !== win.webContents.mainFrame ||
        event.senderFrame.url !== trustedUrl
      )
        throw Error("拒绝不可信界面的请求");
      if (!Object.hasOwn(actions, action)) throw Error("未知操作");
      return actions[action](data);
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    if (process.env.CCB_DEBUG) {
      win.webContents.on("render-process-gone", (_event, details) =>
        console.error("Renderer exited:", details),
      );
      win.on("closed", () => console.error("Main window closed"));
    }
    win.webContents.session.setPermissionRequestHandler(
      (_wc, _permission, callback) => callback(false),
    );
    await win.loadFile(index);
    win.on("close", (event) => {
      if (!run) {
        clearTimeout(persistTimer);
        persist();
        return;
      }
      event.preventDefault();
      if (closePromptOpen) return;
      closePromptOpen = true;
      dialog
        .showMessageBox(win, {
          type: "question",
          message: "停止当前任务并退出？",
          detail: "已经执行的文件操作不会自动撤销。",
          buttons: ["继续运行", "停止并退出"],
          cancelId: 0,
          defaultId: 0,
        })
        .then(async (result) => {
          if (result.response === 1) {
            exitAfterRun = true;
            await stopRun();
          }
        })
        .finally(() => {
          closePromptOpen = false;
        });
    });
    await runDesktopSmoke(index);
  })
  .catch((error) => {
    console.error("cc-board startup failed:", error);
    dialog.showErrorBox("cc-board 启动失败", String(error?.stack || error));
    app.exit(1);
  });
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  if (authProcess) authProcess.kill();
  if (installProcess) installProcess.kill();
});
