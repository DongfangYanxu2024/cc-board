const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  safeStorage,
  shell,
  clipboard,
  nativeTheme,
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
  parseJsonConfig,
  extractProviderConfig,
  messagesEndpoint,
  isNewerVersion,
  skillSearchQuery,
  normalizeGitHubRepository,
  isSkillRepository,
  installPlan,
  id,
} = require("./core.cjs");
const exec = promisify(execFile);
if (process.env.CCB_TEST_USER_DATA)
  app.setPath("userData", process.env.CCB_TEST_USER_DATA);
// Software rendering avoids driver crashes on older and virtualized Windows machines.
// Keep native acceleration on macOS so window composition and Retina scrolling remain smooth.
if (process.platform === "win32") app.disableHardwareAcceleration();
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
    settings: {
      ...(source.settings && typeof source.settings === "object"
        ? source.settings
        : {}),
      appearance: ["system", "light", "dark"].includes(source.settings?.appearance)
        ? source.settings.appearance
        : "system",
    },
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
    throw Error("工作台不存在或不可访问，请重新选择");
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
async function validateCli(candidate) {
  if (!candidate || !path.isAbsolute(candidate) || !fs.existsSync(candidate)) return null;
  let command = candidate;
  let prefix = [];
  if (/\.cmd$/i.test(candidate)) {
    const cliScript = path.join(path.dirname(candidate), "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    if (!fs.existsSync(cliScript)) return null;
    const node = await detectExecutable("node", ["--version"], [
      path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"),
    ]);
    if (!node.path) return null;
    command = node.path;
    prefix = [cliScript];
  }
  try {
    const result = await exec(command, [...prefix, "--version"], { windowsHide: true, timeout: 15000 });
    const version = String(result.stdout || result.stderr || "").trim();
    if (!/claude/i.test(version)) return null;
    return { path: command, displayPath: candidate, prefix, version };
  } catch {
    return null;
  }
}
async function findCli() {
  const localAppData = process.env.LOCALAPPDATA || "";
  const appData = process.env.APPDATA || "";
  const candidates = (process.platform === "darwin" ? [
    process.env.CCB_TEST_CLI_PATH,
    state.settings.cliPath,
    path.join(home, ".local", "bin", "claude"),
    path.join(home, ".claude", "local", "claude"),
    path.join(home, ".npm-global", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ] : [
    process.env.CCB_TEST_CLI_PATH,
    state.settings.cliPath,
    path.join(home, ".local", "bin", "claude.exe"),
    path.join(home, ".claude", "local", "claude.exe"),
    localAppData && path.join(localAppData, "Programs", "claude", "claude.exe"),
    localAppData && path.join(localAppData, "Microsoft", "WinGet", "Links", "claude.exe"),
    appData && path.join(appData, "npm", "claude.exe"),
    appData && path.join(appData, "npm", "claude.cmd"),
  ]).filter(Boolean);
  const lookup = process.platform === "win32" ? "where.exe" : "/usr/bin/which";
  try {
    const r = await exec(lookup, ["claude"], {
      windowsHide: true,
      timeout: 5000,
    });
    candidates.push(
      ...r.stdout
        .trim()
        .split(/\r?\n/)
        .filter(Boolean),
    );
  } catch {}
  for (const candidate of [...new Set(candidates.map((item) => path.resolve(item)))]) {
    const verified = await validateCli(candidate);
    if (verified) return verified;
  }
  return null;
}
async function detectExecutable(command, args, candidates = []) {
  const paths = candidates.filter(Boolean);
  const lookup = process.platform === "win32" ? "where.exe" : "/usr/bin/which";
  try {
    const found = await exec(lookup, [command], {
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
          installed: false,
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
  const mac = process.platform === "darwin";
  const [cli, git, node, winget, homebrew] = await Promise.all([
    findCli(),
    detectExecutable("git", ["--version"], mac
      ? ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]
      : [path.join(programFiles, "Git", "cmd", "git.exe")]),
    detectExecutable("node", ["--version"], mac
      ? ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
      : [path.join(programFiles, "nodejs", "node.exe")]),
    detectExecutable("winget", ["--version"], [
      !mac && localAppData
        ? path.join(localAppData, "Microsoft", "WindowsApps", "winget.exe")
        : "",
    ]),
    detectExecutable("brew", ["--version"], mac
      ? ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
      : []),
  ]);
  let version = null,
    error = null,
    auth = null;
  const cliPath = cli?.displayPath || null;
  if (cli) {
    version = cli.version;
    try {
      let status;
      try { status = await exec(cli.path, [...cli.prefix, "auth", "status", "--json"], {
        windowsHide: true,
        timeout: 15000,
      }); } catch { status = await exec(cli.path, [...cli.prefix, "auth", "status"], { windowsHide: true, timeout: 15000 }); }
      const value = parseJsonConfig(status.stdout || status.stderr || "{}");
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
    platform: process.platform,
    arch: process.arch,
    dependencies: {
      git,
      node,
      winget,
      homebrew,
      packageManager: mac ? homebrew : winget,
    },
    ccSwitch: ccSwitchDatabasePaths().some(fs.existsSync),
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
function safeSkillRepository(value) {
  const fullName = String(value || "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName))
    throw Error("Skill 仓库地址无效");
  return fullName;
}
function safeSkillName(value) {
  return (
    String(value || "skill")
      .normalize("NFKC")
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "skill"
  );
}
function collectSkillFolders(root) {
  const found = [];
  const walk = (current, depth = 0) => {
    if (depth > 8 || found.length >= 40) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md"))
      found.push(current);
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        ![".git", "node_modules", "vendor", "dist", "build"].includes(entry.name)
      )
        walk(path.join(current, entry.name), depth + 1);
    }
  };
  walk(root);
  return found;
}
function copySkillFolder(source, target) {
  let files = 0;
  let bytes = 0;
  const allowed = (item) => {
    const stat = fs.lstatSync(item);
    if (stat.isSymbolicLink()) return false;
    if (stat.isFile()) {
      files += 1;
      bytes += stat.size;
      if (files > 200 || bytes > 5 * 1024 * 1024)
        throw Error("单个 Skill 文件过多或体积超过 5 MB");
    }
    return stat.isDirectory() || stat.isFile();
  };
  fs.cpSync(source, target, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: allowed,
  });
}
function validateExtractedArchive(root) {
  let files = 0;
  let bytes = 0;
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      const stat = fs.lstatSync(item);
      if (stat.isSymbolicLink()) throw Error("Skill 仓库不能包含符号链接");
      files += 1;
      if (files > 5000) throw Error("仓库文件数量超过限制");
      if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > 100 * 1024 * 1024) throw Error("仓库解压后超过 100 MB");
      } else if (stat.isDirectory()) visit(item);
    }
  };
  visit(root);
}
async function extractSkillArchive(zip, extracted) {
  if (process.platform === "darwin") {
    fs.mkdirSync(extracted, { recursive: true });
    await exec("/usr/bin/ditto", ["-x", "-k", zip, extracted], {
      timeout: 120000,
    });
  } else {
    await exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Add-Type -AssemblyName System.IO.Compression.FileSystem; $archive = [IO.Compression.ZipFile]::OpenRead($args[0]); try { if ($archive.Entries.Count -gt 5000) { throw '仓库文件数量超过限制' }; $total = ($archive.Entries | Measure-Object -Property Length -Sum).Sum; if ($total -gt 104857600) { throw '仓库解压后超过 100 MB' } } finally { $archive.Dispose() }; Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
        zip,
        extracted,
      ],
      { windowsHide: true, timeout: 120000 },
    );
  }
  validateExtractedArchive(extracted);
}
async function installSkillRepository(data = {}) {
  const fullName = safeSkillRepository(data.fullName);
  const repo = await githubJson(`https://api.github.com/repos/${fullName}`);
  const branch = String(repo.default_branch || "main");
  if (!/^[A-Za-z0-9._\/-]+$/.test(branch)) throw Error("仓库默认分支名称无效");
  const branchPath = branch.split("/").map(encodeURIComponent).join("/");
  let response;
  try {
    response = await fetch(
      `https://codeload.github.com/${fullName}/zip/refs/heads/${branchPath}`,
      {
        headers: { "user-agent": `cc-board/${app.getVersion()}` },
        signal: AbortSignal.timeout(60000),
      },
    );
  } catch {
    throw Error("无法下载 Skill 仓库，请检查网络后重试");
  }
  if (!response.ok) throw Error(`Skill 仓库下载失败：HTTP ${response.status}`);
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > 50 * 1024 * 1024)
    throw Error("仓库压缩包超过 50 MB，已停止安装");
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length > 50 * 1024 * 1024)
    throw Error("仓库压缩包超过 50 MB，已停止安装");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cc-board-skill-"));
  const zip = path.join(temporary, "repository.zip");
  const extracted = path.join(temporary, "extracted");
  try {
    fs.writeFileSync(zip, archive);
    await extractSkillArchive(zip, extracted);
    const roots = fs
      .readdirSync(extracted, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(extracted, entry.name));
    if (roots.length !== 1) throw Error("无法识别仓库内容");
    const folders = collectSkillFolders(roots[0]);
    if (!folders.length) throw Error("仓库中没有找到 SKILL.md");
    const [owner, repository] = fullName.split("/");
    const skillsRoot = path.join(home, ".claude", "skills");
    fs.mkdirSync(skillsRoot, { recursive: true });
    let installed = 0;
    let skipped = 0;
    for (const folder of folders) {
      const relativeName = path.relative(roots[0], folder).split(path.sep).join("-");
      const name = [
        "ccboard",
        safeSkillName(owner),
        safeSkillName(repository),
        safeSkillName(relativeName || path.basename(folder)),
      ].join("-");
      const target = path.join(skillsRoot, name);
      if (fs.existsSync(target)) {
        skipped += 1;
        continue;
      }
      const staging = path.join(skillsRoot, `.cc-board-install-${id()}`);
      try {
        copySkillFolder(folder, staging);
        fs.writeFileSync(
          path.join(staging, ".cc-board-source.json"),
          JSON.stringify(
            { repository: fullName, branch, installedAt: Date.now() },
            null,
            2,
          ),
        );
        fs.renameSync(staging, target);
      } finally {
        if (fs.existsSync(staging))
          fs.rmSync(staging, { recursive: true, force: true });
      }
      installed += 1;
    }
    state.settings.installedSkillRepos ||= {};
    state.settings.installedSkillRepos[fullName] = {
      installedAt: Date.now(),
      installed,
      skipped,
    };
    update();
    persist();
    return { installed, skipped, total: folders.length, fullName };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
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
function uniquePaths(values) {
  return [...new Set(values.filter(Boolean).map((value) => path.resolve(value)))];
}
function ccSwitchRoots() {
  if (process.env.CCB_TEST_CC_SWITCH_DIR)
    return uniquePaths([process.env.CCB_TEST_CC_SWITCH_DIR]);
  const roots = [process.env.CCB_TEST_CC_SWITCH_DIR, path.join(home, ".cc-switch")];
  if (process.env.HOME) roots.push(path.join(process.env.HOME, ".cc-switch"));
  const pathFiles = [
    path.join(home, ".cc-switch", "app_paths.json"),
    path.join(home, "Library", "Application Support", "com.ccswitch.desktop", "app_paths.json"),
    path.join(home, "Library", "Application Support", "CC Switch", "app_paths.json"),
    path.join(home, "Library", "Application Support", "cc-switch", "app_paths.json"),
    process.env.APPDATA && path.join(process.env.APPDATA, "com.ccswitch.desktop", "app_paths.json"),
    process.env.APPDATA && path.join(process.env.APPDATA, "CC Switch", "app_paths.json"),
    process.env.APPDATA && path.join(process.env.APPDATA, "cc-switch", "app_paths.json"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "com.ccswitch.desktop", "app_paths.json"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "CC Switch", "app_paths.json"),
  ].filter(Boolean);
  for (const location of pathFiles) {
    try {
      const paths = parseJsonConfig(fs.readFileSync(location, "utf8"));
      roots.push(paths.appConfigDir, paths.app_config_dir, paths.appConfigDirOverride);
    } catch {}
  }
  for (const root of [...roots].filter(Boolean)) {
    try {
      const settings = parseJsonConfig(fs.readFileSync(path.join(root, "settings.json"), "utf8"));
      roots.push(settings.appConfigDir, settings.app_config_dir, settings.appConfigDirOverride);
    } catch {}
  }
  return uniquePaths(roots);
}
function ccSwitchDatabasePaths() {
  return uniquePaths([
    process.env.CCB_TEST_CC_SWITCH_DB,
    ...ccSwitchRoots().map((root) => path.join(root, "cc-switch.db")),
  ]);
}
function claudeSettingsPaths() {
  const dirs = [process.env.CLAUDE_CONFIG_DIR, process.env.CCB_TEST_CLAUDE_CONFIG_DIR];
  for (const root of ccSwitchRoots()) {
    try {
      const settings = parseJsonConfig(fs.readFileSync(path.join(root, "settings.json"), "utf8"));
      dirs.push(settings.claudeConfigDir, settings.claude_config_dir);
    } catch {}
  }
  if (!process.env.CCB_TEST_CC_SWITCH_DIR && !process.env.CCB_TEST_CLAUDE_CONFIG_DIR)
    dirs.push(path.join(home, ".claude"));
  return uniquePaths(dirs).flatMap((dir) => [path.join(dir, "settings.json"), path.join(dir, "claude.json")]);
}
function extractProvider(name, config, sourceId) {
  const extracted = extractProviderConfig(config);
  const baseUrl = extracted.baseUrl;
  if (!baseUrl) return null;
  return {
    id: sourceId,
    name,
    baseUrl: safeUrl(baseUrl),
    model: extracted.model,
    authType: extracted.authType,
    secret: extracted.secret ? encrypt(extracted.secret) : "",
    extraEnv: extracted.extraEnv,
    source: "CC Switch / 原生配置",
  };
}
async function importProviders() {
  const { DatabaseSync } = require("node:sqlite");
  let imported = 0,
    skipped = 0;
  const candidates = [];
  const details = [];
  for (const file of ccSwitchDatabasePaths().filter(fs.existsSync)) {
    let source;
    try {
      source = new DatabaseSync(file, { readOnly: true });
      source.exec("PRAGMA busy_timeout=3000");
      const columns = source.prepare("PRAGMA table_info(providers)").all().map((column) => column.name);
      const pick = (...names) => names.find((name) => columns.includes(name));
      const idColumn = pick("id", "provider_id");
      const nameColumn = pick("name", "provider_name");
      const configColumn = pick("settings_config", "settingsConfig", "config");
      const appColumn = pick("app_type", "appType");
      if (!idColumn || !configColumn) throw Error("providers 表结构不受支持");
      const selected = [`${idColumn} AS id`, `${nameColumn || idColumn} AS name`, `${configColumn} AS settings_config`];
      const sql = `SELECT ${selected.join(", ")} FROM providers${appColumn ? ` WHERE lower(${appColumn}) = 'claude'` : ""}`;
      let found = 0;
      for (const row of source.prepare(sql).all()) {
        try {
          const provider = extractProvider(row.name, row.settings_config, "ccswitch-" + row.id);
          if (provider) { candidates.push(provider); found += 1; }
          else skipped += 1;
        } catch (error) {
          skipped += 1;
          details.push(`${row.name || row.id}：${error.message}`);
        }
      }
      details.push(`CC Switch：读取 ${found} 项（${file}）`);
    } catch (error) {
      skipped += 1;
      details.push(`CC Switch 数据库读取失败：${redact(error.message)}`);
    } finally {
      source?.close();
    }
  }
  for (const configPath of claudeSettingsPaths().filter(fs.existsSync)) {
    try {
      const provider = extractProvider("当前 Claude Code 配置", fs.readFileSync(configPath, "utf8"), "claude-current-" + Buffer.from(configPath).toString("hex").slice(-16));
      if (provider) {
        candidates.push(provider);
        details.push(`Claude 配置：已读取 ${configPath}`);
      } else {
        details.push(`Claude 配置未包含第三方 API 地址：${configPath}`);
      }
    } catch (error) {
      skipped += 1;
      details.push(`Claude 配置读取失败：${redact(error.message)}`);
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
  return { imported, skipped, details };
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
    throw Error("工作台不存在，请重新选择");
  const cli = await findCli();
  if (!cli)
    throw Error("未检测到原生 Claude Code。请在设置中安装或选择 Claude Code 程序。");
  const mode = data.mode;
  if (!MODES.includes(mode)) throw Error("权限模式无效");
  if (mode === "bypassPermissions") {
    if (data.bypassConfirmed !== true)
      throw Error("完全自动模式需要在风险确认区中明确确认");
  }
  const profile = state.providers.find((p) => p.id === data.providerId);
  if (data.providerId !== "native" && !profile) throw Error("服务商不存在");
  if (s.claudeSessionId && s.providerId && s.providerId !== data.providerId) {
    if (data.providerSwitchConfirmed !== true)
      return {
        needsProviderConfirmation: true,
        previousProviderId: s.providerId,
        nextProviderId: data.providerId,
      };
  }
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
    if (process.platform === "win32" && !env.CLAUDE_CODE_GIT_BASH_PATH) {
      const git = await detectExecutable("git", ["--version"], [
        path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "cmd", "git.exe"),
      ]);
      if (git.path) {
        const bash = path.resolve(path.dirname(git.path), "..", "bin", "bash.exe");
        if (fs.existsSync(bash)) env.CLAUDE_CODE_GIT_BASH_PATH = bash;
      }
    }
    const child = spawn(cli.path, [...cli.prefix, ...args], {
      cwd: s.cwd,
      env,
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
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
    if (process.platform === "win32") {
      try {
        await exec(
          "taskkill.exe",
          ["/PID", String(current.child.pid), "/T", "/F"],
          { windowsHide: true, timeout: 10000 },
        );
      } catch {
        current.child.kill();
      }
    } else {
      try {
        process.kill(-current.child.pid, "SIGTERM");
      } catch {
        current.child.kill("SIGTERM");
      }
      const child = current.child;
      setTimeout(() => {
        if (child.exitCode !== null) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, 3000).unref();
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
  const plan = installPlan(target, {
    platform: current.platform,
    packageManagerPath: current.dependencies.packageManager?.path || "",
  });
  if (!plan.command) return { manual: true, url: plan.manualUrl };
  const names = {
    claude: "Claude Code",
    git: process.platform === "win32" ? "Git for Windows" : "Git",
    node: "Node.js LTS",
  };
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
    const child = spawn(cli.path, [...cli.prefix, "auth", "login"], {
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
      title: "选择工作台",
      buttonLabel: "选择工作台",
      properties: ["openDirectory", "createDirectory"],
    });
    return r.canceled ? null : r.filePaths[0];
  },
  pickCli: async () => {
    const options = {
      title: "选择 Claude Code 程序",
      buttonLabel: "验证并连接",
      properties: ["openFile"],
    };
    if (process.platform === "win32")
      options.filters = [{ name: "Claude Code", extensions: ["exe", "cmd"] }];
    const r = await dialog.showOpenDialog(win, options);
    if (!r.canceled) {
      const verified = await validateCli(r.filePaths[0]);
      if (!verified) throw Error("所选文件不是可正常运行的 Claude Code，请重新选择");
      state.settings.cliPath = verified.displayPath;
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
    if (data.confirmed !== true) return { needsConfirmation: true };
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
    if (data.confirmed !== true) return { needsConfirmation: true };
    provider.secret = "";
    update();
    return { cleared: true };
  },
  deleteProvider: async (data) => {
    if (run) throw Error("请等待当前任务结束后再删除服务商");
    const index = state.providers.findIndex((item) => item.id === data.id);
    if (index < 0) throw Error("服务商不存在");
    if (data.confirmed !== true) return { needsConfirmation: true };
    state.providers.splice(index, 1);
    update();
    return { deleted: true };
  },
  importProviders,
  setAppearance: (data) => {
    const appearance = String(data.appearance || "");
    if (!["system", "light", "dark"].includes(appearance))
      throw Error("外观设置无效");
    state.settings.appearance = appearance;
    nativeTheme.themeSource = appearance;
    update();
    persist();
    return { appearance };
  },
  testProvider: async (data) => {
    const p = state.providers.find((p) => p.id === data.id);
    if (!p) throw Error("请先保存服务商");
    if (!p.model) throw Error("请填写实际模型 ID 后再测试");
    if (data.confirmed !== true) return { needsConfirmation: true };
    const headers = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (p.secret) {
      if (p.authType === "apiKey") headers["x-api-key"] = decrypt(p.secret);
      else headers.authorization = "Bearer " + decrypt(p.secret);
    }
    const endpoint = messagesEndpoint(p.baseUrl);
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
    const plan = installPlan(String(data.target || ""), {
      platform: process.platform,
    });
    return shell.openExternal(plan.manualUrl);
  },
  authLogin,
  checkUpdate,
  searchSkills,
  installSkillRepository,
  confirmExit: async () => {
    exitAfterRun = true;
    if (run) await stopRun();
    else app.quit();
    return { closing: true };
  },
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
    await win.webContents.executeJavaScript(
      `window.board.invoke('deleteSession', { id: ${JSON.stringify(ui.sameFolderId)}, confirmed: true })`,
    );
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
        const until = async predicate => {
          for (let attempt = 0; attempt < 40; attempt += 1) {
            if (predicate()) return true;
            await wait(100);
          }
          return false;
        };
        const button = text => [...document.querySelectorAll('button')].find(node => node.textContent.includes(text));
        button('技能商场')?.click();
        await until(() => Boolean(document.querySelector('input[aria-label="搜索 GitHub Skills"]')));
        await until(() => document.body.innerText.includes('anthropics/skills'));
        const marketVisible = Boolean(document.querySelector('input[aria-label="搜索 GitHub Skills"]'));
        const officialVisible = document.body.innerText.includes('anthropics/skills');
        const installVisible = Boolean([...document.querySelectorAll('button')].find(node => node.textContent.includes('一键安装')));
        button('/plan')?.click(); await wait(40);
        const commandFilled = document.querySelector('textarea[aria-label="消息输入框"]')?.value.startsWith('/plan');
        document.querySelector('button[aria-label="原生指令"]')?.click(); await wait(30);
        const commandsIntegrated = Boolean(document.querySelector('.composer-options'));
        document.querySelector('button[aria-label="原生指令"]')?.click();
        document.querySelector('button[aria-label="模型"]')?.click(); await wait(30);
        const modelChoice = [...document.querySelectorAll('.composer-options button')].find(node => node.textContent.trim() === 'opus');
        const modelRect = modelChoice?.getBoundingClientRect();
        const modelPointerTarget = modelRect
          ? document.elementFromPoint(modelRect.left + modelRect.width / 2, modelRect.top + modelRect.height / 2)
          : null;
        const modelClickable = Boolean(modelChoice && (modelPointerTarget === modelChoice || modelChoice.contains(modelPointerTarget)));
        modelChoice?.click();
        const textarea = document.querySelector('textarea[aria-label="消息输入框"]');
        const inputSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        inputSetter.call(textarea, '最高权限弹窗鼠标测试');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('button[aria-label="权限模式"]')?.click(); await wait(30);
        [...document.querySelectorAll('.composer-options button')].find(node => node.textContent.trim() === '完全自动')?.click();
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
        button('设置与环境')?.click();
        await until(() => document.body.innerText.includes('首次使用检查'));
        const setupVisible = document.body.innerText.includes('首次使用检查');
        const nodeOptional = document.body.innerText.includes('安装版 cc-board 不依赖 Node.js');
        const ccSwitchOptional = document.body.innerText.includes('CC Switch（可选）');
        const workbenchWording = document.querySelector('.new-chat')?.title === '选择工作台并新建对话';
        const darkButton = [...document.querySelectorAll('.appearance-options button')].find(node => node.textContent.includes('黑色'));
        darkButton?.click();
        await until(() => document.documentElement.dataset.theme === 'dark' && darkButton?.getAttribute('aria-pressed') === 'true');
        const color = value => {
          const source = value.startsWith('color(') ? value.slice(value.indexOf(' ') + 1) : value;
          const channels = source.match(/[\\d.]+/g)?.map(Number) || [];
          if (value.startsWith('color(') && channels.length >= 3)
            return channels.slice(0, 3).map(channel => Math.round(channel * 255));
          return channels.slice(0, 3).map(Math.round);
        };
        const sameColor = (value, expected) => {
          const actual = color(value);
          return actual.length === 3 && actual.every((channel, index) => Math.abs(channel - expected[index]) <= 1);
        };
        const darkSurface = getComputedStyle(document.querySelector('.settings-card')).backgroundColor;
        const darkTheme = document.documentElement.dataset.theme === 'dark' && darkButton?.getAttribute('aria-pressed') === 'true' && sameColor(darkSurface, [32, 38, 34]);
        button('技能商场')?.click();
        await until(() => Boolean(document.querySelector('.skill-card')));
        const marketSurface = getComputedStyle(document.querySelector('.skills-section')).backgroundColor;
        const skillSurface = getComputedStyle(document.querySelector('.skill-card')).backgroundColor;
        const skillDarkTheme = sameColor(marketSurface, [32, 38, 34]) && sameColor(skillSurface, [36, 43, 38]);
        return { marketVisible, officialVisible, installVisible, commandFilled, commandsIntegrated, modelClickable, riskVisible, riskClickable, setupVisible, nodeOptional, ccSwitchOptional, workbenchWording, darkTheme, darkSurface, skillDarkTheme, marketSurface, skillSurface };
      })()`);
      if (!skillsUi.marketVisible || !skillsUi.officialVisible)
        fail("技能商场或 GitHub 搜索结果未显示");
      if (!skillsUi.installVisible) fail("Skill 卡片未显示一键安装按钮");
      if (!skillsUi.commandFilled) fail("原生指令未填入消息框");
      if (!skillsUi.commandsIntegrated) fail("输入栏未显示原生指令入口");
      if (!skillsUi.modelClickable) fail("模型选择区被其他界面遮挡");
      if (!skillsUi.riskVisible) fail("完全自动模式风险确认区未显示");
      if (!skillsUi.riskClickable) fail("完全自动模式风险确认区被其他界面遮挡");
      if (!skillsUi.setupVisible || !skillsUi.nodeOptional || !skillsUi.ccSwitchOptional)
        fail("首次使用环境检查或可选依赖说明未显示");
      if (!skillsUi.workbenchWording) fail("新建对话仍未使用工作台文案");
      if (!skillsUi.darkTheme) fail("黑色外观未正确应用或保存");
      if (!skillsUi.skillDarkTheme) fail("黑色外观下 Skill 商店卡片颜色不正确");
    }
    let nativeBridge = null;
    const visualAudit = [];
    if (process.env.CCB_SMOKE_SKILLS === "1") {
      const views = [
        ["skills", "技能商场", ""],
        ["providers", "模型与服务商", ""],
        ["settings", "设置与环境", ""],
        ["chat", null, ""],
        ["model-menu", null, "model"],
        ["risk-confirm", null, "risk"],
        ["session-menu", null, "session"],
        ["provider-confirm", "模型与服务商", "providerConfirm"],
      ];
      for (const [name, navigation, interaction] of views) {
        const audit = await win.webContents.executeJavaScript(`(async () => {
          const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
          document.querySelector('.risk-panel .secondary')?.click();
          document.querySelector('.inline-confirm .secondary')?.click();
          if (document.querySelector('.dropdown')) document.querySelector('button[aria-label="会话操作"]')?.click();
          if (${JSON.stringify(navigation)})
            [...document.querySelectorAll('button')].find(node => node.textContent.includes(${JSON.stringify(navigation)}))?.click();
          else document.querySelector('.history-item')?.click();
          await wait(100);
          const interaction = ${JSON.stringify(interaction)};
          if (interaction === 'model') document.querySelector('button[aria-label="模型"]')?.click();
          if (interaction === 'session') document.querySelector('button[aria-label="会话操作"]')?.click();
          if (interaction === 'providerConfirm') [...document.querySelectorAll('.provider-card .text-button')].find(node => node.textContent.trim() === '测试')?.click();
          if (interaction === 'risk') {
            const textarea = document.querySelector('textarea[aria-label="消息输入框"]');
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
            setter.call(textarea, '黑暗模式风险提示测试');
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('button[aria-label="权限模式"]')?.click();
            await wait(30);
            [...document.querySelectorAll('.composer-options button')].find(node => node.textContent.trim() === '完全自动')?.click();
            await wait(30);
            document.querySelector('button[aria-label="发送消息"]')?.click();
          }
          await wait(80);
          const parse = value => {
            const source = value.startsWith('color(') ? value.slice(value.indexOf(' ') + 1) : value;
            const match = source.match(/[\\d.]+/g)?.map(Number) || [0, 0, 0, 1];
            if (value.startsWith('color('))
              return [match[0] * 255, match[1] * 255, match[2] * 255, match[3] ?? 1];
            return [match[0], match[1], match[2], match[3] ?? 1];
          };
          const luminance = rgb => {
            const channels = rgb.slice(0, 3).map(value => {
              const normalized = value / 255;
              return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
          };
          const background = node => {
            for (let current = node; current; current = current.parentElement) {
              const value = parse(getComputedStyle(current).backgroundColor);
              if (value[3] > 0.95) return value;
            }
            return [18, 22, 19, 1];
          };
          const issues = [...document.querySelectorAll('button, label, p, small, span, strong, code, h1, h2, h3')]
            .filter(node => {
              const rect = node.getBoundingClientRect();
              const style = getComputedStyle(node);
              return rect.width && rect.height && style.visibility !== 'hidden' && style.display !== 'none' && node.textContent.trim();
            })
            .map(node => {
              const style = getComputedStyle(node);
              const foreground = parse(style.color);
              const bg = background(node);
              const light = luminance(foreground), dark = luminance(bg);
              const ratio = (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
              const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
              return { tag: node.tagName, className: node.className?.toString().slice(0, 80), text: node.textContent.trim().replace(/\\s+/g, ' ').slice(0, 60), ratio: Number(ratio.toFixed(2)), minimum: large ? 3 : 4.5, color: foreground.slice(0, 3), background: bg.slice(0, 3) };
            })
            .filter(item => item.ratio < item.minimum)
            .slice(0, 20);
          return { name: ${JSON.stringify(name)}, issues };
        })()`);
        visualAudit.push(audit);
        const shot = await win.webContents.capturePage();
        fs.writeFileSync(output.replace(/\.json$/i, `-${name}.png`), shot.toPNG());
      }
      if (visualAudit.some((view) => view.issues.length))
        fail("黑色外观存在严重低对比度元素：" + JSON.stringify(visualAudit));
    }
    if (process.env.CCB_SMOKE_NATIVE === "1") {
      nativeBridge = await win.webContents.executeJavaScript(`(async () => {
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        document.querySelector('.history-item')?.click();
        await wait(80);
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
        throw Error('原生桥接任务超时：' + JSON.stringify({
          approvalCount: document.querySelectorAll('.approval').length,
          chatVisible: Boolean(document.querySelector('.composer-area')),
          selectedHistory: document.querySelector('.history-item.selected')?.textContent,
          status: document.querySelector('.working')?.textContent,
          notice: document.querySelector('.toast')?.textContent,
        }));
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
          visualAudit,
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
    nativeTheme.themeSource = state.settings.appearance;
    win = new BrowserWindow({
      width: 1280,
      height: 850,
      minWidth: 940,
      minHeight: 640,
      title: "cc-board",
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#151816" : "#f8f9fb",
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
      emit("exitRequested", {});
      win.show();
      win.focus();
      setTimeout(() => {
        closePromptOpen = false;
      }, 500);
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
