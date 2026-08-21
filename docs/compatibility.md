# 兼容矩阵

## 0.2.2 目标（未发布）

Clarify `0.2.2` 的生产目标是精确官方 `@deepseek-ai/dsh@0.1.1-rc.2` + 同进程 `dsh-plugin-auxiliary-runtime@0.1.1`。`0.1.0-rc.8` 仍作为 admission pin，可与 Auxiliary `0.1.0` 或 `0.1.1` 配对。rc.6 / rc.7 只保留为历史探针车道，不是 `0.2.2` 生产组合。配对规则只写在文档与矩阵说明里，不进入 wire / 公共 API。

`docs/t0-evidence/0.1.1-rc.1/` 是同日被替换版本 `0.1.1-rc.1` 的历史观察，不得覆写或删除，也不得代替 `0.1.1-rc.2`。生产 pin 与默认 `PINNED_CONTRACT_VERSIONS` 不含 rc.1；`pnpm t0:dsh011rc1` / `pnpm t1:dsh011rc1` 只作历史复现。

`0.1.1-rc.2` 独立合同已由本轮精确 lane 实跑，结论只记观察值，不是完整动态组合，也不是完整联合验收：

- T0：CLI `0.1.1-rc.2`，base `0.1.1-rc.2`，非混合树；(a) 可行、(b) 阻塞、(c) 可行、(d) 阻塞。Host T3 信封 live，但回合因 `INFERENCE_UNAVAILABLE`（隔离 Host 未装 Auxiliary，未授权真实推理）阻塞。Session `source=t0-probe-test-fixture`。证据：`docs/t0-evidence/0.1.1-rc.2/`。
- standalone T1：add / boot / remove / re-add 通过；cross-project `/doctor` 待联调；T1 完全通过未完成。证据：`docs/t0-evidence/0.1.1-rc.2/t1-report.md`。该「待联调」只表示 T1 脚本未跑 cross-project doctor。
- 三项目 Lane A（2026-08-21，未修改 stock `0.1.1-rc.2`、隔离 `DSH_HOME`、真实 PTY、候选 Clarify `0.2.2` + Auxiliary `0.1.1` + SeekTTY `1.2.1`）：`/doctor` 0 error / 0 warning、99 plugins running；`/status` 健康；`/clarify` 路由到 Auxiliary 后无 key 返回 `MISSING_CREDENTIAL` 且保留 composer；Vision-Exp 可见且可选择；PNG 附件 `/restart` 成功恢复。丢失源文件恢复：单测保证失败文案只用 basename、覆盖两种通知顺序、绝对路径不进文案；真实 PTY hardcopy/可见区扫描只检出 ASCII basename `vision-logo.png`，未检出 `private/tmp`、`/tmp`、`Users`、`Volumes`。不能证明关闭无 key onboarding modal 后该 restore error 仍持续显示（Esc 也会清 notice）。不是 Release。
- Lane B 仍阻断：缺 `DEEPSEEK_API_KEY`，尚未真实完成 Clarify 成功动态多轮、accept 回 composer 且不自动发送、PNG 与 JPEG 视觉理解、成功发送后附件清除。
- 本轮未跑全矩阵。

公开表只把实际跑过第 11 节合同的精确版本标为“已验证”。`latest` / `next` 是动态发现，与 pin 重复时按精确版本去重，不是对未发布版本的保证。对尚未发布的未来版本只使用公开能力探测、包内版本化适配器和安全降级。

| 合同 | 命令 |
| --- | --- |
| 解析并去重矩阵 | `pnpm t0:matrix` / `pnpm t1:matrix` |
| 精确版本 T0 | `pnpm t0 -- --dsh-version <ver>` |
| 精确 `0.1.1-rc.2` | `pnpm t0:dsh011rc2` / `pnpm t1:dsh011rc2` |
| 历史复现 `0.1.1-rc.1` | `pnpm t0:dsh011rc1` / `pnpm t1:dsh011rc1`（不是生产 pin，不能代替 rc.2） |
| 动态 latest / next | `pnpm t0:latest` / `pnpm t0:next` |
| T2 状态机单测 | `pnpm test`（与 dsh 版本无关） |
| T3 进程内 Remote 对象冒烟 | `pnpm t3`（不是官方 Host T3，不能代替矩阵里的 Host T3） |
| T3 Host Remote | 随 T0 在隔离 Host 上实跑 `POST /api/clarify/<method>`；DIY 静态 HTML 不算交互通过。Session 若来自本轮探针，必须标 `source=t0-probe-test-fixture`、`createdByHarness=true`、`productionPluginCreated=false` |
| T1 安装合同 | `pnpm t1` / `pnpm t1:dsh011rc2` / `pnpm t1:matrix`。`pnpm t1:dsh011rc1` 只复现历史 rc.1。standalone lifecycle 与 cross-project doctor 分开记账。standalone 通过不是 T1 完全通过；`/doctor` 待 Task B 既有本地命令联调 |

现场证据目录：`docs/t0-evidence/<dsh-version>/`。闸门结论：`docs/t0-evidence/<dsh-version>/t0-blocking-report.md`。T1 结论：`docs/t0-evidence/<dsh-version>/t1-report.md`。索引见 `docs/t0-blocking-report.md`。第四 pinned lane `0.1.1-rc.2` 只有命令真实写出后才进入该目录与矩阵摘要，不手写伪造。`docs/t0-evidence/0.1.1-rc.1/` 保留为同日被替换版本的历史观察。

## 历史 0.2.1 / 0.2.0（已发布）

历史探针矩阵覆盖官方 `@deepseek-ai/dsh` rc.6 / rc.7 / rc.8。`0.2.1` 是相对已发布 `0.2.0` 的 **prompt 序列化-only 补丁**：完整动态推理组合仍只继承 **精确 rc.8** 兼容主张，并要求同一 Host 进程提供 `dsh-plugin-auxiliary-runtime@0.1.0`。旧探针结果不自动升级为 `0.2.2` 生产组合声明。

2026-08-21 的发布前标签快照：`latest=0.1.0-rc.7`、`next=0.1.1-rc.1`。动态标签只用于发现回归；当时完整动态组合既不跟随 `latest`，也不声明兼容 `next`，唯一已验证 Host 仍是精确 `0.1.0-rc.8`。标签变化后以 `npm view @deepseek-ai/dsh dist-tags` 为准。

rc.6 元包声明 `^0.1.0-rc.6` 组件，今天会解析到 rc.7 的 base/typert/web。分版本报告必须同时记录请求的元包、观察到的 CLI、以及实际解析的组件图，不得把该 lane 写成“纯 rc.6”。

Clarify `0.2.1` 继承 `0.2.0` 的公开 Remote 合同与兼容边界：六个方法公开返回 `clarify.wire/1` 内层结果联合，作为官方 Gateway 外层成功值；边界仍是精确官方 `@deepseek-ai/dsh@0.1.0-rc.8` + `dsh-plugin-auxiliary-runtime@0.1.0` + SeekTTY `1.2.0`。SeekTTY `1.2.0` 必须先认 `protocol` 再认 echo；目录启发式可以显示旧六方法 Host，但激活要求 `fetchDraft` 与 `refine` 同时给出外层成功 + 内层 v1 `PROCESS_NOT_FOUND`。该边界来自 2026-08-21 在未修改官方 rc.8、隔离 `DSH_HOME` 和真实 PTY 上完成的三项目联合验收。`0.2.1` 只改 prompt 序列化，发布前未完成新的真实 Provider A/B；Release 后须重新下载资产、核对校验和并重做关键验收，此前不主张该项证据已闭合。

历史观察与当时发布口径：

- 历史 T0 在 rc.6/rc.7/rc.8 观察到直接官方 auxiliary usage/route 缝隙不足；这些报告保留为证据，不再用隐藏 Session 或伪造 projection 绕过。
- 当前架构把 auxiliary usage/limits/cancel 明确交给独立社区插件：官方 `tokenUsage` 仍只归 Agent loop，独立 ledger 通过官方 `storageDomain` 持久化，Clarify 只消费同进程 `auxiliaryRuntime`。
- 空白 Session 的路由从公开 `agentDefaultModel.currentSelection()` 获取；已有 request header 永远优先，有历史但缺 header 时 fail closed。请求与 reservation 从 `prepareCall` 后的物化配置/context window 原子构造，token 限额在 stream 前二次准入。
- Host T3 信封完整回合可以「通过」，但所用 Session 是隔离探针夹具，不是生产插件创建。
- T1 add/boot/remove/re-add 的 standalone lifecycle 与三包联合 lifecycle 均已通过；真实 `/doctor` 为零错误零警告，动态问题/选项/预览、逐答演进、审阅采用后仅填入输入框、重启恢复、官方 `tokenUsage` 不变和 auxiliary 独立持久化均已观察。
- 这些结论只覆盖精确 rc.8 联合栈。历史 T0 阻塞报告仍是当时“官方同名 usage/limits/cancel 投影不可用”的有效证据；当前社区 auxiliary 域没有把它们改写成官方能力。`latest` / `next` 仍只是动态发现。
