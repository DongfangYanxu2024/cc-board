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
  const ccSwitchDir = path.join(root, "work", "cc-switch-" + stamp);
  const claudeConfigDir = path.join(root, "work", "claude-config-" + stamp);
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(ccSwitchDir, { recursive: true });
  fs.mkdirSync(claudeConfigDir, { recursive: true });
  const { DatabaseSync } = require("node:sqlite");
  const fixture = new DatabaseSync(path.join(ccSwitchDir, "cc-switch.db"));
  fixture.exec("CREATE TABLE providers(id TEXT, app_type TEXT, name TEXT, settings_config TEXT)");
  fixture.prepare("INSERT INTO providers VALUES (?, ?, ?, ?)").run(
    "flat-provider",
    "claude",
    "兼容格式服务",
    JSON.stringify({ base_url: "https://flat.example.test", api_key: "fixture-secret", model: "fixture-model" }),
  );
  fixture.close();
  fs.writeFileSync(path.join(ccSwitchDir, "settings.json"), JSON.stringify({ claudeConfigDir }));
  fs.writeFileSync(path.join(claudeConfigDir, "settings.json"), '\uFEFF' + JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://nested.example.test", ANTHROPIC_AUTH_TOKEN: "nested-secret", ANTHROPIC_MODEL: "nested-model" } }));
  const launchEnv = {
    ...process.env,
    CCB_TEST_USER_DATA: userData,
    CCB_SMOKE_OUTPUT: output,
    CCB_SMOKE_CWD: cwd,
    CCB_SMOKE_KEY: "cc-board-smoke-secret",
    CCB_SMOKE_SKILLS: "1",
    CCB_SMOKE_IMPORT: "1",
    CCB_TEST_CC_SWITCH_DIR: ccSwitchDir,
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
  assert.ok(result.providerCount >= 3);
  assert.ok(result.importResult?.imported >= 2);
  assert.equal(result.sessionCount, 1);
  assert.equal(result.pinnedSession, true);
  assert.equal(result.keyProtected, true);
  assert.equal(result.skillsUi?.marketVisible, true);
  assert.equal(result.skillsUi?.officialVisible, true);
  assert.equal(result.skillsUi?.installVisible, true);
  assert.equal(result.skillsUi?.commandFilled, true);
  assert.equal(result.skillsUi?.commandsIntegrated, true);
  assert.equal(result.skillsUi?.modelClickable, true);
  assert.equal(result.skillsUi?.riskVisible, true);
  assert.equal(result.skillsUi?.riskClickable, true);
  assert.equal(result.skillsUi?.setupVisible, true);
  assert.equal(result.skillsUi?.nodeOptional, true);
  assert.equal(result.skillsUi?.ccSwitchOptional, true);
  assert.equal(result.skillsUi?.darkTheme, true);
  assert.equal(result.skillsUi?.skillDarkTheme, true);
  assert.equal(result.visualAudit?.length, 8);
  assert.equal(result.visualAudit?.every((view) => view.issues.length === 0), true);
  for (const view of ["skills", "providers", "settings", "chat", "model-menu", "risk-confirm", "session-menu", "provider-confirm"])
    assert.ok(
      fs.existsSync(output.replace(/\.json$/, `-${view}.png`)),
      `未生成 ${view} 黑色外观截图`,
    );
  assert.ok(fs.existsSync(output.replace(/\.json$/, ".png")), "未生成界面截图");
  console.log(
    "Desktop smoke passed: Electron launch, renderer, IPC, provider state, history reload, graceful exit.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
