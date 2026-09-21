// Full local integration: renderer -> IPC -> native Claude Code -> permission card -> file write.
// The model endpoint is simulated locally; this never uses a paid account.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const { nativeClaudePath, electronPath } = require("./platform-paths.cjs");

function gitBash() {
  return [
    process.env.CLAUDE_CODE_GIT_BASH_PATH,
    "D:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\bin\\bash.exe",
  ].find((candidate) => candidate && fs.existsSync(candidate));
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const stamp = Date.now();
  const testRoot = path.join(root, "work", "desktop-native-" + stamp);
  const workspace = path.join(testRoot, "workspace");
  const userData = path.join(testRoot, "user-data");
  const claudeConfig = path.join(testRoot, "claude-config");
  const output = path.join(testRoot, "result.json");
  const proof = path.join(workspace, "bridge-proof.txt");
  fs.mkdirSync(workspace, { recursive: true });
  let requests = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.url.includes("count_tokens")) {
        res.setHeader("content-type", "application/json");
        return res.end('{"input_tokens":10}');
      }
      if (!req.url.includes("/messages")) {
        res.statusCode = 404;
        return res.end("{}");
      }
      assert.equal(req.headers["x-api-key"], "local-test-key");
      requests++;
      const payload = JSON.parse(body);
      const hasResult = payload.messages?.some(
        (message) =>
          Array.isArray(message.content) &&
          message.content.some((content) => content.type === "tool_result"),
      );
      const block = hasResult
        ? { type: "text", text: "界面与原生桥接测试完成。" }
        : {
            type: "tool_use",
            id: "toolu_desktop_" + requests,
            name: "Write",
            input: {
              file_path: proof,
              content: "cc-board desktop native bridge verified\n",
            },
          };
      const result = {
        id: "msg_desktop_" + requests,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [block],
        stop_reason: hasResult ? "end_turn" : "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 8 },
      };
      if (!payload.stream) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify(result));
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const event = (type, value) =>
        res.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`,
        );
      event("message_start", {
        message: {
          ...result,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 12, output_tokens: 0 },
        },
      });
      event("content_block_start", {
        index: 0,
        content_block:
          block.type === "text"
            ? { type: "text", text: "" }
            : { ...block, input: {} },
      });
      event("content_block_delta", {
        index: 0,
        delta:
          block.type === "text"
            ? { type: "text_delta", text: block.text }
            : {
                type: "input_json_delta",
                partial_json: JSON.stringify(block.input),
              },
      });
      event("content_block_stop", { index: 0 });
      event("message_delta", {
        delta: { stop_reason: result.stop_reason, stop_sequence: null },
        usage: { output_tokens: 8 },
      });
      event("message_stop", {});
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const cli = nativeClaudePath(root);
  assert.ok(
    fs.existsSync(cli),
    "Run the native Claude Code test dependency install first",
  );
  const launchEnv = {
    ...process.env,
    CCB_TEST_USER_DATA: userData,
    CCB_SMOKE_OUTPUT: output,
    CCB_SMOKE_CWD: workspace,
    CCB_SMOKE_NATIVE: "1",
    CCB_SMOKE_MODEL: "claude-sonnet-4-6",
    CCB_TEST_CLI_PATH: cli,
    CLAUDE_CONFIG_DIR: claudeConfig,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    ANTHROPIC_API_KEY: "local-test-key",
    ANTHROPIC_AUTH_TOKEN: "",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
  };
  const bash = gitBash();
  if (bash) launchEnv.CLAUDE_CODE_GIT_BASH_PATH = bash;
  delete launchEnv.ELECTRON_RUN_AS_NODE;
  const packaged = process.env.CCB_PACKAGED_EXE;
  const electron = packaged
    ? path.resolve(packaged)
    : electronPath();
  const child = spawn(electron, packaged ? [] : [root], {
    cwd: root,
    env: launchEnv,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill(), 60000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.ok(fs.existsSync(output), `No result (exit ${code})\n${stderr}`);
    const result = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(result.ok, true, result.error || stderr);
    assert.equal(result.nativeBridge?.approved, true);
    assert.equal(
      fs.readFileSync(proof, "utf8"),
      "cc-board desktop native bridge verified\n",
    );
    assert.ok(requests >= 2);
    console.log(
      `Desktop native integration passed: ${requests} local API requests, UI approval, real file write, graceful exit.`,
    );
  } finally {
    clearTimeout(timer);
    child.kill();
    server.close();
    server.closeAllConnections();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
