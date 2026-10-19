# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.7] - 2026-10-19

### 修复

- **管理面板不再列出「已从磁盘删除、却仍被宿主内存保留」的会话**：本插件删除会话时只删磁盘日志、投影缓存与工作区登记，但运行中的宿主会为「打开过、尚未释放」的会话保留 live Session，`session/list` 仍会把它返回（框架没有公开的释放 API）。侧栏默认隐藏空会话，所以这类幽灵此前只在「管理工作区与会话」面板里现形。现在面板会用新增的只读路由 `POST /dsh-sidebar-delete/sessions` 逐批询问「这些会话的日志目录还在不在」，只列磁盘上仍存在的行，并在底部提示「已从磁盘删除、只被宿主进程内存保留的会话不在这里列出；重启 dsh 后宿主会释放它们」。探测失败一律当作「不知道」——面板显示全部，绝不因探测失败藏行；当前打开的会话即使日志不在也照常显示。新路由与删除路由同一套准入（宿主 connection 门禁优先，退回 loopback + 同源围栏）、同一 64 KiB 上限，最多 512 个 id，只读、不删文件、不 emit 事件；会话根存在但不是目录时返回 500，不把所有会话误报成「已删」。
- 已知限制：侧栏里**有标题**的幽灵仍会在页面重载后回到侧栏（框架限制，本次只修管理面板），重启 dsh 后宿主释放会话即消失。
- 测试 154 个（新增 20：Host 半 7、浏览器半 12、manifest 1），全部真跑；顺带把 auto-purge 测试里两处「只注册 1 条路由」的计数断言改为 2（新增只读路由的必然影响，auto-purge 实现未动）。做了 7 个变异验证（去掉 current 豁免 → 1 红、探测失败当全不可见 → 1 红、不区分 probed 集合 → 1 红、Host 半去掉「会话根不是目录」判定 → 1 红、把 fetch 失败 / 非 200 / 坏 payload 三条失败路径各自从「未知」改成返回空 durable 集合 → 各 1 红，证明 `requestSessionDurability` 的失败路径被单测真实覆盖）。

### 新增

- **每天定时清理未分组会话（默认关闭）**：插件 config 里写 `enabled: true` 才生效，默认 `12:25`（本机时区，`time` 可配）。载体是插件内的 node 定时器：dsh 运行期间生效，关着的时候不跑，下次启动若发现今天该跑的时刻已过且当天没跑过就补跑一次，然后恢复每天一次。
- 范围按**目录**判定：会话记录里的 `cwd` 落在任何已登记工作区路径之下（含等于）即保留，它的子会话跟着保留；置顶、归档不豁免；唯一豁免是**有开着回合**的会话（跳过并计入 `skipped`）。`workspaceScope` 支持 `tree`（默认）/ `exact`。
- **安全红线**：拿不到 `workspaceRegistry`（缺失或列不出来）时**一个文件都不删**，直接返回 `no-registry`；会话列表拿不到同样不删（`no-persistence` / `list-failed`）。`enabled` 只认严格的 `true`；`time` 非法时整条配置判为无效并保持关闭（不会退回默认时间偷偷跑）。关闭状态下不读状态文件、不建定时器。
- 状态文件 `<DSH_HOME>/sidebar-delete/auto-purge.json`，只记上次跑的是哪一天（临时文件 + rename 原子写）；缺失/损坏/字段不对一律按「没跑过」处理，绝不抛。
- 新增 `src/auto-purge.mjs`（纯逻辑，无 fs/cordis：时间解析、下一次触发、补跑判定、目录归属判定、目标挑选）、`src/purge-state.mjs`（状态读写）、`test/auto-purge.test.mjs`、`test/host-plugin-autopurge.test.mjs`；Host 半导出 `purgeUngroupedOnce` / `mountAutoPurge`。
- `apply` 导出形态为 `apply(ctx, config = {})`：宿主传入的插件配置从第二个实参读取，仍是 `apply` 函数导出、不引入 default export；`test/manifest.test.mjs` 断言这一导出形式。
- 测试 134 个（原 71 + 新增 63），全部真跑临时 `$DSH_HOME` 下的文件。做了变异验证（9 个变异体，8 个被杀、1 个等价）：去掉「无 registry 就中止」→1 红、去掉「保留会话不被连带删除」→1 红、把目录边界判断换成裸字符串前缀→2 红、把 `enabled` 的严格 true 换成真值判断→1 红、把悬空父 id 不再当作删除根→1 红、把「恰好到点排到明天」改成 `>=`→1 红、让补跑忽略已跑日期→2 红、让失败的轮次也记成当天跑过→1 红、把 `mountAutoPurge` 的配置不再归一化→1 红；把 `mountAutoPurge` 里的 `!== true` 改成 `!` 不红，因为归一化后它已经是严格布尔（等价变异体）。

## [0.1.6] - 2026-10-18

### 修复

- **"没在跑却说仍在运行，删不掉"**：用户对一个回合已结束的会话点删除，收到 409。根因是 Host 判定太粗——`sessions.get(id)` 有值就拒，而框架会为"打开过但未释放"的会话保留 agent，于是闲置会话也被当成 live。现在只拒**真的有开着的回合**（读会话最后事件：最新 `turn/end` 在任何 `turn/start` 之前即空闲）；被保留但闲置的会话可以正常删除。若 agent 占着会话而事件流读不到，用独立的 `session-held` 码拒绝并提示重启后再试，不再与"在运行"混为一谈。
- 客户端：失败文案按 `session-active` / `session-held` 分流；管理面板对"当前打开的会话"直接在按钮上禁用并说明（这个信号是精确的）。**刻意没有**按 `running` 标志禁用按钮——列表快照里的 `running` 可能滞后于已结束的回合，那会让按钮一直灰着、连试都试不了，正是本次要修的那类问题的另一面。
- 文案：`error.live` 改为只说"仍在运行（或它的子会话在运行）"；新增 `error.held` 与 `manager.blockedCurrent`。
- 测试 71 个（新增/改写：开着回合拒绝、闲置且被保留可删、agent 占用但读不到→`session-held`、面板禁用逻辑），并做了变异验证：把"闲置"误判成"在跑"→1 红、"开着回合"误判成"闲置"→4 红、拿不到 agent 就当不存在→2 红。

## [0.1.5] - 2026-10-18

只补文档的补发版本：0.1.4 发布之后 README 又补了 npm 徽章和"国内镜像把 npm 的 `0.0.0-stage` staging 版本当 latest"这个坑的绕法，而 npm 包内嵌的是发布那一刻的 README。**零代码改动**，行为与 0.1.4 完全一致。

### 变更

- 包内 README 更新为含 npm 徽章、`--registry=https://registry.npmjs.org/` 绕法与坏 lockfile 提示的版本。
- 67 个测试、`node --check` ×5、打包清单均与 0.1.4 一致（仅本文件与 README 变化）。

## [0.1.4] - 2026-10-18

首个可以发到 npm 的版本（此前 `private: true` 会让 npm 直接拒发）。**已于 2026-10-18 发布：`dsh-sidebar-delete@0.1.4`**（tarball shasum `89d7f252…`，从 registry 装回的校验和与发布时一致）。

### 变更

- **打包**：去掉 `private`；加 `publishConfig`（`registry.npmjs.org` + `access: public`），避免误发到镜像；`prepublishOnly` 接 `npm run verify`，发布前强制跑语法检查、67 个单测与打包清单核对。
- **自我检查补漏**：`check` 脚本补上 `src/delete-session.mjs`——0.1.1 新增的模块此前不在检查范围里。
- **对外元数据**：包 `description` 与 `keywords` 按第三方插件写法重写；locale 的 `meta.title` / `meta.description`（插件列表里显示的就是这两项）中英各写一版，说明不可恢复与工作区能力。
- **README** 重写为对外文档：徽章、安装三条路径（Desktop 插件页 / CLI / 本地目录）、用法、删除语义、安全边界与已知弱点、兼容性、已知限制、卸载、开发与发布。

## [0.1.3] - 2026-10-18

### 修复

- **悬空的工作区成员摘不掉**（0.1.2 上线时实测发现：归档集合 8→1 清干净了，工作区成员 4 条一条没动）。原因是 `Workspace.sessionIds` 的 getter 会 `filter(id => host.candidateMatches(id, path))`，会话已不存在的 id 永远不在这个列表里，而我用它做了"只从列出该 id 的工作区里摘"的前置判断，于是永远跳过。`detachSession` 本身直接过滤原始 record、不要求 id 在列表里，`mutate` 在无变化时还会跳过写盘——所以改成对每个工作区**无条件**调用。新增测试覆盖"实体已不列出该 id 时仍被摘除"。
- **响应字段名不副实**：`registrations` 改成 `cleanupSteps`。`unarchiveSession` / `unpinSession` / `detachSession` 都返回 void，且在没有可移除引用时也正常 resolve，所以原字段报的是"清理调用成功次数"，不是"移除条数"，改名前它会误导。

## [0.1.2] - 2026-10-18

### 修复

- **删除会话后不再留下悬空登记**：0.1.1 及以前删掉的会话 id 会留在 workspace 服务的归档集合、置顶集合和工作区成员列表里。用户质疑"为什么不能清理"后复查 `@deepseek-ai/dsh-workspace/lib/index.js` 发现：`unarchiveSession`（注释明写不校验存在性）与 `Workspace.detachSession` 都能安全移除一个已不存在会话的引用，属于此前漏查的官方 API。现在删除成功后会依次调用 `unarchiveSession` / `unpinSession` / 每个工作区的 `detachSession`，并把清理步数回填到响应字段。
- 清理失败只记 warn，不会把一次成功的删除变成失败（有测试覆盖：workspace 服务抛错时仍返回 200）。
- 新增 3 条测试（66 个用例）：删除后清登记、活会话拒绝时零登记改动、服务坏掉不影响删除结果。

### 遗留数据的清法

历史遗留的悬空 id 不需要手改 `workspace.json`：对已删会话再发一次删除请求即可（文件不在 → 只清登记，幂等）。

## [0.1.1] - 2026-10-18

独立验证复核后的修正（发现者：`verifier`，逐条见下方"修复"）。

### 修复

- **裸 uuid 会话删不掉**：本机并存 `session-<uuid>` 与裸 uuid 两种会话 id，原校验只认前者，导致 teammate / 子会话 / 部分客户端创建的会话在界面上点删除只得到 400。现在两种都接受，仍拒绝 `../etc/passwd`、`a/b` 这类会当路径用的值（并在 `removeSessionFiles` 里加第二道单段校验）。
- **安全准入只用了自带围栏**：现在优先使用宿主的 `connection.requestRejection`（含浏览器登录校验），条件是该部署接受非 loopback authority；否则退回自己的 loopback + 同源围栏。Desktop loopback 部署上"不校验登录"这一弱点已在 README 里写明，不再宣称是完整围栏。
- **Host 半零测试覆盖**：新增 `test/host-plugin.test.mjs`，直接 import `index.js` 用假 ctx + 临时 `$DSH_HOME` 驱动真实 handler，覆盖路由接线、活会话拒绝（零文件改动、零广播）、父子级联、裸 uuid 单删、配置 root 优先、幂等、围栏与宿主门禁、body 上限、内部错误。
- **槽位/导入/字典守卫是走过场**：`test/manifest.test.mjs` 改为按（槽位, id, order）精确三元组校验、去注释后再校验 `ctx.slots.inject/register` 各 4 次、导入守卫兼容双引号、逐 key 逐值比对 client.js 内嵌字典与 `locale/*.json`。上述每一条都用变异测试验证过会变红。

### 变更

- 删除决策抽到 `src/delete-session.mjs`（`planDelete` / `deleteSessionBranch`），路由只做接线；新增 `test/delete-session.test.mjs`。
- 移除无调用者的 `hasDescendants`。

### 已知限制（新增/确认）

- 删掉的会话 id 会以悬空 id 形式留在 `workspace.json`（宿主没有注销单条会话的 API）；真实清理后已归档 8 条中 7 条悬空。
- 会话目录删除后，项目目录（`--<cwd>--`）会留下空壳。
- 级联删除只在单测与打桩里验证过，未用真实父子会话跑端到端。

## [0.1.0] - 2026-10-18

### 新增

- 会话行悬停垃圾桶图标，以及会话行 "…" 菜单里的「删除会话」：删除本地会话日志目录与投影缓存记录，子会话（fork / subagent）级联删除；删除后通过 `api-session/removed` 让侧栏即时摘行，不需要刷新页面。
- 侧栏底部常显入口与「管理工作区与会话」面板：删除工作区（官方语义，保留文件夹与会话）、按工作区 / 未分组逐条删除会话、把未分组目录注册为工作区。
- Host 半 `POST /dsh-sidebar-delete/session`：请求围栏、活会话与当前会话拒绝、部分失败如实汇报、同 id 并发单飞。
- 单元测试覆盖请求围栏、文件清理与删除决策；GitHub Actions 跑 `check` + `test` + `pack:check`。
