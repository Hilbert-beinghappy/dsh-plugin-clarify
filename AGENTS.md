# AGENTS.md

本仓库实现任务书 A（`docs/任务书A-clarify-host-plugin.md`）中的 Clarify Host 插件。该任务书是接口与契约的**唯一事实来源**。

## 必须遵守

- 包名 `dsh-plugin-clarify`，首版 `0.1.0`。禁止 `workspace:` 依赖；生产源码、包清单和依赖禁止引用 `seektty`，文档可以说明跨项目验收边界。
- 兼容最低基线官方 `@deepseek-ai/dsh@0.1.0-rc.6`。本地/CI 合同是 **pinned rc.6 + rc.7 + rc.8 + 动态 latest**，并在 `next ≠ latest` 时加跑 `next`。公开表只把实际跑过的精确版本标为已验证。对未发布版本只做能力探测、版本化适配、安全降级；不虚构“已验证”，不硬锁 rc.6/rc.7 私有实现。rc.6 元包的 `^` 依赖可能解析到更新组件，报告必须写清组件图。
- 共享词汇不得改名：`start` / `answer` / `cancel` / `fetchDraft`，`processId` / `sessionId` / `contextVersion` / `modelRouteId`，`question` / `options` / `multiple` / `allowCustom`，状态 `running` / `cancelled` / `stale` / `complete`。
- `multiple=false` 时 `selectedOptionIds` 恰好一个；`multiple=true` 时至少一个。`selectedOptionIds` 与 `customText` 严格 XOR。
- `complete` 后必须单独 `fetchDraft` 才返回 draft。`stale` 胜出：不得继续消费 question / options / draft。
- 进程状态只存在 Host 内存 TTL 表。禁止写入 Session transcript、queue、pending、Plan、Goal、磁盘、Profile、`.env`。
- 插件零凭据、零私自调 Provider。推理走 Harness Host 服务。T4 以前使用桩推理。
- 四方法必须注册为 stock Typert Remote（`clarify/start|answer|cancel|fetchDraft`），经 `typertGateway` / `POST /api/clarify/<method>` 消费。禁止自造 `POST /clarify/rpc`。DIY 不得 `session.create`；`start`/`answer` 在推理返回后、发布前必须重验 binding，让 stale 胜出。
- T0 若公开 API 无法证明 (a)–(d)，写精确阻塞报告，**禁止伪造通过**。T1–T3 骨架仍可继续。Clarify standalone T1 只陈述 stock `add` / boot / `remove` / 再 `add` lifecycle；任务书 `/doctor` 零错误零警告是 **final cross-project acceptance**，由 Task B 用既有本地 `/doctor` 在安装 Clarify 后验证。不得自造 stock CLI doctor 或 Host `GET /doctor`，也不得因 stock dsh 不存在这些面而把 Clarify CI 打成永久红。在联调证据存在前，不得把 T1 写成完全通过。
- 不要 `npm publish`，不要 SBOM/SLSA，不要 git branch/add/commit/tag/push（除非用户明确要求），不要访问 SeekTTY 工作区，不要读取或输出凭据 / Session / Profile 私密数据。

## 布局

- `src/clarify-service.ts`：TTL 状态机
- `src/rpc.ts`：四个方法的进程内调度
- `src/remote.ts`：Typert Remote 服务与 `ctx.typert.register`
- `src/host-diy.ts`：`GET /clarify` Web-only 交互面（只走同一 Remote）
- `src/compat.ts`：能力探测 / 版本化适配 / 安全降级
- `src/probe.ts`：仅 `CLARIFY_PROBE=1` 或 `DSH_HOME/.clarify-probe` 时的 T0 探针面
- `scripts/t0-run.mjs` / `t1-lifecycle.mjs` / `t3-e2e.mjs` / `t0-matrix.mjs`：可重跑证据
- `cordis.patch.yml`：官方 `dsh.bundle.patch` 层

## 验证

`pnpm test && pnpm build && pnpm pack:check && pnpm t3`。Host 合同：`pnpm t0:matrix && pnpm t1:matrix`。涉及官方 dsh 的步骤必须在隔离 `DSH_HOME` 下跑。闸门只写「通过 / 阻塞 / 不适用」或「可行 / 阻塞」。standalone lifecycle 与 cross-project doctor 必须分开记账；后者在联调前写「待联调」，不得写成 T1 完全通过，也不得用「未观察/失败」代替。
