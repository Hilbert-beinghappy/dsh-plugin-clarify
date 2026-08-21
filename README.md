# dsh-plugin-clarify

独立的 DeepSeek Harness **Host 插件**（npm 包名 `dsh-plugin-clarify`，当前版本 `0.2.0`）。它基于当前真实 Session、用户草稿和真实模型路由运行临时澄清进程，由模型动态生成苏格拉底式问题、上下文相关选项、后续分支和逐答更新的 draft preview；最终只产出一段**待用户自行发送**的草稿文本。

SeekTTY 只是可选消费者。生产源码、包清单和依赖不引用 `seektty`，也不含 `workspace:` 依赖；文档仅说明跨项目验收边界。真实推理由同一 Host 进程中的 `dsh-plugin-auxiliary-runtime@0.1.0` 执行和单独计量，Clarify 不直接持有 LLM、凭据、存储或用量 projection。

## 兼容范围

完整动态推理的当前精确目标是官方 `@deepseek-ai/dsh@0.1.0-rc.8` 与 `dsh-plugin-auxiliary-runtime@0.1.0`。历史 rc.6/rc.7 探针证据仍保留，但不等于当前生产组合兼容声明。公开兼容表只把实际跑过最终联合合同的精确版本标为已验证。`GET /clarify` 必须绑定已有 `sessionId`，不会 `session.create`。

精确说明见 `docs/compatibility.md`。T0 现场证据见 `docs/t0-evidence/<version>/`。

## 非目标

- 不发布 npm registry，不做 SBOM / SLSA / provenance。
- 不写入 Session transcript、input queue、pending、Plan、Goal，也不持久化到磁盘 / Profile / `.env`。
- 不自动 `session.prompt`。draft 进入对话的唯一途径是用户之后的常规提交。
- 不注册、替换或写入官方 `tokenUsage`。Auxiliary 用量由独立插件通过官方 `storageDomain` 记录；它不伪装成官方同名 projection，也不污染 Session。
- 不硬编码领域问卷、固定问题、固定选项或固定 preview；生产问题、选项和预览均来自模型输出。

## 接口词汇

Typert Remote 命名空间 `clarify`：`start` / `answer` / `accept` / `refine` / `cancel` / `fetchDraft`。

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
dsh plugin --profile web add ./dsh-plugin-auxiliary-runtime-0.1.0.tgz
dsh plugin --profile web add ./dsh-plugin-clarify-0.2.0.tgz
dsh --profile web
```

卸载 / 重装：

```sh
dsh plugin --profile web remove dsh-plugin-clarify
dsh plugin --profile web add ./dsh-plugin-clarify-0.2.0.tgz
```

生产组合在 Host 上注册：

- Typert Remote `clarify/{start,answer,accept,refine,cancel,fetchDraft}`，经 `ctx.typert.register` + `typertGateway`
- `GET /clarify`：可操作的 Host DIY 页，只走同一 `/api` Remote，不自动发送
- 进程状态仅在 Host 内存 TTL 表中，默认 15 分钟无交互后 `staleReason=ttl-expired`
- `auxiliaryRuntime.run({ prepareRequest })`：在官方 `llm.prepareCall` 得到物化模型配置与 context window 后，同一次原子回调构造 prompt 与 reservation；流式输出不进入 Session transcript
- 空白新 Session 没有 `requestHeader()` 时，只在“无历史且无 requestContext”条件下读取公开 `agentDefaultModel.currentSelection()`；有历史却缺 header 时拒绝猜测路由，已有 header 始终优先

Cordis 注入使安装顺序不决定激活结果：Clarify 等待 `auxiliaryRuntime`，Auxiliary Runtime 等待官方 `storageDomain`；依赖撤回时相关子上下文自动停用，恢复后以新实例重新激活。精确 rc.8 的 SeekTTY `/doctor`、隔离安装/卸载/重装和真实 PTY 联合验收已通过；每次 Release 仍须在合并后的提交上重跑并执行发布后再安装。`pnpm t3` 只是进程内 Remote 冒烟，不替代真实 Host/TUI 验收。

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

CI `verify` 跑 `test` / 干净 `build` / `pack:check` / `t3`（进程内）。`pack:check` 会拒绝已删除的直接 LLM/acceptance 绕行产物残留。Release 前的官方 Host、真实 PTY 与 `/doctor` 联调门禁在三项目联合轨道执行。不跑 `npm publish`，不引入 SBOM/SLSA。

## 许可

MIT
