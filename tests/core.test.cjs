const test = require("node:test");
const assert = require("node:assert/strict");
const {
  lineDecoder,
  argumentsFor,
  normalize,
  providerEnv,
  isNewerVersion,
  skillSearchQuery,
  normalizeGitHubRepository,
  isSkillRepository,
  installPlan,
  parseJsonConfig,
  extractProviderConfig,
  messagesEndpoint,
} = require("../electron/core.cjs");

test("provider import accepts current, nested, flat, and BOM-prefixed configurations", () => {
  assert.deepEqual(extractProviderConfig('\uFEFF{"env":{"ANTHROPIC_BASE_URL":"https://one.test/v1","ANTHROPIC_API_KEY":"key","ANTHROPIC_MODEL":"m1"}}'), {
    baseUrl: "https://one.test/v1",
    secret: "key",
    authType: "apiKey",
    model: "m1",
    extraEnv: {},
  });
  assert.deepEqual(extractProviderConfig({ auth: { baseUrl: "https://two.test", token: "tok" }, settings: { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet-x" } } }), {
    baseUrl: "https://two.test",
    secret: "tok",
    authType: "token",
    model: "",
    extraEnv: { ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet-x" },
  });
  assert.equal(extractProviderConfig({ base_url: "https://three.test", api_key: "flat" }).secret, "flat");
  assert.throws(() => parseJsonConfig("[]"));
});

test("provider test endpoint does not duplicate a complete messages path", () => {
  assert.equal(messagesEndpoint("https://api.test/v1"), "https://api.test/v1/messages");
  assert.equal(messagesEndpoint("https://api.test/v1/messages"), "https://api.test/v1/messages");
  assert.equal(messagesEndpoint("https://api.test/custom"), "https://api.test/custom/v1/messages");
});

test("version comparison accepts release tags and ignores older releases", () => {
  assert.equal(isNewerVersion("v0.1.1", "0.1.0"), true);
  assert.equal(isNewerVersion("0.2.0", "0.1.9"), true);
  assert.equal(isNewerVersion("v0.1.0", "0.1.0"), false);
  assert.equal(isNewerVersion("v0.0.9", "0.1.0"), false);
  assert.equal(isNewerVersion("latest", "0.1.0"), false);
});
test("skill marketplace search keeps user text as keywords and enforces star presets", () => {
  assert.equal(
    skillSearchQuery("React:>0 / hooks", 1000),
    'React 0 hooks "claude skills" in:name,description,readme stars:>=1000',
  );
  assert.equal(
    skillSearchQuery("", 37),
    '"claude skills" in:name,description,readme stars:>=100',
  );
});
test("GitHub repositories are reduced to safe marketplace display data", () => {
  assert.deepEqual(
    normalizeGitHubRepository({
      id: 7,
      full_name: "anthropics/skills",
      html_url: "https://github.com/anthropics/skills",
      description: "Official skills",
      stargazers_count: 123,
      forks_count: 4,
      updated_at: "2026-01-01T00:00:00Z",
      language: "Python",
      license: { spdx_id: "Apache-2.0" },
      topics: ["skills"],
      owner: { login: "anthropics" },
      clone_url: "should-not-leak",
    }),
    {
      id: 7,
      fullName: "anthropics/skills",
      description: "Official skills",
      url: "https://github.com/anthropics/skills",
      stars: 123,
      forks: 4,
      updatedAt: "2026-01-01T00:00:00Z",
      language: "Python",
      license: "Apache-2.0",
      topics: ["skills"],
      official: true,
    },
  );
});
test("skill marketplace excludes repositories that only mention skills in a README", () => {
  assert.equal(
    isSkillRepository({
      fullName: "owner/awesome-mcp-servers",
      description: "A collection of MCP servers",
      topics: ["mcp"],
    }),
    false,
  );
  assert.equal(
    isSkillRepository({
      fullName: "owner/ui-design-skill",
      description: "Design guidance",
      topics: [],
    }),
    true,
  );
});
test("dependency installers use fixed official sources without shell interpolation", () => {
  const git = installPlan("git", "C:\\Windows\\winget.exe");
  assert.equal(git.command, "C:\\Windows\\winget.exe");
  assert.ok(git.args.includes("Git.Git"));
  assert.equal(git.args.includes("user input"), false);
  const nodeFallback = installPlan("node", "");
  assert.equal(nodeFallback.command, null);
  assert.equal(nodeFallback.manualUrl, "https://nodejs.org/en/download");
  const claude = installPlan("claude");
  assert.equal(claude.command, "powershell.exe");
  assert.match(claude.args.at(-1), /^irm https:\/\/claude\.ai\/install\.ps1/);
  const macClaude = installPlan("claude", { platform: "darwin" });
  assert.equal(macClaude.command, "/bin/bash");
  assert.equal(macClaude.args[0], "-lc");
  assert.match(macClaude.args[1], /^curl -fsSL https:\/\/claude\.ai\/install\.sh/);
  const macGit = installPlan("git", {
    platform: "darwin",
    packageManagerPath: "/opt/homebrew/bin/brew",
  });
  assert.deepEqual(macGit.args, ["install", "git"]);
  assert.equal(macGit.manualUrl, "https://git-scm.com/download/mac");
  assert.throws(() => installPlan("unknown"));
});
test("stream framing survives fragmented UTF-8 and trailing lines", () => {
  const events = [],
    invalid = [];
  const parser = lineDecoder(
    (e) => events.push(e),
    (l) => invalid.push(l),
  );
  const b = Buffer.from('{"text":"中文对话"}\nnot-json\n{"type":"result"}');
  for (const byte of b) parser.write(Buffer.from([byte]));
  parser.end();
  assert.deepEqual(events, [{ text: "中文对话" }, { type: "result" }]);
  assert.equal(invalid.length, 1);
});
test("permission mode is explicit on resume and shell text is not executable", () => {
  const args = argumentsFor({
    session: "session-1",
    mode: "default",
    model: "model & echo BAD",
    mcp: {},
  });
  assert.ok(args.includes("--resume"));
  assert.equal(args[args.indexOf("--model") + 1], "model & echo BAD");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "default");
  assert.ok(args.includes("--permission-prompt-tool"));
  assert.throws(() => argumentsFor({ mode: "invalid" }));
  assert.ok(
    !argumentsFor({ mode: "bypassPermissions", mcp: {} }).includes(
      "--permission-prompt-tool",
    ),
  );
});
test("usage stays unknown when absent, real zero is preserved", () => {
  assert.equal(normalize({ type: "result" }).cost, null);
  assert.equal(normalize({ type: "result", total_cost_usd: 0 }).cost, 0);
  assert.equal(normalize({ type: "result" }).usage, null);
});
test("provider key is attached to exactly the selected authentication field", () => {
  const p = {
    id: "p",
    baseUrl: "https://example.test",
    secret: "encrypted",
    authType: "apiKey",
    model: "test",
  };
  assert.deepEqual(
    providerEnv(p, () => "decrypted"),
    {
      ANTHROPIC_BASE_URL: p.baseUrl,
      ANTHROPIC_API_KEY: "decrypted",
      ANTHROPIC_MODEL: "test",
    },
  );
  assert.deepEqual(
    providerEnv(null, () => {
      throw Error();
    }),
    {},
  );
});
test("provider credentials never need to be serialized into a CLI settings argument", () => {
  const env = providerEnv(
    {
      id: "p",
      baseUrl: "https://example.test",
      secret: "encrypted",
      authType: "token",
      model: "test",
    },
    () => "very-secret-token",
  );
  const settingsEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => !/AUTH_TOKEN|API_KEY/.test(key)),
  );
  assert.ok(!JSON.stringify(settingsEnv).includes("very-secret-token"));
  assert.equal(settingsEnv.ANTHROPIC_BASE_URL, "https://example.test");
});
test("partial text and tool messages normalize without treating tool output as instructions", () => {
  assert.deepEqual(
    normalize({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hello" },
      },
    }),
    { kind: "delta", text: "hello" },
  );
  assert.equal(
    normalize({
      type: "user",
      message: {
        content: [{ type: "tool_result", content: "<script>bad</script>" }],
      },
    }).kind,
    "tool_result",
  );
  assert.equal(normalize({ type: "unknown" }), null);
});
