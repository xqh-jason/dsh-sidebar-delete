# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.2] - 2026-10-18

### 修复

- **删除会话后不再留下悬空登记**：0.1.1 及以前删掉的会话 id 会留在 workspace 服务的归档集合、置顶集合和工作区成员列表里。用户质疑"为什么不能清理"后复查 `@deepseek-ai/dsh-workspace/lib/index.js` 发现：`unarchiveSession`（注释明写不校验存在性）与 `Workspace.detachSession` 都能安全移除一个已不存在会话的引用，属于此前漏查的官方 API。现在删除成功后会依次调用 `unarchiveSession` / `unpinSession` / 每个工作区的 `detachSession`，并把退休条数回填到响应的 `registrations` 字段。
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
