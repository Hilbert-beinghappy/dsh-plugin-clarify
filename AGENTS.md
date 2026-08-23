# AGENTS.md

本仓库实现任务书 A（`docs/任务书A-clarify-host-plugin.md`）中的 Clarify Host 插件。该任务书是接口与契约的**唯一事实来源**。

## 必须遵守

- 包名 `dsh-plugin-clarify`，已发布 `0.1.0`、`0.2.0`、`0.2.1` 与 `0.2.2`（GitHub Release tgz + SHA256SUMS）。`0.2.2` 已在精确 stock dsh `0.1.1-rc.2`、无 SeekTTY 下做过校验和核验，但不是推荐联合基线。推荐回滚组合仍是 Host `0.1.0-rc.8` + Clarify `0.2.1` + Auxiliary `0.1.0` + SeekTTY `1.2.0`；不得另造新推荐组合。禁止 `workspace:` 依赖；生产源码、包清单和依赖禁止引用 `seektty`，文档可以说明跨项目验收边界。
- 兼容最低基线官方 `@deepseek-ai/dsh@0.1.0-rc.6`。本地/CI 合同是 **pinned rc.6 + rc.7 + rc.8 + 0.1.1-rc.2 + 动态 latest**，并在 `next ≠ latest` 时加跑 `next`，与精确 pin 去重。`0.1.1-rc.1` 只保留为历史复现，不是生产 pin。公开表只把实际跑过的精确版本标为已验证。对未发布版本只做能力探测、版本化适配、安全降级；不虚构“已验证”，不硬锁 rc.6/rc.7 私有实现。rc.6 元包的 `^` 依赖可能解析到更新组件，报告必须写清组件图。
- 共享词汇不得改名：`start` / `answer` / `accept` / `refine` / `cancel` / `fetchDraft`，`processId` / `sessionId` / `contextVersion` / `modelRouteId`，`question` / `options` / `multiple` / `allowCustom`，状态 `running` / `cancelled` / `stale` / `complete`。
- `multiple=false` 时 `selectedOptionIds` 恰好一个；`multiple=true` 时至少一个。`selectedOptionIds` 与 `customText` 严格 XOR。
- `complete` 后必须单独 `fetchDraft` 才返回 draft。`stale` 胜出：不得继续消费 question / options / draft。
- 进程状态只存在 Host 内存 TTL 表。禁止写入 Session transcript、queue、pending、Plan、Goal、磁盘、Profile、`.env`。
- 插件零凭据、零私自调 Provider。推理走 Harness Host 服务。T4 以前使用桩推理。
- 六方法必须注册为 stock Typert Remote（`clarify/start|answer|accept|refine|cancel|fetchDraft`），经 `typertGateway` / `POST /api/clarify/<method>` 消费。禁止自造 `POST /clarify/rpc`。DIY 不得 `session.create`；`start`/`answer`/`refine` 在推理返回后、发布前必须重验 binding，让 stale 胜出。
- T0 若公开 API 无法证明 (a)–(d)，写精确阻塞报告，**禁止伪造通过**。T1–T3 骨架仍可继续。Clarify standalone T1 只陈述 stock `add` / boot / `remove` / 再 `add` lifecycle；任务书 `/doctor` 零错误零警告是 **final cross-project acceptance**，由 Task B 用既有本地 `/doctor` 在安装 Clarify 后验证。不得自造 stock CLI doctor 或 Host `GET /doctor`，也不得因 stock dsh 不存在这些面而把 Clarify CI 打成永久红。在联调证据存在前，不得把 T1 写成完全通过。
- 不要 `npm publish`，不要 SBOM/SLSA，不要 git branch/add/commit/tag/push（除非用户明确要求），不要访问 SeekTTY 工作区，不要读取或输出凭据 / Session / Profile 私密数据。

## 布局

- `src/clarify-service.ts`：TTL 状态机
- `src/rpc.ts`：六个方法的进程内调度
- `src/remote.ts`：Typert Remote 服务与 `ctx.typert.register`
- `src/host-diy.ts`：`GET /clarify` Web-only 交互面（只走同一 Remote）
- `src/compat.ts`：能力探测 / 版本化适配 / 安全降级
- `src/probe.ts`：仅 `CLARIFY_PROBE=1` 或 `DSH_HOME/.clarify-probe` 时的 T0 探针面
- `scripts/t0-run.mjs` / `t1-lifecycle.mjs` / `t3-e2e.mjs` / `t0-matrix.mjs`：可重跑证据
- `scripts/t7-lab.mjs` / `scripts/lib/t7-schema.mjs` / `scripts/lib/t7-surfaces.mjs`：T7 证据（`--validate` / `--from-pack` / `--from-release`）；用户价值证据必须来自校验和核验的已发布资产
- `cordis.patch.yml`：官方 `dsh.bundle.patch` 层

## 验证

`pnpm test && pnpm build && pnpm pack:check && pnpm t3`。无 provider 的 T7 检查：`pnpm t7:validate`（核验声明一致性并报告分类；当前入库 G0 通过，不是完整 T7）。G0 是无 key 遏制闸门，要求 `INFERENCE_UNAVAILABLE` 加稳定 provider-neutral `providerFailureCode`（不得把 `ENOTSUP` 写成 `MISSING_CREDENTIAL`）、已证明无 SeekTTY、六方法 DIY 控件，以及 `asset.userValue`。`pnpm t7:from-release` 必须同时带本地已发布 `dsh-plugin-clarify-0.2.2.tgz` 与 `dsh-plugin-auxiliary-runtime-0.1.1.tgz` 及 SHA256SUMS，版本来自已知输入、文件名精确匹配；缺半对、缺 Auxiliary 或读失败时失败而不是绿灯。完整 T7 不是无 key / mock。Host 合同：`pnpm t0:matrix && pnpm t1:matrix`。涉及官方 dsh 的步骤必须在隔离 `DSH_HOME` 下跑。闸门只写「通过 / 阻塞 / 不适用」或「可行 / 阻塞」。standalone lifecycle 与 cross-project doctor 必须分开记账；后者在联调前写「待联调」，不得写成 T1 完全通过，也不得用「未观察/失败」代替。
