# dsh-sidebar-delete

[![ci](https://github.com/xqh-jason/dsh-sidebar-delete/actions/workflows/ci.yml/badge.svg)](https://github.com/xqh-jason/dsh-sidebar-delete/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-sidebar-delete.svg)](https://www.npmjs.com/package/dsh-sidebar-delete)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）Web 侧栏补上**删除**：会话可以真删（连带本地日志、投影缓存与工作区登记，子会话级联），工作区与未分组会话有一个常显的管理入口。

Delete sessions for real from the dsh sidebar — local logs, projection cache, and workspace-registry references included, child sessions cascading — plus a persistent manager for workspaces and ungrouped sessions.

零运行时依赖：一个 Host 路由 + 四个槽位注册。

## 功能

- **删除会话**：会话行悬停出现垃圾桶图标，会话行 "…" 菜单里也有一行「删除会话」。确认后删除本地会话日志目录与投影缓存，并从侧栏**即时移除**（不用刷新页面）。**不可恢复。**
- **管理面板**：侧栏底部（设置旁）常显入口。按工作区列出会话、按目录列出未分组会话，逐条可删；未分组的目录可一键「注册为工作区」。
- **删除工作区**：沿用官方语义——只注销工作区登记，文件夹与会话全部保留，其会话落到「未分组」。
- **每行可辨识**：标题取真正持久化的会话标题（无标题显示「未命名会话」，不再回退成目录名），副行是短 id + 本地时间；徽标区分「当前打开 / 运行中 / 子代理 / 空会话」；子代理与 fork 子会话嵌在父会话下面，父行标出「含 N 条子会话」。

## 为什么需要它

dsh 自带的工作区删除入口藏在工作区分组标题的悬停菜单里（而且要先收起分组才容易点到），会话则只有「归档」、没有删除；框架层面也没有删除会话的 API（`dsh-session-persistence-jsonl` 的 README 写着 *Nothing deletes session files … the seam has no deletion API*，`ui-workspace` 的已知限制写着 *No Session deletion*）。这个插件把这两件事补齐，并把入口放到任何分组状态、任何侧栏宽度下都点得到的地方。

## 安装

已发布在 npm：[dsh-sidebar-delete](https://www.npmjs.com/package/dsh-sidebar-delete)（当前 `0.1.4`）。包名就是 bundle 名，装完出现在插件列表里。

Harness Desktop / Web 里：**设置 → 插件**，装这个包（插件管理器会从 npm 拉取，并把它写进 profile 的 `dsh.profile.bundles`）。

命令行（CLI 管理的 profile）：

```bash
dsh plugin --profile <profile> add dsh-sidebar-delete
```

> Desktop 用的 `desktop` profile 由 Electron app 独占，CLI 会拒绝 `--profile desktop`；桌面上请走 app 内的插件页。

> **国内镜像的坑**：npm 发布时会在 registry 留下一个 `0.0.0-stage` 的 staging 版本（340 字节的占位，tarball 是截断的）。`registry.npmmirror.com` 偶尔会把这个 staging 版本当成 `latest` 缓存下来，此时 `pnpm add` 会报 `ERR_PNPM_TARBALL_EXTRACT`。绕法二选一：加 `--registry=https://registry.npmjs.org/` 装一次；或删掉该 profile 里的 `pnpm-lock.yaml` 后重试（坏 lockfile 会一直钉在 staging 版本上）。官方源的 `dist-tags.latest` 是对的（`0.1.4`）。

装完**重启 dsh**：Host 半只在启动时加载，改它必须重启；只改浏览器半刷新页面即可。

从本地目录装（开发用）：让插件管理器指定该目录，或 `dsh plugin --profile <profile> add /绝对路径`——本地目录是链接安装，改代码不用重装。

## 用法

- 会话行悬停 → 垃圾桶图标；或 "…" 菜单 → 「删除会话」。确认框写明标题、不可恢复、以及会连带删掉几条子会话。
- 侧栏底部「管理工作区与会话」→ 每个工作区一行（标题 / 路径 / 会话数），下面是它的会话；末尾「未分组」按目录列会话。每行右侧可删；未分组目录旁可「注册为工作区」。
- 「当前打开的会话」不显示删除入口；运行中的会话仍显示，但 Host 会拒绝并说明原因。

## 它删了什么

删除一个会话（**连同它的子会话**：fork 与 subagent）时：

- 删除 `<DSH_HOME>/sessions/<项目目录>/<sessionId>/`（`session.vN.jsonl.zstd` 与 `session.lock`）
- 删除 `<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json`
- 退休该会话在 workspace 服务里的登记：归档集合（`unarchiveSession`）、置顶集合（`unpinSession`）、每个工作区的成员列表（`Workspace.detachSession`）。这三条都是官方 API，且都不校验会话是否存在——移除引用不可能引入未知 id。
- 不动：附件字节（内容寻址，可能被别的会话引用）、别的插件的存储、任何会话之外的目录。

会**拒绝**删除并保持零改动：会话正在运行、是当前打开的会话、或它的某个子会话还活着。

## 安全边界（含已知弱点）

Host 半只发布一条路由 `POST /dsh-sidebar-delete/session`，准入顺序：

1. 仅 `POST` + `application/json`，body 上限 64 KiB（先判这些，再谈信任）。
2. 若宿主提供 `connection.requestRejection` **且**该部署接受非 loopback authority（`allowsRemoteAuthorities === true`），由宿主自己的门禁裁决（含 Host/Origin 校验与浏览器登录校验）。
3. 否则退回插件自己的围栏：`Host` 必须 loopback，`Origin` 存在时须与 `Host` 同源（缺失允许——Desktop 载体转发会剥掉它）。

**已知弱点**：loopback-only 的 Desktop 部署上这条路由**不校验宿主登录**（`requestRejection` 的认证半段在 Desktop 载体上未被实测，贸然启用可能把页面自己挡出去；同 profile 的 `dshmarket` 记录了同样的空白）。因此在该部署上任何**本机进程**都能调用它——同 uid 进程本来就能直接读写这些会话文件，对单用户机器不构成提权，但**多用户机器上是真实弱点**。

另外：不往 `document.body` 写 DOM、不读别的插件的 DOM、不 require 任何 Harness Client 包（图标/按钮/弹窗自绘，只吃主题 token）；刻意**不**给模型提供对应 tool——删本地会话日志是用户级、不可恢复的动作。

## 兼容性

在 dsh `0.2.1-rc.2`（`@deepseek-ai/dsh-client-ui-workspace@0.2.1-rc.2`）上开发与实测，Node ≥ 22.19。

它用到两件框架没有公开承诺的东西——**会话日志的磁盘布局**、以及 **`api-session/removed` 事件**（用来让侧栏即时摘行）。dsh 升级后可能失效；失效时只影响删除本身，不影响侧栏其它功能。日志根目录优先从已挂载的 `session-persistence-jsonl` 行配置里读，读不到才回退 `$DSH_HOME/sessions`。

## 已知限制

- 归档集合在**启动时不会**自动剪掉会话已不存在的 id（工作区成员会）。插件在删除时会清掉两者；若会话是在别的进程或外部被删的，登记仍在——对那个 id 再发一次删除请求即可（幂等，只清登记）。
- 会话目录删除后，它所在的项目目录（`--<cwd>--`）会留下空壳，与框架自身行为一致。
- 级联删除依赖 `sessionPersistence.list()` 快照里的 `header.parentSession`：已在单测与打桩里覆盖，但没有用真实父子会话跑过端到端。
- 没有批量删除，一次一条；也没给模型任何 tool。

## 卸载

在插件管理器里移除 `dsh-sidebar-delete`（或从 profile 的 `dsh.profile.bundles` 移除）后重启。包目录可以留着。**已删除的会话日志不会回来**，这是本功能的语义。

## 开发与发布

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"   # Node ≥ 22.19
npm run verify          # node --check ×5 + node --test（67 个用例）+ npm pack --dry-run
```

目录：`index.js`（Host 半）、`client.js`（浏览器半，Module Loader 包，无构建）、`src/`（纯逻辑，可单测）、`test/`、`locale/`、`icon.svg`。

发布（维护者）：`npm publish` 会先跑 `prepublishOnly` → `npm run verify`，再按 `publishConfig`（`registry.npmjs.org`、`access: public`）上传。出现在 dsh 的插件市场里还需要进市场的目录索引——那是外部维护的清单，npm 发布本身不带你进店。

## License

MIT © 2026 xqh-jason

---

## English

`dsh-sidebar-delete` adds two things to the DeepSeek Harness Web sidebar: **real session deletion** (a trash icon on the hovered row, plus a `Delete session` row in its "…" menu) and a **persistent manager** at the sidebar foot for workspaces and ungrouped sessions.

Deleting a session removes its log directory, its projection-cache record, and its references in the workspace service (archive set, pin set, per-workspace accounting), then mirrors `api-session/removed` so the row disappears without a reload. Child sessions (forks and subagents) cascade; live, currently-open, or parent-of-a-live requests are refused with zero changes. Attachments and other plugins' storage are never touched. Two session-id shapes are accepted (`session-<uuid>` and bare uuid).

The Host half publishes exactly one route: `POST` only, JSON only, 64 KiB cap, then the host's own `connection.requestRejection` where the deployment accepts remote authorities, otherwise this plugin's loopback + same-origin fence. On a loopback-only Desktop deployment that route does **not** check the harness login (the gate's authentication half is unmeasured for that carrier), so treat it as a local tool, not a hardened multi-user service. No model-facing tool is registered on purpose: this is a user-only, irreversible action.

Zero runtime dependencies. Install with the plugin manager or `dsh plugin --profile <profile> add dsh-sidebar-delete`, then restart dsh — the Host half only loads at boot. Developed and verified against dsh `0.2.1-rc.2`.
