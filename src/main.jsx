import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Plus,
  Search,
  Settings,
  ArrowUp,
  Square,
  FolderOpen,
  ChevronDown,
  Check,
  X,
  Shield,
  Zap,
  MessageSquare,
  PanelLeftClose,
  Terminal,
  ArrowUpRight,
  Download,
  RefreshCw,
  Cable,
  MoreHorizontal,
  Archive,
  Pencil,
  FileDown,
  Cpu,
  CircleHelp,
  Clock,
  LoaderCircle,
} from "lucide-react";
import "./style.css";

const api = window.board;
const modes = {
  default: "标准审批",
  plan: "计划模式",
  acceptEdits: "自动编辑",
  bypassPermissions: "完全自动",
};
const empty = { sessions: [], providers: [], settings: {}, running: null };
function App() {
  const [state, setState] = useState(empty),
    [selected, select] = useState(null),
    [query, setQuery] = useState(""),
    [prompt, setPrompt] = useState("");
  const [view, setView] = useState("chat"),
    [providerId, setProvider] = useState("native"),
    [mode, setMode] = useState("default"),
    [model, setModel] = useState("");
  const [env, setEnv] = useState(null),
    [updateInfo, setUpdateInfo] = useState(null),
    [updateBusy, setUpdateBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [approvals, setApprovals] = useState([]),
    [busy, setBusy] = useState(false),
    [installLog, setInstallLog] = useState("");
  const [showArchived, setArchived] = useState(false),
    [menu, setMenu] = useState(false),
    [rename, setRename] = useState(null);
  const [form, setForm] = useState({
    name: "",
    baseUrl: "",
    key: "",
    model: "",
    authType: "token",
  });
  const bottom = useRef(null),
    input = useRef(null),
    conversation = useRef(null),
    followOutput = useRef(true);
  const session = state.sessions.find((s) => s.id === selected),
    running = Boolean(state.running),
    active = state.running?.sessionId === selected;
  const runningSession = state.sessions.find(
      (s) => s.id === state.running?.sessionId,
    ),
    runningElsewhere = running && !active;
  const profile = state.providers.find((p) => p.id === providerId);
  async function call(action, data) {
    if (!api) {
      setNotice("浏览器仅展示界面。请打开 cc-board 桌面程序使用本地能力。");
      return null;
    }
    try {
      return await api.invoke(action, data);
    } catch (e) {
      setNotice(
        e.message.replace(/^Error invoking remote method 'board': Error: /, ""),
      );
      return null;
    }
  }
  useEffect(() => {
    if (!api) return;
    api
      .invoke("state")
      .then((s) => {
        setState(s);
        select(s.sessions.find((s) => !s.archived)?.id || null);
      })
      .catch((e) => setNotice(e.message));
    call("environment").then(setEnv);
    return api.subscribe((e) => {
      if (e.type === "state") setState(e.state);
      if (e.type === "approval") {
        setApprovals((a) => [
          ...a.filter((item) => item.requestId !== e.requestId),
          e,
        ]);
        setNotice(`运行中的会话需要批准：${e.tool}`);
      }
      if (e.type === "approvalClosed") {
        setApprovals((a) => a.filter((x) => x.requestId !== e.requestId));
        setNotice((current) => (current.includes("需要批准") ? "" : current));
      }
      if (e.type === "install") setInstallLog(e.text);
    });
  }, []);
  useEffect(() => {
    if (session) {
      setProvider(session.providerId || "native");
      setModel(session.model || "");
      setMode(active ? state.running.mode : session.mode || "default");
    }
    setMenu(false);
  }, [selected, state.running?.sessionId, state.running?.mode]);
  useEffect(() => {
    if (followOutput.current)
      bottom.current?.scrollIntoView({ behavior: "instant", block: "end" });
  }, [session?.messages?.length, session?.messages?.at(-1)?.text, selected]);
  useEffect(() => {
    followOutput.current = true;
  }, [selected]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 9000);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    if (rename === null) return;
    const close = (event) => {
      if (event.key === "Escape") setRename(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [rename]);
  async function newChat() {
    const cwd = await call("pickFolder");
    if (!cwd) return;
    const sid = await call("createSession", { cwd });
    if (sid) {
      select(sid);
      setView("chat");
      setPrompt("");
    }
  }
  async function send() {
    if (!prompt.trim() || busy || running) return;
    setBusy(true);
    try {
      let sid = selected;
      if (!sid) {
        const cwd = await call("pickFolder");
        if (!cwd) return;
        sid = await call("createSession", { cwd });
        if (!sid) return;
        select(sid);
      }
      const result = await call("start", {
        sessionId: sid,
        prompt,
        mode,
        providerId,
        model,
      });
      if (result?.started) setPrompt("");
    } finally {
      setBusy(false);
    }
  }
  async function stop() {
    await call("stop");
    setMode("default");
  }
  async function archiveCurrent() {
    const next = state.sessions.find(
      (item) =>
        item.id !== selected &&
        Boolean(item.archived) === Boolean(session?.archived),
    );
    const result = await call("archiveSession", { id: selected });
    setMenu(false);
    if (result !== null) select(next?.id || null);
  }
  async function changeMode(value) {
    if (running) {
      setNotice("请先停止当前任务，再切换权限。");
      return;
    }
    setMode(value);
  }
  function chooseProvider(value) {
    setProvider(value);
    setModel(state.providers.find((p) => p.id === value)?.model || "");
  }
  async function saveProvider(e) {
    e.preventDefault();
    const result = await call("saveProvider", form);
    if (result) {
      setForm({ name: "", baseUrl: "", key: "", model: "", authType: "token" });
      setNotice("服务商已保存。需要切换时请点击“使用”。");
    }
  }
  async function importConfig() {
    const result = await call("importProviders");
    if (result)
      setNotice(
        `已导入 ${result.imported} 项配置${result.skipped ? `，${result.skipped} 项不兼容已跳过` : ""}。原文件未修改。`,
      );
  }
  async function checkForUpdate() {
    setUpdateBusy(true);
    try {
      const result = await call("checkUpdate");
      if (result) {
        setUpdateInfo(result);
        setNotice(
          result.hasUpdate
            ? `发现新版本 v${result.latest}。`
            : "当前已经是最新版本。",
        );
      }
    } finally {
      setUpdateBusy(false);
    }
  }
  const visibleSessions = useMemo(
    () =>
      state.sessions
        .filter(
          (s) =>
            Boolean(s.archived) === showArchived &&
            (s.title + (s.messages || []).map((m) => m.text).join(" "))
              .toLowerCase()
              .includes(query.toLowerCase()),
        )
        .sort((a, b) => (b.updated || 0) - (a.updated || 0)),
    [state.sessions, showArchived, query],
  );
  const runs = session
    ? session.runs || []
    : state.sessions.flatMap((s) => s.runs || []);
  const measured = runs.filter((r) => r.usage),
    costs = runs.filter((r) => Number.isFinite(r.cost));
  const tokens = measured.reduce(
    (sum, r) =>
      sum +
      (r.usage.input_tokens || 0) +
      (r.usage.output_tokens || 0) +
      (r.usage.cache_read_input_tokens || 0) +
      (r.usage.cache_creation_input_tokens || 0),
    0,
  );
  const approval = approvals.find((a) => a.sessionId === selected);
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            cc<span>▰</span>
          </span>
          <b>cc-board</b>
          <span className="alpha">{env?.appVersion ? `v${env.appVersion}` : "预览版"}</span>
        </div>
        <button className="new-chat" onClick={newChat}>
          <Plus size={18} /> 新建对话 <span>＋</span>
        </button>
        <div className="search">
          <Search size={15} />
          <input
            aria-label="搜索历史对话"
            placeholder="搜索对话"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="history-heading">
          <span>{showArchived ? "已归档" : "最近对话"}</span>
          <button
            className="icon"
            title={showArchived ? "显示最近对话" : "显示归档"}
            onClick={() => setArchived(!showArchived)}
          >
            <Archive size={14} />
          </button>
        </div>
        <div className="history">
          {visibleSessions.map((s) => (
            <button
              key={s.id}
              className={
                "history-item " +
                (s.id === selected && view === "chat" ? "selected" : "")
              }
              onClick={() => {
                select(s.id);
                setView("chat");
              }}
            >
              <MessageSquare size={15} />
              <span>
                {s.title}
                <small>{s.cwd.split(/[\\/]/).pop()}</small>
              </span>
              {state.running?.sessionId === s.id && <i className="dot" />}
            </button>
          ))}
          {!visibleSessions.length && (
            <div className="history-empty">
              <MessageSquare size={22} />
              <p>
                {query
                  ? "没有匹配的对话"
                  : showArchived
                    ? "还没有归档对话"
                    : "从第一段对话开始"}
              </p>
              <small>
                {query ? "试试更短的关键词。" : "你的任务与灵感，会留在这里。"}
              </small>
            </div>
          )}
        </div>
        <div className="sidebar-bottom">
          <button
            className={view === "providers" ? "nav active" : "nav"}
            onClick={() => setView("providers")}
          >
            <Cable size={17} /> 模型与服务商 <ChevronDown size={14} />
          </button>
          <button
            className={view === "settings" ? "nav active" : "nav"}
            onClick={() => setView("settings")}
          >
            <Settings size={17} /> 设置与环境
          </button>
          <div className="local">
            <i className="dot" /> 本地工作空间 <span>v0.1.0</span>
          </div>
        </div>
      </aside>
      <main>
        <header>
          <div className="breadcrumb">
            <span>工作空间</span>
            <span>/</span>
            <strong>
              {view === "chat"
                ? session?.title || "新对话"
                : view === "providers"
                  ? "模型与服务商"
                  : "设置与环境"}
            </strong>
          </div>
          <div className="header-actions">
            <span className={"connection " + (env?.version ? "online" : "")}>
              <i className="dot" />
              {env?.version ? "Claude Code 已连接" : "待连接 Claude Code"}
            </span>
            {session && view === "chat" && (
              <div className="menu-wrap">
                <button
                  className="icon"
                  aria-label="会话操作"
                  title="会话操作"
                  onClick={() => setMenu(!menu)}
                >
                  <MoreHorizontal size={20} />
                </button>
                {menu && (
                  <div className="dropdown">
                    <button
                      onClick={() => {
                        setRename(session.title);
                        setMenu(false);
                      }}
                    >
                      <Pencil size={14} />
                      重命名
                    </button>
                    <button
                      onClick={() => {
                        call("exportSession", { id: selected });
                        setMenu(false);
                      }}
                    >
                      <FileDown size={14} />
                      导出 Markdown
                    </button>
                    <button onClick={archiveCurrent}>
                      <Archive size={14} />
                      {session.archived ? "取消归档" : "归档会话"}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </header>
        {view === "chat" ? (
          <>
            <div
              className="conversation"
              ref={conversation}
              onScroll={() => {
                const node = conversation.current;
                if (node)
                  followOutput.current =
                    node.scrollHeight - node.scrollTop - node.clientHeight < 90;
              }}
            >
              {!session?.messages.length ? (
                <div className="welcome">
                  <div className="welcome-label">
                    <span className="tiny-mark">✳</span> 让想法，在这里开始
                  </div>
                  <h1>今天，一起做点什么？</h1>
                  <p>用自然语言描述你的需求，剩下的交给 Claude Code。</p>
                  <div className="suggestions">
                    {[
                      {
                        icon: FolderOpen,
                        title: "了解一个项目",
                        text: "阅读当前项目，解释它的结构和运行方法，先不要修改文件。",
                        desc: "从文件结构到运行方式",
                      },
                      {
                        icon: Terminal,
                        title: "一起解决问题",
                        text: "帮我分析当前项目可能存在的问题，先给出排查计划。",
                        desc: "找到原因，再逐步修复",
                      },
                      {
                        icon: Zap,
                        title: "实现一个想法",
                        text: "我想实现一个新功能。请先阅读项目，然后和我确认具体需求。",
                        desc: "把灵感变成可运行的作品",
                      },
                    ].map((card) => (
                      <button
                        key={card.title}
                        className="suggestion"
                        onClick={() => {
                          setPrompt(card.text);
                          input.current?.focus();
                        }}
                      >
                        <card.icon size={20} />
                        <strong>{card.title}</strong>
                        <small>{card.desc}</small>
                        <ArrowUpRight className="card-arrow" size={16} />
                      </button>
                    ))}
                  </div>
                  <div className="welcome-note">
                    <Shield size={14} />{" "}
                    默认逐项审批需要授权的操作，你始终可以停止任务。
                  </div>
                </div>
              ) : (
                <div className="messages">
                  {session.messages.map((m) => (
                    <Message
                      key={m.id}
                      message={m}
                      toolName={
                        m.toolId
                          ? session.messages.find(
                              (item) =>
                                item.role === "tool" &&
                                item.toolId === m.toolId,
                            )?.tool
                          : null
                      }
                    />
                  ))}
                  {active && (
                    <div className="working" role="status" aria-live="polite">
                      <LoaderCircle className="spin" size={15} />
                      {approval ? "等待你的批准…" : "Claude Code 正在处理…"}
                    </div>
                  )}
                  <div ref={bottom} />
                </div>
              )}
            </div>
            <div className="composer-area">
              {runningElsewhere && (
                <div className="running-elsewhere" role="status">
                  <Clock size={15} />
                  <span>“{runningSession?.title || "另一个会话"}”正在运行</span>
                  <button
                    onClick={() => {
                      select(state.running.sessionId);
                      setView("chat");
                    }}
                  >
                    查看会话
                  </button>
                </div>
              )}
              {approval && (
                <div className="approval">
                  <div>
                    <Shield size={17} />
                    <strong>需要批准：{approval.tool}</strong>
                  </div>
                  <pre>{JSON.stringify(approval.input, null, 2)}</pre>
                  <div className="approval-actions">
                    <button
                      className="secondary"
                      onClick={() =>
                        call("approve", {
                          requestId: approval.requestId,
                          allow: false,
                        })
                      }
                    >
                      拒绝
                    </button>
                    <button
                      className="primary"
                      onClick={() =>
                        call("approve", {
                          requestId: approval.requestId,
                          allow: true,
                        })
                      }
                    >
                      允许本次
                    </button>
                  </div>
                </div>
              )}
              {mode === "bypassPermissions" && (
                <div className="risk">
                  <Shield size={14} />
                  完全自动：执行前将确认风险，运行中不逐项审批。
                  <button onClick={running ? stop : () => setMode("default")}>
                    {running ? "停止并关闭" : "关闭"}
                  </button>
                </div>
              )}
              <div className="composer">
                <textarea
                  ref={input}
                  aria-label="消息输入框"
                  disabled={runningElsewhere}
                  placeholder={
                    runningElsewhere
                      ? "另一个会话正在运行…"
                      : "描述你的想法，或提出一个问题…"
                  }
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      send();
                    }
                  }}
                />
                <div className="composer-tools">
                  <div className="select-chip">
                    <Cable size={14} />
                    <select
                      aria-label="服务商"
                      disabled={running}
                      value={providerId}
                      onChange={(e) => chooseProvider(e.target.value)}
                    >
                      <option value="native">
                        原生配置 / CC Switch 当前配置
                      </option>
                      {state.providers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="select-chip model-chip">
                    <Cpu size={14} />
                    <input
                      aria-label="模型"
                      disabled={running}
                      list="model-options"
                      value={model}
                      placeholder="模型（默认）"
                      onChange={(e) => setModel(e.target.value)}
                      maxLength={200}
                    />
                    <datalist id="model-options">
                      <option value="sonnet" />
                      <option value="opus" />
                      <option value="haiku" />
                    </datalist>
                  </div>
                  <div
                    className={
                      "select-chip permission " +
                      (mode === "bypassPermissions" ? "danger" : "")
                    }
                  >
                    <Shield size={14} />
                    <select
                      aria-label="权限模式"
                      value={mode}
                      disabled={running}
                      onChange={(e) => changeMode(e.target.value)}
                    >
                      {Object.entries(modes).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    className={"send " + (active ? "stop" : "")}
                    aria-label={
                      active
                        ? "停止任务"
                        : runningElsewhere
                          ? "查看运行中的会话"
                          : "发送消息"
                    }
                    title={
                      active
                        ? "停止任务"
                        : runningElsewhere
                          ? "查看运行中的会话"
                          : "发送消息"
                    }
                    disabled={!running && (!prompt.trim() || busy)}
                    onClick={
                      active
                        ? stop
                        : runningElsewhere
                          ? () => {
                              select(state.running.sessionId);
                              setView("chat");
                            }
                          : send
                    }
                  >
                    {busy ? (
                      <LoaderCircle className="spin" size={18} />
                    ) : active ? (
                      <Square size={16} />
                    ) : runningElsewhere ? (
                      <MessageSquare size={17} />
                    ) : (
                      <ArrowUp size={20} />
                    )}
                  </button>
                </div>
              </div>
              <div className="composer-footer">
                <span>
                  <FolderOpen size={13} />
                  {session?.cwd || "发送前选择工作文件夹"}
                </span>
                <span>Enter 发送 · Shift + Enter 换行</span>
              </div>
              <div className="usage-line">
                <span>
                  {session ? "本会话" : "全部会话"}用量：
                  {measured.length
                    ? tokens.toLocaleString() + " tokens"
                    : "暂无数据"}
                </span>
                <span>
                  CLI 费用估算：
                  {costs.length
                    ? "$" + costs.reduce((s, r) => s + r.cost, 0).toFixed(4)
                    : "未知"}{" "}
                  · 非服务商账单
                </span>
              </div>
            </div>
          </>
        ) : view === "providers" ? (
          <div className="page">
            <div className="page-title">
              <div>
                <div className="eyebrow">连接你的模型</div>
                <h1>模型与服务商</h1>
                <p>在这里管理连接，切换后从下一次运行生效。</p>
              </div>
              <button className="secondary" onClick={importConfig}>
                <Download size={16} /> 导入 CC Switch
              </button>
            </div>
            <div className="info">
              <Cable size={17} />
              <span>
                只读导入本机 CC Switch 与 Claude Code
                的配置。密钥加密保存在本机，原程序和配置保持独立。
              </span>
            </div>
            <div className="provider-list">
              <div className="provider-card">
                <div className="provider-icon">
                  <Terminal size={21} />
                </div>
                <div>
                  <strong>原生配置</strong>
                  <p>使用 Claude Code 当前登录或 CC Switch 当前配置</p>
                </div>
                <span className="badge">内置</span>
              </div>
              {state.providers.map((p) => (
                <div key={p.id} className="provider-card">
                  <div className="provider-icon">
                    <Cpu size={21} />
                  </div>
                  <div className="provider-info">
                    <strong>{p.name}</strong>
                    <p>{p.baseUrl}</p>
                    <small>
                      {p.model || "模型由原生配置决定"} ·{" "}
                      {p.hasKey ? "密钥已加密" : "无密钥"} ·{" "}
                      {p.source || "手动配置"}
                    </small>
                  </div>
                  <button
                    className="text-button"
                    onClick={async () => {
                      const r = await call("testProvider", { id: p.id });
                      if (r?.ok)
                        setNotice(
                          "基础连接测试通过；工具调用兼容性需实际任务验证。",
                        );
                    }}
                  >
                    测试
                  </button>
                  <button
                    className="text-button"
                    onClick={() => setForm({ ...p, key: "" })}
                  >
                    编辑
                  </button>
                  {p.hasKey && (
                    <button
                      className="text-button"
                      onClick={async () => {
                        const result = await call("clearProviderKey", {
                          id: p.id,
                        });
                        if (result?.cleared) setNotice("保存的密钥已清除。");
                      }}
                    >
                      清除密钥
                    </button>
                  )}
                  <button
                    className="text-button danger"
                    onClick={async () => {
                      const result = await call("deleteProvider", { id: p.id });
                      if (result?.deleted) {
                        if (providerId === p.id) chooseProvider("native");
                        if (form.id === p.id)
                          setForm({
                            name: "",
                            baseUrl: "",
                            key: "",
                            model: "",
                            authType: "token",
                          });
                      }
                    }}
                  >
                    删除
                  </button>
                  <button
                    className="secondary"
                    onClick={() => {
                      chooseProvider(p.id);
                      setView("chat");
                      setNotice("已选择服务商和默认模型，下次发送时使用。");
                    }}
                  >
                    使用
                  </button>
                </div>
              ))}
            </div>
            <form className="provider-form" onSubmit={saveProvider}>
              <h2>{form.id ? "编辑服务商" : "添加服务商"}</h2>
              <div className="form-grid">
                <label>
                  名称
                  <input
                    required
                    placeholder="例如：我的模型服务"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </label>
                <label>
                  默认模型 ID
                  <input
                    placeholder="例如 sonnet 或服务商模型 ID"
                    value={form.model}
                    onChange={(e) =>
                      setForm({ ...form, model: e.target.value })
                    }
                  />
                </label>
                <label className="full">
                  API 地址
                  <input
                    required
                    type="url"
                    placeholder="https://api.example.com"
                    value={form.baseUrl}
                    onChange={(e) =>
                      setForm({ ...form, baseUrl: e.target.value })
                    }
                  />
                </label>
                <label>
                  API Key
                  <input
                    type="password"
                    autoComplete="new-password"
                    placeholder={
                      form.hasKey ? "留空保留已保存密钥" : "仅加密保存在本机"
                    }
                    value={form.key}
                    onChange={(e) => setForm({ ...form, key: e.target.value })}
                  />
                </label>
                <label>
                  认证方式
                  <select
                    value={form.authType}
                    onChange={(e) =>
                      setForm({ ...form, authType: e.target.value })
                    }
                  >
                    <option value="token">Bearer Token</option>
                    <option value="apiKey">x-api-key</option>
                  </select>
                </label>
              </div>
              <div className="form-footer">
                <small>
                  需兼容 Anthropic Messages 协议。余额接口暂未适配。
                </small>
                <div className="button-row compact">
                  {form.id && (
                    <button
                      className="secondary"
                      type="button"
                      onClick={() =>
                        setForm({
                          name: "",
                          baseUrl: "",
                          key: "",
                          model: "",
                          authType: "token",
                        })
                      }
                    >
                      取消编辑
                    </button>
                  )}
                  <button className="primary" type="submit">
                    保存连接
                  </button>
                </div>
              </div>
            </form>
          </div>
        ) : (
          <div className="page">
            <div className="eyebrow">为第一次使用做好准备</div>
            <h1>设置与环境</h1>
            <p className="page-desc">
              连接原版 Claude Code，让日常操作留在一个窗口里。
            </p>
            <section className="settings-card">
              <div className="section-heading">
                <Terminal size={22} />
                <div>
                  <h2>Claude Code</h2>
                  <p>
                    {env?.version || "尚未检测到可运行的原生版本"}
                    {env?.auth?.loggedIn
                      ? ` · ${env.auth.email || "已登录 Claude"}`
                      : env?.version
                        ? " · 尚未登录官方账户（第三方服务商可忽略）"
                        : ""}
                  </p>
                </div>
                <span className={"badge " + (env?.version ? "green" : "")}>
                  {env?.auth?.loggedIn
                    ? "已登录"
                    : env?.version
                      ? "已安装"
                      : "待配置"}
                </span>
              </div>
              <code>
                {env?.cliPath || "安装后会自动检测，也可以手动选择 claude.exe"}
              </code>
              <div className="button-row">
                <button
                  className="primary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const r = await call("installCli");
                      if (r && !r.cancelled) setEnv(r);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <Download size={15} /> 安装官方版本
                </button>
                <button
                  className="secondary"
                  onClick={async () => {
                    const r = await call("pickCli");
                    if (r) setEnv(r);
                  }}
                >
                  选择 claude.exe
                </button>
                <button
                  className="secondary"
                  onClick={async () => {
                    const r = await call("environment");
                    if (r) setEnv(r);
                  }}
                >
                  <RefreshCw size={15} /> 重新检测
                </button>
                {env?.version && !env?.auth?.loggedIn && (
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
                    <ArrowUpRight size={15} /> 登录 Claude
                  </button>
                )}
              </div>
              {installLog && <pre className="install-log">{installLog}</pre>}
            </section>
            <section className="settings-card">
              <div className="section-heading">
                <Cable size={22} />
                <div>
                  <h2>CC Switch</h2>
                  <p>
                    {env?.ccSwitch
                      ? "已找到本机数据库，可导入已有服务商"
                      : "未找到数据库，可手动配置服务商"}
                  </p>
                </div>
              </div>
              <button className="secondary" onClick={importConfig}>
                导入已有配置
              </button>
            </section>
            <section className="settings-card">
              <div className="section-heading">
                <RefreshCw size={22} />
                <div>
                  <h2>cc-board 更新</h2>
                  <p>
                    当前版本 v{env?.appVersion || "未知"}
                    {updateInfo?.hasUpdate
                      ? ` · 可更新到 v${updateInfo.latest}`
                      : updateInfo
                        ? " · 已是最新版本"
                        : " · 可连接 GitHub 检查新版"}
                  </p>
                </div>
                {updateInfo && (
                  <span className={"badge " + (updateInfo.hasUpdate ? "" : "green")}>
                    {updateInfo.hasUpdate ? "有新版本" : "最新"}
                  </span>
                )}
              </div>
              <div className="button-row">
                <button
                  className="secondary"
                  disabled={updateBusy}
                  onClick={checkForUpdate}
                >
                  <RefreshCw size={15} className={updateBusy ? "spin" : ""} />
                  {updateBusy ? "正在检查" : "检查更新"}
                </button>
                <button className="secondary" onClick={() => call("openReleases")}>
                  <ArrowUpRight size={15} /> 打开下载页
                </button>
              </div>
            </section>
            <section className="settings-card">
              <div className="section-heading">
                <Shield size={22} />
                <div>
                  <h2>权限与本地数据</h2>
                  <p>默认标准审批；完全自动需要在每次运行前确认。</p>
                </div>
              </div>
              <p>
                工作文件夹不是沙箱。关闭自动模式需先停止运行，已经执行的操作不会撤销。历史记录保存在本机，API
                Key 使用系统加密；向模型发送的内容由所选服务商处理。
              </p>
              <code>{env?.dataPath || "桌面程序启动后显示数据目录"}</code>
            </section>
            <button className="text-button" onClick={() => call("docs")}>
              <CircleHelp size={15} /> 查看官方安装与登录说明{" "}
              <ArrowUpRight size={14} />
            </button>
          </div>
        )}
      </main>
      {notice && (
        <div className="toast" role="status">
          {notice}
          <button
            className="icon"
            aria-label="关闭通知"
            onClick={() => setNotice("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {rename !== null && (
        <div className="modal-overlay">
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-title"
            onSubmit={async (e) => {
              e.preventDefault();
              await call("renameSession", { id: selected, title: rename });
              setRename(null);
            }}
          >
            <h2 id="rename-title">重命名对话</h2>
            <label>
              对话名称
              <input
                aria-label="对话名称"
                autoFocus
                value={rename}
                onChange={(e) => setRename(e.target.value)}
                maxLength={80}
              />
            </label>
            <div className="button-row">
              <button
                type="button"
                className="secondary"
                onClick={() => setRename(null)}
              >
                取消
              </button>
              <button className="primary">保存</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
function Message({ message: m, toolName }) {
  if (m.role === "audit")
    return (
      <div className="audit">
        <Shield size={12} />
        {m.text}
      </div>
    );
  if (m.role === "tool" || m.role === "toolResult")
    return (
      <details className={"tool-card " + (m.error ? "error" : "")}>
        <summary>
          <Terminal size={14} />
          {m.role === "tool"
            ? "执行工具 · " + m.tool
            : `${m.error ? "工具返回错误" : "工具执行结果"}${toolName ? " · " + toolName : ""}`}
          <ChevronDown size={13} />
        </summary>
        <pre>{m.text}</pre>
      </details>
    );
  if (m.role === "system" || m.role === "error")
    return (
      <div className={"system-message " + (m.role === "error" ? "error" : "")}>
        {m.text}
      </div>
    );
  return (
    <div className={"message " + m.role}>
      <div className="message-label">
        {m.role === "user" ? (
          <span className="avatar user-avatar">你</span>
        ) : (
          <span className="avatar assistant-avatar">✳</span>
        )}
        <strong>{m.role === "user" ? "你" : "Claude Code"}</strong>
        <time>
          {new Date(m.time).toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
      </div>
      <div className="message-content">
        {m.text.split(/(```[\s\S]*?```)/g).map((part, i) =>
          part.startsWith("```") ? (
            <pre key={i}>
              <code>
                {part.replace(/^```[^\n]*\n?/, "").replace(/```$/, "")}
              </code>
            </pre>
          ) : (
            <span key={i}>{part}</span>
          ),
        )}
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
