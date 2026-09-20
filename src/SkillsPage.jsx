import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  Command,
  Github,
  LoaderCircle,
  Search,
  ShieldCheck,
  Sparkles,
  Star,
} from "lucide-react";

const commands = [
  {
    name: "/init",
    title: "建立项目记忆",
    description: "扫描项目并生成 CLAUDE.md，适合第一次接手代码库。",
  },
  {
    name: "/plan",
    title: "先规划再动手",
    description: "切换到计划模式，先澄清方案与影响范围。",
  },
  {
    name: "/review",
    title: "检查当前改动",
    description: "审查差异中的正确性问题和可清理项。",
  },
  {
    name: "/security-review",
    title: "安全审查",
    description: "检查当前变更中可能存在的安全漏洞。",
  },
  {
    name: "/compact",
    title: "压缩长对话",
    description: "总结当前上下文，为后续任务释放空间。",
  },
  {
    name: "/doctor",
    title: "诊断环境",
    description: "检查 Claude Code 的安装、配置与更新状态。",
  },
];

const number = new Intl.NumberFormat("zh-CN", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export default function SkillsPage({ call, useCommand }) {
  const [query, setQuery] = useState("");
  const [minimumStars, setMinimumStars] = useState(100);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searched, setSearched] = useState("");

  async function search(nextQuery = query, nextStars = minimumStars) {
    setLoading(true);
    try {
      const response = await call("searchSkills", {
        query: nextQuery,
        minimumStars: nextStars,
      });
      if (response) {
        setResults(response.results || []);
        setSearched(response.query || "");
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    search("", 100);
  }, []);

  const ordered = useMemo(
    () =>
      [...results].sort(
        (a, b) => Number(b.official) - Number(a.official) || b.stars - a.stars,
      ),
    [results],
  );

  return (
    <div className="page skills-page">
      <div className="eyebrow">原生能力与社区扩展</div>
      <div className="page-title-row">
        <div>
          <h1>技能商场</h1>
          <p className="page-desc">
            快速调用 Claude Code 原生指令，或从 GitHub 发现高关注度的 skills。
          </p>
        </div>
        <div className="button-row compact">
          <button className="secondary" onClick={() => call("commandDocs")}>
            <BookOpen size={15} /> 官方指令
          </button>
          <button className="secondary" onClick={() => call("skillDocs")}>
            <ArrowUpRight size={15} /> Skill 文档
          </button>
        </div>
      </div>

      <section className="skills-section">
        <div className="skills-section-title">
          <div>
            <h2>常用原生指令</h2>
            <p>点击后会把指令填入当前对话，你可以继续补充要求再发送。</p>
          </div>
          <span className="badge green">随 Claude Code 提供</span>
        </div>
        <div className="command-grid">
          {commands.map((item) => (
            <button
              className="command-card"
              key={item.name}
              onClick={() => useCommand(item.name)}
            >
              <span className="command-icon">
                {item.name === "/security-review" ? (
                  <ShieldCheck size={17} />
                ) : (
                  <Command size={17} />
                )}
              </span>
              <span>
                <code>{item.name}</code>
                <strong>{item.title}</strong>
                <small>{item.description}</small>
              </span>
              <ArrowUpRight size={15} />
            </button>
          ))}
        </div>
      </section>

      <section className="skills-section github-market">
        <div className="skills-section-title">
          <div>
            <h2>GitHub 热门 Skills</h2>
            <p>官方来源优先展示，其余结果按 Star 数筛选。安装前请审查仓库内容。</p>
          </div>
          <Github size={22} />
        </div>
        <form
          className="skill-search"
          onSubmit={(event) => {
            event.preventDefault();
            search();
          }}
        >
          <label>
            <Search size={17} />
            <input
              aria-label="搜索 GitHub Skills"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索场景，例如 React、测试、文档"
              maxLength={80}
            />
          </label>
          <select
            aria-label="最低 Star 数"
            value={minimumStars}
            onChange={(event) => setMinimumStars(Number(event.target.value))}
          >
            <option value={0}>不限 Star</option>
            <option value={100}>100+ Stars</option>
            <option value={1000}>1k+ Stars</option>
            <option value={10000}>10k+ Stars</option>
          </select>
          <button className="primary" disabled={loading}>
            {loading ? <LoaderCircle className="spin" size={15} /> : <Search size={15} />}
            {loading ? "搜索中" : "搜索 GitHub"}
          </button>
        </form>

        {loading && !ordered.length ? (
          <div className="market-empty">
            <LoaderCircle className="spin" size={24} />
            <p>正在读取 GitHub 热门仓库…</p>
          </div>
        ) : ordered.length ? (
          <div className="skill-results" aria-live="polite">
            {ordered.map((repo) => (
              <article className="skill-card" key={repo.id}>
                <div className="skill-card-top">
                  <span className="repo-mark">
                    {repo.official ? <Sparkles size={18} /> : <Github size={18} />}
                  </span>
                  <div>
                    <h3>{repo.fullName}</h3>
                    <div className="repo-meta">
                      {repo.official && <span className="official-tag">Anthropic 官方</span>}
                      <span><Star size={12} /> {number.format(repo.stars)}</span>
                      <span>{number.format(repo.forks)} forks</span>
                      {repo.license && <span>{repo.license}</span>}
                    </div>
                  </div>
                </div>
                <p>{repo.description}</p>
                <div className="skill-card-footer">
                  <div className="repo-topics">
                    {repo.topics.slice(0, 3).map((topic) => (
                      <span key={topic}>{topic}</span>
                    ))}
                  </div>
                  <button
                    className="secondary"
                    onClick={() => call("openGitHub", { url: repo.url })}
                  >
                    在 GitHub 查看 <ArrowUpRight size={14} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="market-empty">
            <Search size={24} />
            <p>{searched ? `没有找到与“${searched}”匹配的热门 Skill` : "没有找到热门 Skill"}</p>
            <small>试试更短的关键词，或降低最低 Star 数。</small>
          </div>
        )}
        <p className="market-note">
          Star 仅代表社区关注度，不等于安全审核。第三方 Skill 可能包含脚本、工具权限或外部服务，使用前请查看 SKILL.md、许可证和最近更新。
        </p>
      </section>
    </div>
  );
}
