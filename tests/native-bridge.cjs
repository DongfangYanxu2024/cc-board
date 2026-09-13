// Integration test: real unmodified Claude Code executable, local simulated model API.
// No paid model requests or personal workspace data are used.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const { lineDecoder, argumentsFor } = require("../electron/core.cjs");
const root = path.resolve(__dirname, "..");
async function main() {
  const cwd = path.join(root, "work", "native-test-" + Date.now());
  fs.mkdirSync(cwd, { recursive: true });
  const output = path.join(cwd, "bridge-proof.txt");
  let approvals = 0,
    requests = 0;
  const approval = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const a = JSON.parse(b);
      approvals++;
      res.end(JSON.stringify({ behavior: "allow", updatedInput: a.input }));
    });
  });
  const model = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      if (req.url.includes("count_tokens")) {
        res.setHeader("content-type", "application/json");
        return res.end('{"input_tokens":10}');
      }
      if (!req.url.includes("/messages")) {
        res.setHeader("content-type", "application/json");
        return res.end("{}");
      }
      requests++;
      const body = JSON.parse(b);
      const hasResult = body.messages?.some(
        (m) =>
          Array.isArray(m.content) &&
          m.content.some((c) => c.type === "tool_result"),
      );
      const block = hasResult
        ? { type: "text", text: "桥接测试完成。" }
        : {
            type: "tool_use",
            id: "toolu_test_" + requests,
            name: "Write",
            input: {
              file_path: output,
              content: "cc-board native bridge verified\n",
            },
          };
      const result = {
        id: "msg_test_" + requests,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [block],
        stop_reason: hasResult ? "end_turn" : "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 8 },
      };
      if (!body.stream) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify(result));
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const event = (type, value) =>
        res.write(
          "event: " +
            type +
            "\ndata: " +
            JSON.stringify({ type, ...value }) +
            "\n\n",
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
  await Promise.all([
    new Promise((r) => model.listen(0, "127.0.0.1", r)),
    new Promise((r) => approval.listen(0, "127.0.0.1", r)),
  ]);
  const mcp = {
    mcpServers: {
      ccboard: {
        command: process.execPath,
        args: [path.join(root, "electron", "permission-server.cjs")],
        env: {
          CCB_PORT: String(approval.address().port),
          CCB_TOKEN: "integration-test",
        },
      },
    },
  };
  const cli = path.join(
    root,
    "work/native-cli/node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe",
  );
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: path.join(cwd, "config"),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.address().port}`,
    ANTHROPIC_API_KEY: "local-test-key",
    ANTHROPIC_AUTH_TOKEN: "",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_GIT_BASH_PATH: "D:\\Program Files\\Git\\bin\\bash.exe",
  };
  delete env.CLAUDECODE;
  delete env.ELECTRON_RUN_AS_NODE;
  const args = argumentsFor({
    mode: "default",
    model: "claude-sonnet-4-6",
    mcp,
  });
  args.push("--setting-sources", "", "--strict-mcp-config", "--max-turns", "3");
  const child = spawn(cli, args, {
    cwd,
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  const events = [];
  const decoder = lineDecoder((e) => events.push(e));
  child.stdout.on("data", (c) => decoder.write(c));
  child.stderr.on("data", (c) => (stderr += c));
  child.stdin.end(
    "Write the bridge proof file requested by the test, then finish.",
  );
  const timer = setTimeout(() => {
    child.kill();
  }, 90000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.on("close", resolve);
      child.on("error", reject);
    });
    decoder.end();
    fs.writeFileSync(
      path.join(cwd, "events.json"),
      JSON.stringify({ code, approvals, requests, events, stderr }, null, 2),
    );
    assert.equal(code, 0, stderr);
    assert.ok(approvals > 0, "Native permission callback must be invoked");
    assert.equal(
      fs.readFileSync(output, "utf8"),
      "cc-board native bridge verified\n",
    );
    assert.ok(events.some((e) => e.type === "result" && !e.is_error));
    console.log(
      `Native CLI integration passed: ${requests} local API requests, ${approvals} approvals, real file write, final result.`,
    );
  } finally {
    clearTimeout(timer);
    child.kill();
    model.close();
    model.closeAllConnections();
    approval.close();
    approval.closeAllConnections();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
