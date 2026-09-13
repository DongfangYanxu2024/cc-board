const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");
const path = require("node:path");
test("MCP handshake and approval round trip preserve exact input", async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer test-token");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const value = JSON.parse(body);
      res.end(JSON.stringify({ behavior: "allow", updatedInput: value.input }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const child = spawn(
    process.execPath,
    [path.join(__dirname, "../electron/permission-server.cjs")],
    {
      env: {
        ...process.env,
        CCB_TOKEN: "test-token",
        CCB_PORT: String(server.address().port),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  try {
    const outputs = [];
    let buffer = "";
    child.stdout.on("data", (c) => {
      buffer += c;
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        outputs.push(JSON.parse(buffer.slice(0, i)));
        buffer = buffer.slice(i + 1);
      }
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      }) + "\n",
    );
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "approve",
          arguments: { tool_name: "Bash", input: { command: "echo hello" } },
        },
      }) + "\n",
    );
    const deadline = Date.now() + 5000;
    while (outputs.length < 2 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(outputs.length, 2);
    assert.equal(outputs[0].result.serverInfo.name, "cc-board-permissions");
    assert.deepEqual(JSON.parse(outputs[1].result.content[0].text), {
      behavior: "allow",
      updatedInput: { command: "echo hello" },
    });
  } finally {
    child.kill();
    server.close();
    server.closeAllConnections();
  }
});
