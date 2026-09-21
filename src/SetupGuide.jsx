import React from "react";
import {
  ArrowUpRight,
  Check,
  Download,
  GitBranch,
  Package,
  RefreshCw,
  Terminal,
  Wrench,
} from "lucide-react";

export default function SetupGuide({
  env,
  setEnv,
  call,
  busy,
  setBusy,
  installState,
}) {
  const dependencies = env?.dependencies || {};
  const isMac = env?.platform === "darwin";
  const items = [
    {
      id: "claude",
      name: "Claude Code",
      icon: Terminal,
      installed: Boolean(env?.version),
      version: env?.version,
      path: env?.cliPath,
      label: "必需",
      description: "cc-board 通过本机原版 Claude Code 执行任务。使用官方原生安装，无需 Node.js。",
    },
    {
      id: "git",
      name: isMac ? "Git" : "Git for Windows",
      icon: GitBranch,
      installed: Boolean(dependencies.git?.installed),
      version: dependencies.git?.version,
      path: dependencies.git?.path,
      label: "推荐",
      description: isMac
        ? "Claude Code 可使用 Git 进行版本控制；可通过 Homebrew 自动安装。"
        : "Claude Code 可使用 Git Bash 和版本控制；未安装时会回退到 PowerShell。",
    },
    {
      id: "node",
      name: "Node.js LTS",
      icon: Package,
      installed: Boolean(dependencies.node?.installed),
      version: dependencies.node?.version,
      path: dependencies.node?.path,
      label: "开发可选",
      description: "安装版 cc-board 不依赖 Node.js；只有从源码开发或使用 npm 安装方式时才需要。",
    },
  ];

  async function refresh() {
    const result = await call("environment");
    if (result) setEnv(result);
  }

  async function install(target) {
    setBusy(true);
    try {
      const result = await call("installDependency", { target });
      if (result?.manual) await call("openDependencyDownload", { target });
      else if (result) setEnv(result);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-card setup-guide">
      <div className="setup-heading">
        <div className="section-heading">
          <Wrench size={22} />
          <div>
            <h2>首次使用检查</h2>
            <p>自动检测运行环境；缺少项目可直接安装或打开官方下载页。</p>
          </div>
        </div>
        <button className="secondary" disabled={busy} onClick={refresh}>
          <RefreshCw size={15} /> 重新检测
        </button>
      </div>

      <div className="dependency-list">
        {items.map((item) => {
          const Icon = item.icon;
          const active = installState.target === item.id;
          const failed = active && installState.status === "error";
          const canAutoInstall =
            item.id === "claude" || Boolean(dependencies.packageManager?.installed);
          return (
            <article className="dependency-card" key={item.id}>
              <span className={"dependency-icon " + (item.installed ? "ready" : "")}>
                {item.installed ? <Check size={18} /> : <Icon size={18} />}
              </span>
              <div className="dependency-info">
                <div className="dependency-name">
                  <strong>{item.name}</strong>
                  <span>{item.label}</span>
                  <span className={item.installed ? "status-ready" : "status-missing"}>
                    {item.installed ? "已安装" : "未检测到"}
                  </span>
                </div>
                <p>{item.description}</p>
                {item.installed && (
                  <small title={item.path || ""}>
                    {item.version || "已安装"}{item.path ? ` · ${item.path}` : ""}
                  </small>
                )}
                {active && installState.text && (
                  <div className={"dependency-progress " + (failed ? "failed" : "")}>
                    {!failed && installState.status !== "success" && <i />}
                    <pre>{installState.text}</pre>
                  </div>
                )}
              </div>
              <div className="dependency-actions">
                {!item.installed && canAutoInstall && (
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => install(item.id)}
                  >
                    <Download size={14} />
                    {active && !failed ? "安装中…" : "一键安装"}
                  </button>
                )}
                {!item.installed && (!canAutoInstall || failed) && (
                  <button
                    className="secondary"
                    onClick={() => call("openDependencyDownload", { target: item.id })}
                  >
                    官方下载 <ArrowUpRight size={14} />
                  </button>
                )}
                {item.id === "claude" && !item.installed && (
                  <button
                    className="text-button"
                    onClick={async () => {
                      const result = await call("pickCli");
                      if (result) setEnv(result);
                    }}
                  >
                    选择已有 Claude Code 程序
                  </button>
                )}
                {item.id === "claude" && item.installed && !env?.auth?.loggedIn && (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        const result = await call("authLogin");
                        if (result) setEnv(result);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    登录 Claude <ArrowUpRight size={14} />
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {!dependencies.packageManager?.installed && (
        <div className="setup-note">
          {isMac
            ? "当前未检测到 Homebrew，因此 Git 与 Node.js 提供官方下载入口。"
            : "当前未检测到 Windows 程序包管理器 WinGet，因此 Git 与 Node.js 提供官方下载入口。"}
        </div>
      )}
      <div className="setup-note optional">
        CC Switch 不是必需组件。只有你本来就在用 CC Switch，并希望导入其中的服务商配置时才需要它。
      </div>
    </section>
  );
}
