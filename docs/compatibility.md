# 兼容矩阵

历史探针矩阵覆盖官方 `@deepseek-ai/dsh` rc.6 / rc.7 / rc.8。当前 `0.2.0` 完整动态推理组合只在 **精确 rc.8** 上主张兼容，并要求同一 Host 进程提供 `dsh-plugin-auxiliary-runtime@0.1.0`。旧探针结果不自动升级为生产组合声明。

2026-08-21 的发布前标签快照：`latest=0.1.0-rc.7`、`next=0.1.1-rc.1`。动态标签只用于发现回归；当前完整动态组合既不跟随 `latest`，也不声明兼容 `next`，唯一已验证 Host 仍是精确 `0.1.0-rc.8`。标签变化后以 `npm view @deepseek-ai/dsh dist-tags` 为准。

rc.6 元包声明 `^0.1.0-rc.6` 组件，今天会解析到 rc.7 的 base/typert/web。分版本报告必须同时记录请求的元包、观察到的 CLI、以及实际解析的组件图，不得把该 lane 写成“纯 rc.6”。

公开表只把实际跑过第 11 节合同的精确版本标为“已验证”。`latest` / `next` 是动态发现，不是对未发布版本的保证。对尚未发布的未来版本只使用公开能力探测、包内版本化适配器和安全降级。

Clarify `0.2.0` 的六个 Remote 方法公开返回 `clarify.wire/1` 内层结果联合，作为官方 Gateway 外层成功值。SeekTTY `1.2.0` 必须先认 `protocol` 再认 echo；目录启发式可以显示旧六方法 Host，但激活要求 `fetchDraft` 与 `refine` 同时给出外层成功 + 内层 v1 `PROCESS_NOT_FOUND`。2026-08-21 已在未修改的官方 rc.8、隔离 `DSH_HOME` 和真实 PTY 上完成三项目安装、启动、移除重装、动态多轮、采用但不发送、用量来源与隐私检查；远端发布仍必须通过各仓 PR CI、合并后打包和发布后再安装验收。

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

历史观察与当前发布口径：

- 历史 T0 在 rc.6/rc.7/rc.8 观察到直接官方 auxiliary usage/route 缝隙不足；这些报告保留为证据，不再用隐藏 Session 或伪造 projection 绕过。
- 当前架构把 auxiliary usage/limits/cancel 明确交给独立社区插件：官方 `tokenUsage` 仍只归 Agent loop，独立 ledger 通过官方 `storageDomain` 持久化，Clarify 只消费同进程 `auxiliaryRuntime`。
- 空白 Session 的路由从公开 `agentDefaultModel.currentSelection()` 获取；已有 request header 永远优先，有历史但缺 header 时 fail closed。请求与 reservation 从 `prepareCall` 后的物化配置/context window 原子构造，token 限额在 stream 前二次准入。
- Host T3 信封完整回合可以「通过」，但所用 Session 是隔离探针夹具，不是生产插件创建。
- T1 add/boot/remove/re-add 的 standalone lifecycle 与三包联合 lifecycle 均已通过；真实 `/doctor` 为零错误零警告，动态问题/选项/预览、逐答演进、审阅采用后仅填入输入框、重启恢复、官方 `tokenUsage` 不变和 auxiliary 独立持久化均已观察。
- 这些结论只覆盖精确 rc.8 联合栈。历史 T0 阻塞报告仍是当时“官方同名 usage/limits/cancel 投影不可用”的有效证据；当前社区 auxiliary 域没有把它们改写成官方能力。`latest` / `next` 仍只是动态发现。
