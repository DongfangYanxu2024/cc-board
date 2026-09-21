# cc-board

cc-board 是一个面向 Claude Code 新用户的 Windows 与 macOS 图形界面。它不重写智能体，也不代理终端输出：任务仍由本机安装的原版 Claude Code 执行，cc-board 负责把流式对话、工具调用、权限请求和历史记录映射到统一界面。

> 当前版本为 `0.4.0` 预览版。建议先在测试项目中使用并保留重要文件的版本控制或备份。

## 已实现

- 中文聊天界面、流式回答、工具调用和结果卡片。
- 本地历史记录、搜索、重命名、归档、恢复 Claude Code 会话和 Markdown 导出。
- 原生 Claude Code 检测、官方安装入口和官方账户登录入口。
- 首次启动自动检查 Claude Code、Git、Node.js 与当前系统包管理器，显示安装进度，并在自动安装失败时提供官方下载入口。
- 从原版 CC Switch 数据库只读导入 Claude 服务商配置，不修改 CC Switch 文件。
- 服务商/API 地址/API Key 配置、连接测试，以及按次选择模型。
- 标准审批、计划模式、自动编辑和完全自动四种权限模式。
- 在图形界面中允许或拒绝 Claude Code 的原生权限请求。
- Token 与 CLI 费用估算展示；无法获得的数据明确显示为未知。
- 在设置页显示当前版本、检查 GitHub 新版本并打开下载页面。
- 对话置顶、同一工作台快速新建对话，以及带确认的永久删除。
- 一键复制用户或 Claude Code 的消息内容。
- 技能商场：可检索 GitHub 高 Star skill 仓库、识别 Anthropic 官方来源，并一键安装到 Claude Code 的个人 Skills 目录。
- 输入栏原生指令入口：`/init`、`/plan`、`/review`、`/security-review`、`/compact`、`/doctor`。
- 模型、服务商、权限及危险操作全部使用页面内选项和确认条，避免系统弹窗导致鼠标失灵。

## 安装和首次使用

1. 从 GitHub Releases 下载适合本机的安装包：Windows 使用 `cc-board-Setup-0.4.0.exe`；Apple 芯片 Mac 使用 `cc-board-0.4.0-mac-arm64.dmg`；Intel Mac 使用 `cc-board-0.4.0-mac-x64.dmg`。
2. 首次启动会自动打开“设置与环境”并检查 Claude Code、Git、Node.js 和 WinGet/Homebrew。缺少 Claude Code 时可一键安装；Git 为推荐组件；Node.js 只在源码开发时需要。
3. 使用 Anthropic 官方账户时点击“登录 Claude”，在浏览器完成登录。使用兼容服务商时可跳过官方登录。
4. 打开“模型与服务商”，点击“导入 CC Switch”，或手动添加兼容 Anthropic Messages 协议的服务商。
5. 点击“新建对话”，选择工作台，然后直接描述任务。

Windows 可能对未签名的预览版安装程序显示“未知发布者”或 SmartScreen 提示。macOS 预览包尚未使用 Apple Developer ID 签名和公证，首次打开时可能被 Gatekeeper 阻止；可在“系统设置 → 隐私与安全性”中确认“仍要打开”。公开大范围发布前应配置两个平台的代码签名。

## Claude Code 与 CC Switch 的关系

- Claude Code 由 Anthropic 官方版本独立安装和更新，cc-board 只启动其本地可执行文件。
- CC Switch 不是必需组件，也不需要为了使用 cc-board 额外下载。若你本来就在使用 CC Switch，cc-board 可以只读访问其 `providers` 数据，并复制所需配置到自己的本地数据库。
- 选择“原生配置 / CC Switch 当前配置”时，Claude Code 直接使用当前原生配置。
- 在 cc-board 中选择导入或手动配置的服务商时，该配置只对本次启动的 Claude Code 子进程生效。
- cc-board 不捆绑 Claude Code、CC Switch、Node.js、Git、模型账户或模型额度。安装版 cc-board 自带 Electron 运行环境，不依赖系统 Node.js。

## 权限说明

默认使用“标准审批”，需要授权的文件修改、命令或网络操作会显示在界面中。

“完全自动”对应 Claude Code 的 `bypassPermissions` 模式。每次启动前都会在应用内显示风险确认，后台也会拒绝未经明确确认的启动请求。开启后，智能体可以无需逐项确认地执行命令、修改或删除文件以及联网，可能造成数据丢失、信息泄露和额外费用。工作台不是安全沙箱；关闭模式或停止任务不会撤销已经完成的操作。

技能商场使用 GitHub 公共搜索接口，默认展示 100 Stars 以上的相关仓库，并将官方来源优先展示。GitHub 的未登录搜索有频率限制；第三方 Skill 可能携带脚本、工具权限或外部服务，Star 数不是安全审核，安装前应检查 `SKILL.md`、许可证与最近更新。

建议在受版本控制的专用项目目录中使用完全自动模式。

## 本地数据与密钥

- 历史记录和设置保存在 Electron 的用户数据目录，Windows 通常为 `%APPDATA%\cc-board\cc-board.db`，macOS 通常为 `~/Library/Application Support/cc-board/cc-board.db`。
- API Key 使用操作系统安全存储能力加密后再写入数据库（Windows DPAPI / macOS Keychain）。
- 密钥不会发送给 cc-board 项目方。任务内容与密钥会按照所选配置发送给对应模型服务商。
- 服务商密钥通过子进程环境传递，不写入 Claude Code 命令行参数。
- “导入 CC Switch”以只读方式打开原数据库。
- “永久删除”会让会话不再出现在 cc-board 中，但不会清除 Claude Code 自身历史、系统备份或数据库旧页中的残留内容。

## 当前限制

- 支持 Windows x64、macOS Apple Silicon（arm64）与 macOS Intel（x64）；macOS 需要 13 或更高版本。Linux 与 Windows ARM 尚未打包验证。
- 服务商必须兼容 Claude Code 所需的 Anthropic Messages 接口及工具调用。基础连接测试通过不代表所有工具都兼容。
- 暂未适配各服务商余额接口；界面中的美元费用是 Claude Code 返回的估算，不是服务商账单。
- 登录由原生 Claude Code 发起并在系统浏览器完成。
- 暂不提供完整嵌入式终端。少数只在交互终端中可用的 Claude Code 命令仍需使用原版 CLI。
- 没有云同步和多人协作，所有会话索引保存在本机。

## 本地开发

需要 Windows 10 或更高版本，或 macOS 13 或更高版本；另需 Node.js 22 或更高版本与 Git。

```powershell
npm install
npm start
```

常用验证命令：

```powershell
npm test
npm run test:desktop
npm run dist
```

`npm run test:desktop-native` 是完整的本地集成测试。它需要先把当前平台的官方 Claude Code 二进制安装到测试目录。Windows x64 示例：

```powershell
npm install --prefix work/native-cli @anthropic-ai/claude-code-win32-x64 --ignore-scripts
npm run test:desktop-native
```

该测试使用本机模拟的 Anthropic 接口，不调用真实付费模型。

macOS 可将包名替换为 `@anthropic-ai/claude-code-darwin-arm64` 或 `@anthropic-ai/claude-code-darwin-x64`。

## 打包

```powershell
npm run dist
```

`npm run dist`（或 `npm run dist:win`）构建 Windows 安装包；在 Mac 上运行 `npm run dist:mac` 构建 DMG 与 ZIP。安装包输出到 `release/`。GitHub Actions 会分别在 Windows、Apple Silicon Mac 和 Intel Mac 上执行测试与打包，并上传 `.exe`、`.dmg`、`.zip` 与 SHA-256 校验文件。推送 `v*` 标签时会更新对应 GitHub Release。

## 项目结构

```text
electron/           Electron 主进程、Claude Code 桥接和审批 MCP 服务
src/                React 图形界面
tests/              单元、桌面和原生桥接测试
build/              应用图标与生成脚本
.github/workflows/  Windows 与 macOS 构建、测试及发布流程
```

## 许可与声明

cc-board 使用 [MIT License](LICENSE)。本项目是独立社区项目，与 Anthropic 或 CC Switch 作者没有隶属、赞助或官方认可关系。“Claude”和“Claude Code”是其各自权利人的商标，仅用于说明兼容性。
