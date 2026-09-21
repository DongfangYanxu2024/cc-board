const path = require("node:path");

function nativeClaudePackage() {
  if (process.platform === "win32") return "@anthropic-ai/claude-code-win32-x64";
  if (process.platform === "darwin")
    return `@anthropic-ai/claude-code-darwin-${process.arch === "arm64" ? "arm64" : "x64"}`;
  throw Error(`Unsupported native test platform: ${process.platform}/${process.arch}`);
}

function nativeClaudePath(root) {
  return path.join(
    root,
    "work",
    "native-cli",
    "node_modules",
    ...nativeClaudePackage().split("/"),
    process.platform === "win32" ? "claude.exe" : "claude",
  );
}

function electronPath() {
  return require("electron");
}

module.exports = { nativeClaudePackage, nativeClaudePath, electronPath };
