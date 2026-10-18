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
- 同时退休该会话在 workspace 服务里的登记：归档集合（`unarchiveSession`）、置顶集合（`unpinSession`）、以及每个工作区的成员列表（`Workspace.detachSession`）。这三条都是官方 API，且都不校验会话是否存在——移除引用不可能引入未知 id，所以它们正好能清掉一个已经不存在的会话。
- 不动：附件字节（内容寻址，可能被别的会话引用）

会**拒绝**删除并保持零改动的情况：会话正在运行、是当前打开的会话、或它的某个子会话还活着。删除**不可恢复**。

## 安全边界（含已知弱点）

Host 半只发布一条路由 `POST /dsh-sidebar-delete/session`，准入顺序是：

1. 仅接受 `POST` + `application/json`，body 上限 64 KiB（先判这些，再谈信任）。
2. 如果宿主提供了 `connection.requestRejection` **且**该部署接受非 loopback authority（`allowsRemoteAuthorities === true`），就由宿主自己的门禁裁决——它同时做 Host/Origin 校验和浏览器登录校验；门禁返回什么就答什么，抛异常按拒绝处理。
3. 否则退回本插件自己的围栏：`Host` 必须是 loopback（或在 `connection.trustedHosts` 里声明过——这个列表不在 `connection` 的服务契约里，读不到时等价于只允许 loopback），`Origin` 存在时必须与 `Host` 同源，缺失允许（Desktop 载体转发时会剥掉它）。

**已知弱点，别当成完整围栏**：在 loopback-only 的 Desktop 部署上，这条路由**不校验宿主登录**——`requestRejection` 的浏览器认证那一半在 Desktop 载体上未被实测，贸然启用有可能把页面自己挡在门外（同 profile 的 `dshmarket` 记录了同样的空白）。因此在这一部署上，任何**本机进程**都能调用它；同 uid 的进程本来就能直接读写这些会话文件，所以对单用户机器不构成提权，但**多用户机器上这是真实弱点**。想要更严，可在支持 `authorizesRemoteAuthorities` 的部署上启用第 2 条，或把删除能力收进宿主自己的命令体系。

另外：不碰别的插件的存储、不删附件、不往 `document.body` 写 DOM、不读别的插件的 DOM；刻意**不**给模型提供对应的 tool——删除本地会话日志是用户级、不可恢复的动作，只该由人在界面上确认。

## 会话 id 的两种形状

同一台机器上并存两种 id：Web 客户端建的 `session-<uuid>`，以及 teammate / 子会话 / 部分客户端建的**裸 uuid**（例如 `907e1e16-…`）。路由两样都接受（仍拒绝 `../etc/passwd`、`a/b` 这类会当路径用的值）。0.1.1 之前只认前者，导致裸 uuid 的会话在界面上点删除会失败——那是已修的缺陷。


## 安装

1. 用插件管理器安装本目录（Harness 的插件页面，或让 agent 用 `plugin_manager` 的 `install_bundle`，`target` 指向本目录绝对路径）。
2. 手动等价步骤：`dsh plugin --profile <profile> add <本目录绝对路径>`，再把包名 `dsh-sidebar-delete` 加进该 profile `package.json` 的 `dsh.profile.bundles`。
3. 刷新页面让浏览器半加载。

卸载：`plugin_manager` 的 `remove_bundle`（或从 `dsh.profile.bundles` 里移除）后刷新页面即可，包目录可以留着。**已删除的会话日志不会回来**，这是本功能的语义。

## 适配与已知风险

在 dsh `0.2.1-rc.2`（`@deepseek-ai/dsh-client-ui-workspace@0.2.1-rc.2`）上开发与实测。它用到两件框架没有公开承诺的东西——会话日志的磁盘布局、以及 `api-session/removed` 事件（用来让侧栏即时摘行）——dsh 升级后可能失效。失效时只影响删除本身，不影响侧栏其它功能；升级后先跑一遍 `npm run verify`。

日志根目录会优先从已挂载的 `session-persistence-jsonl` 行配置里读，读不到才回退到 `$DSH_HOME/sessions`。

其余已知残留（都在真实使用中观察到了，不是理论问题）：

- 0.1.2 之前删掉的会话会在 `workspace.json` 里留下悬空 id（`archivedSessionIds` / 工作区 `sessionIds`）。**0.1.2 起删除时会一并清掉**；历史遗留的清法是"对已经删掉的会话再发一次删除请求"——文件已经不在，只会走到清登记那一步，幂等。
- 会话自己的目录会被删，但它所在的项目目录（`--<cwd>--`）会留下一个空壳，和框架自己的行为一致。
- 级联删除依赖 `sessionPersistence.list()` 的快照里带 `header.parentSession`；该字段是契约里明写的，但只在单测与打桩里验证过级联，没有用真实的"父子都存在的会话"跑过端到端。
- 活会话拒绝、`api-session/removed` 广播、删除编排现在有 `test/host-plugin.test.mjs` 直接驱动 `index.js` 覆盖（假 ctx + 临时 `$DSH_HOME`）；改这几处时别把那个测试一起改绿。


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

Deleting a session also deletes its child sessions (forks and subagents). Live, open, or parent-of-a-live session requests are refused with zero changes. Attachments and other plugins' storage are never touched.

Two session-id shapes exist on one machine — `session-<uuid>` and a bare uuid (teammates, subagents, some client-created sessions) — and both are accepted. The Host half publishes exactly one route: `POST` only, JSON only, 64 KiB cap, then the host's own `connection.requestRejection` gate where the deployment accepts remote authorities, otherwise this plugin's own loopback + same-origin fence. On a loopback-only Desktop deployment that route does **not** check the harness login (the gate's authentication half is unmeasured for that carrier), so any local process can call it; same-user processes can already read and write those session files. Treat it as a local tool, not a hardened multi-user service.

No model-facing tool is registered on purpose: this is a user-only, irreversible action.

Install with the plugin manager (`install_bundle` pointing at this directory), or manually with `dsh plugin --profile <profile> add <dir>` plus `dsh-sidebar-delete` in that profile's `dsh.profile.bundles`. Developed and verified against dsh `0.2.1-rc.2`.
