# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-18

### 新增

- 会话行悬停垃圾桶图标，以及会话行 "…" 菜单里的「删除会话」：删除本地会话日志目录与投影缓存记录，子会话（fork / subagent）级联删除；删除后通过 `api-session/removed` 让侧栏即时摘行，不需要刷新页面。
- 侧栏底部常显入口与「管理工作区与会话」面板：删除工作区（官方语义，保留文件夹与会话）、按工作区 / 未分组逐条删除会话、把未分组目录注册为工作区。
- Host 半 `POST /dsh-sidebar-delete/session`：请求围栏（loopback 或已声明 authority、同源 Origin、仅 JSON、64 KiB 上限）、活会话与当前会话拒绝、部分失败如实汇报、同 id 并发单飞。
- 单元测试覆盖请求围栏与文件清理（含部分失败与幂等）；GitHub Actions 跑 `check` + `test` + `pack:check`。

### 已知限制

- 会话日志的磁盘布局与 `api-session/removed` 事件都不是公开 API，dsh 升级后可能失效（失效时只影响删除功能）。
- 删除会话后 `workspace.json` 会留下该会话的悬空 id（无害，但会长期累积）。
- 侧栏没有工作区级别的扩展槽，所以工作区删除入口放在侧栏底部面板里，而不是分组标题行上。
