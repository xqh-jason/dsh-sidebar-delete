# dsh-sidebar-delete

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）Web 侧栏补上删除能力：

- **删除会话（真删除）**：会话行悬停出现垃圾桶图标，会话行 "…" 菜单里也有一行「删除会话」。确认后删除本地会话日志与投影缓存，并从侧栏**即时移除**（不需要刷新页面）。**不可恢复。**
- **管理工作区与会话**：侧栏底部（设置旁）常显入口，打开面板可以删除工作区（沿用官方语义：只注销工作区，文件夹与会话全部保留，其会话落到「未分组」），并按工作区 / 未分组逐条删除会话；未分组的目录还能一键「注册为工作区」。

## 为什么需要它

dsh 自带的工作区删除入口藏在工作区分组标题的悬停菜单里（而且要先收起分组才容易点到），会话则只有「归档」、没有删除；框架层面也没有删除会话的 API（`dsh-session-persistence-jsonl` 的 README 写着 *Nothing deletes session files … the seam has no deletion API*，`ui-workspace` 的已知限制写着 *No Session deletion*）。这个插件把这两件事补齐，并且把入口放到任何分组状态、任何侧栏宽度下都点得到的地方。

## 它到底删了什么

删除一个会话时（**连同它的子会话**，即 fork / subagent 会话）：

- 删除 `<DSH_HOME>/sessions/<项目目录>/<sessionId>/`（`session.vN.jsonl.zstd` 与 `session.lock`）
- 删除 `<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json`
- 不动：附件字节（内容寻址，可能被别的会话引用）、`workspace.json` 里该会话的登记项（会留下悬空 id，无害但脏）

会**拒绝**删除并保持零改动的情况：会话正在运行、是当前打开的会话、或它的某个子会话还活着。删除**不可恢复**。

## 安全边界

- Host 半只发布一条路由 `POST /dsh-sidebar-delete/session`：只接受 `Host` 为 loopback 或部署已声明 authority 的请求，跨站 `Origin` 拒绝，`Origin` 缺失允许（Desktop 载体转发时会剥掉它），只收 `application/json`，body 上限 64 KiB。
- 不碰别的插件的存储、不删附件、不往 `document.body` 写 DOM、不读别的插件的 DOM。
- 刻意**不**给模型提供对应的 tool：删除本地会话日志是用户级、不可恢复的动作，只该由人在界面上确认。

## 安装

1. 用插件管理器安装本目录（Harness 的插件页面，或让 agent 用 `plugin_manager` 的 `install_bundle`，`target` 指向本目录绝对路径）。
2. 手动等价步骤：`dsh plugin --profile <profile> add <本目录绝对路径>`，再把包名 `dsh-sidebar-delete` 加进该 profile `package.json` 的 `dsh.profile.bundles`。
3. 刷新页面让浏览器半加载。

卸载：`plugin_manager` 的 `remove_bundle`（或从 `dsh.profile.bundles` 里移除）后刷新页面即可，包目录可以留着。**已删除的会话日志不会回来**，这是本功能的语义。

## 适配与已知风险

在 dsh `0.2.1-rc.2`（`@deepseek-ai/dsh-client-ui-workspace@0.2.1-rc.2`）上开发与实测。它用到两件框架没有公开承诺的东西——会话日志的磁盘布局、以及 `api-session/removed` 事件（用来让侧栏即时摘行）——dsh 升级后可能失效。失效时只影响删除本身，不影响侧栏其它功能；升级后先跑一遍 `npm run verify`。

另外，日志根目录会优先从已挂载的 `session-persistence-jsonl` 行配置里读，读不到才回退到 `$DSH_HOME/sessions`。

## 开发

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"   # Node ≥ 22.19
npm run verify     # node --check ×2 + node --test + npm pack --dry-run
```

目录：`index.js`（Host 半）、`client.js`（浏览器半，Module Loader 包）、`src/`（纯逻辑，可单测）、`test/`、`locale/`、`icon.svg`。

## License

MIT © 2026 xqh-jason

---

## English

`dsh-sidebar-delete` adds two things to the DeepSeek Harness Web sidebar:

- **Delete a session for real**: a trash icon on the hovered session row and a `Delete session` row in its "…" menu. Confirming removes the local session log directory and its projection-cache record, and the row disappears immediately (no page reload). **Irreversible.**
- **Manage workspaces & sessions**: a persistent entry at the sidebar foot opens a panel that deletes workspaces (official semantics: the registration only — folder and sessions are kept and fall under "Ungrouped"), lists sessions per workspace and per ungrouped directory with per-row delete, and registers an ungrouped directory as a workspace.

Why: the shipped workspace delete lives behind a hover menu on the group header (and is easiest to reach with the group collapsed), sessions can only be archived, and the framework has no session-deletion API at all.

Deleting a session also deletes its child sessions (forks and subagents). Live, open, or parent-of-a-live session requests are refused with zero changes. Attachments and other plugins' storage are never touched. The Host half publishes exactly one route, fenced to loopback-or-declared authorities with same-origin and JSON-only checks. No model-facing tool is registered on purpose: this is a user-only, irreversible action.

Install with the plugin manager (`install_bundle` pointing at this directory), or manually with `dsh plugin --profile <profile> add <dir>` plus `dsh-sidebar-delete` in that profile's `dsh.profile.bundles`. Developed and verified against dsh `0.2.1-rc.2`.
