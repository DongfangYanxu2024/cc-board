const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const assert = require("node:assert/strict");

async function main() {
  const root = path.resolve(__dirname, "..");
  const stamp = Date.now();
  const userData = path.join(root, "work", "smoke-" + stamp);
  const cwd = path.join(root, "work", "smoke-workspace-" + stamp);
  const output = path.join(root, "work", "desktop-smoke-" + stamp + ".json");
  fs.mkdirSync(cwd, { recursive: true });
  const launchEnv = {
    ...process.env,
    CCB_TEST_USER_DATA: userData,
    CCB_SMOKE_OUTPUT: output,
    CCB_SMOKE_CWD: cwd,
    CCB_SMOKE_KEY: "cc-board-smoke-secret",
    CCB_SMOKE_SKILLS: "1",
  };
  delete launchEnv.ELECTRON_RUN_AS_NODE;
  const executable = path.join(
    root,
    "node_modules",
    "electron",
    "dist",
    "electron.exe",
  );
  const child = spawn(executable, [root], {
    cwd: root,
    env: launchEnv,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill(), 30000);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  clearTimeout(timer);
  assert.ok(
    fs.existsSync(output),
    `桌面测试没有写出结果（退出码 ${code}）\n${stderr}`,
  );
  const result = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(result.ok, true, result.error || stderr);
  if (process.env.CCB_SMOKE_IMPORT === "1") {
    assert.ok(result.providerCount >= 1);
    assert.ok(result.importResult?.imported >= 0);
  } else {
    assert.equal(result.providerCount, 1);
  }
  assert.equal(result.sessionCount, 1);
  assert.equal(result.pinnedSession, true);
  assert.equal(result.keyProtected, true);
  assert.equal(result.skillsUi?.marketVisible, true);
  assert.equal(result.skillsUi?.officialVisible, true);
  assert.equal(result.skillsUi?.commandFilled, true);
  assert.equal(result.skillsUi?.riskVisible, true);
  assert.ok(fs.existsSync(output.replace(/\.json$/, ".png")), "未生成界面截图");
  console.log(
    "Desktop smoke passed: Electron launch, renderer, IPC, provider state, history reload, graceful exit.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
