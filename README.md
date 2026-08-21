# dsh-plugin-clarify

独立的 DeepSeek Harness **Host 插件**（npm 包名 `dsh-plugin-clarify`，当前未发布版本 `0.2.0`）。它提供绑定当前 Session 与 context version 的临时澄清式推理进程：结构化提问，最终产出一段**待用户自行发送**的草稿文本。

SeekTTY 只是可选消费者。生产源码、包清单和依赖不引用 `seektty`，也不含 `workspace:` 依赖；文档仅说明跨项目验收边界。

## 兼容范围

最低基线：官方 `@deepseek-ai/dsh@0.1.0-rc.6`。

发布前合同：pinned `rc.6` / `rc.7` / `rc.8`，当时 npm `latest`，以及与 `latest` 不同时的官方 `next`。2026-08-20 快照为 `latest=0.1.0-rc.7`、`next=0.1.0-rc.8`。公开兼容表只把实际跑过合同的精确版本标为已验证。对未发布版本只做能力探测、版本化适配、安全降级，不硬锁单一 rc。`GET /clarify` 必须绑定已有 `sessionId`，不会 `session.create`。

精确说明见 `docs/compatibility.md`。T0 现场证据见 `docs/t0-evidence/<version>/`。

## 非目标

- 不发布 npm registry，不做 SBOM / SLSA / provenance。
- 不写入 Session transcript、input queue、pending、Plan、Goal，也不持久化到磁盘 / Profile / `.env`。
- 不自动 `session.prompt`。draft 进入对话的唯一途径是用户之后的常规提交。
- T4 及以后的真实推理接入：若 T0 闸门 (a)–(d) 任一阻塞则停止，禁止隐藏 Session 或“发了再藏”。

## 接口词汇

Typert Remote 命名空间 `clarify`：`start` / `answer` / `cancel` / `fetchDraft`。

消费者路径是 stock Connection 信封：

```http
POST /api/clarify/start
Content-Type: application/json

{
  "type": "client-request",
  "rpcId": "<id>",
  "method": "clarify/start",
  "payload": { "args": { "sessionId": "<id>", "seedText": "optional" } }
}
```

状态：`running` / `cancelled` / `stale` / `complete`。`stale` 必须带 `staleReason`。`complete` 的 draft **只**通过单独的 `fetchDraft` 返回。`multiple` 的 cardinality 与 `selectedOptionIds`/`customText` 严格 XOR 见任务书 A 第 6.3 节。

## 安装（官方 dsh，隔离 Profile）

本包以 `pnpm pack` 的 tgz 安装，不要求 git `prepare` / `allowBuilds`。`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，由原生命令 `dsh plugin add` 写入 `dsh.profile.bundles`。

```sh
pnpm pack
dsh plugin --profile web add ./dsh-plugin-clarify-0.2.0.tgz
dsh --profile web
```

卸载 / 重装：

```sh
dsh plugin --profile web remove dsh-plugin-clarify
dsh plugin --profile web add ./dsh-plugin-clarify-0.2.0.tgz
```

T1–T3 骨架在 Host 上注册（这不是 T1/T0 全绿）：

- Typert Remote `clarify/{start,answer,cancel,fetchDraft}`，经 `ctx.typert.register` + `typertGateway`
- `GET /clarify`：可操作的 Host DIY 页，只走同一 `/api` Remote，不自动发送
- 进程状态仅在 Host 内存 TTL 表中，默认 15 分钟无交互后 `staleReason=ttl-expired`

Clarify standalone T1 只陈述 stock `add` / boot / `remove` / 再 `add` lifecycle。任务书 `/doctor` 零错误零警告是 **final cross-project acceptance**：由 Task B 用 SeekTTY 既有本地 `/doctor`（不是 dsh CLI，也不是 Host `GET /doctor`）在安装 Clarify 后验证。本仓库不发明 doctor。在联调证据存在前，只能写 standalone lifecycle 通过、cross-project doctor 待联调，不能说 T1 完全通过。T0 (b)/(d) 仍阻塞时 T4+ 停止。`pnpm t3` 只是进程内 Remote 冒烟，不是官方 Host T3。

T0 探针在 `CLARIFY_PROBE=1` 或隔离 `DSH_HOME/.clarify-probe` 标记存在时提供 `GET /clarify/probe`。探针可为隔离合同创建测试夹具 Session；生产插件与 DIY 不得 `session.create`。不要在生产 Profile 打开该开关。官方 dsh 由 T0/T1 脚本用 npm 装到 `.probe-work/`（gitignored），不得进入本包 `package.json` / 仓库 lockfile importer。

## 开发

```sh
pnpm install
pnpm test
pnpm build
pnpm pack:check
pnpm t3
pnpm t0:matrix    # 隔离 DSH_HOME；pinned rc.6/rc.7/rc.8 + 动态 latest/next 去重
pnpm t1:matrix
```

CI `verify` 跑 `test` / `build` / `pack:check` / `t3`（进程内）。CI `contract-matrix` 跑隔离 Host 上的 T0/T1；子进程退出 0 不等于闸门可行。T1 standalone 退出 0 只表示 lifecycle 通过；stock dsh 不存在 doctor 不得使 CI 永久红。Release 前的 `/doctor` 联调门禁在 SeekTTY 轨道执行。不跑 `npm publish`，不引入 SBOM/SLSA。

## 许可

MIT
