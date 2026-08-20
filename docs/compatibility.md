# 兼容矩阵

最低基线是官方 `@deepseek-ai/dsh@0.1.0-rc.6`。合同矩阵是 **pinned release lanes rc.6 / rc.7 / rc.8**，再加上执行时 npm `latest`，并在 `next ≠ latest` 时加跑官方 `next`。去重后每个精确版本只跑一次。

2026-08-20 的标签快照：`latest=0.1.0-rc.7`、`next=0.1.0-rc.8`。此时动态标签与 pinned rc.7/rc.8 重合，精确集合仍是 rc.6 / rc.7 / rc.8。标签变化后以 `npm view @deepseek-ai/dsh dist-tags` 为准。

rc.6 元包声明 `^0.1.0-rc.6` 组件，今天会解析到 rc.7 的 base/typert/web。分版本报告必须同时记录请求的元包、观察到的 CLI、以及实际解析的组件图，不得把该 lane 写成“纯 rc.6”。

公开表只把实际跑过第 11 节合同的精确版本标为“已验证”。`latest` / `next` 是动态发现，不是对未发布版本的保证。对尚未发布的未来版本只使用公开能力探测、包内版本化适配器和安全降级。

| 合同 | 命令 |
| --- | --- |
| 解析并去重矩阵 | `pnpm t0:matrix` / `pnpm t1:matrix` |
| 精确版本 T0 | `pnpm t0 -- --dsh-version <ver>` |
| 动态 latest / next | `pnpm t0:latest` / `pnpm t0:next` |
| T2 状态机单测 | `pnpm test`（与 dsh 版本无关） |
| T3 进程内 Remote 对象冒烟 | `pnpm t3`（不是官方 Host T3，不能代替矩阵里的 Host T3） |
| T3 Host Remote | 随 T0 在隔离 Host 上实跑 `POST /api/clarify/<method>`；DIY 静态 HTML 不算交互通过。Session 若来自本轮探针，必须标 `source=t0-probe-test-fixture`、`createdByHarness=true`、`productionPluginCreated=false` |
| T1 安装合同 | `pnpm t1` / `pnpm t1:matrix`。standalone lifecycle 与 cross-project doctor 分开记账。standalone 通过不是 T1 完全通过；`/doctor` 待 Task B 既有本地命令联调 |

现场证据目录：`docs/t0-evidence/<dsh-version>/`。闸门结论：`docs/t0-evidence/<dsh-version>/t0-blocking-report.md`。T1 结论：`docs/t0-evidence/<dsh-version>/t1-report.md`。索引见 `docs/t0-blocking-report.md`。

当前观察到的合同（以各版本报告为准，不是全绿）：

- T0 (a)/(c) 在已跑过的 rc.6/rc.7/rc.8 上可行；(b)/(d) **阻塞**。因此这些版本的 T4+ 停止。
- Host T3 信封完整回合可以「通过」，但所用 Session 是隔离探针夹具，不是生产插件创建。
- T1 add/boot/remove/re-add 可以单独记为 standalone lifecycle **通过**。任务书 `/doctor` 零错误零警告列为 final cross-project acceptance，当前 **待联调**；在联调证据存在前不得把 T1 写成完全通过。stock dsh 无 CLI/HTTP doctor 不是 Clarify standalone 阻塞，也不使本仓库 CI 永久红。
- 公开表不得把上述阻塞写成已验证或全绿。`latest` / `next` 只是动态发现。
