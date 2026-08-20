# T0 阻塞报告（0.1.0-rc.8）

> 本报告只记录本次实际观察到的结果。未观察到的能力一律标为阻塞，不标通过。
> 公开兼容表只把实际跑过合同的精确版本标为已验证。future / latest / next 是动态发现，不是对未发布版本的保证。

## 环境

- 请求的元包：`@deepseek-ai/dsh@0.1.0-rc.8`（来源 `version`）
- 观察到的 CLI `--version`：`0.1.0-rc.8`
- 解析组件：base `0.1.0-rc.8`；typert-protocol `0.1.0-rc.8`；web-app `0.1.0-rc.8`
- 混合树：`no` — resolved core components match the requested meta version
- 隔离 `DSH_HOME`：`.probe-work/0.1.0-rc.8/homes/t0`（gitignored，不输出 Profile/凭据/本机绝对路径）

## 闸门 (a)–(d)

| 闸门 | 结论 | 证据 |
| --- | --- | --- |
| (a) off-transcript, no-tools 补全 | 可行 | 直接 ctx.llm.stream（探针 adapter、no-tools、未 markAgentLoopRequest）成功，且 session 事件/deriveMessages 计数未增加。未证明走 Session 现网 provider 路由 |
| (b) 只读上下文及修订标识 | 阻塞 | requestHeader() is undefined on a fresh session; public API has no context revision id besides the forbidden session.seq fallback |
| (c) Surface 可发现 Remote | 可行 | typert.local 已 claim 四端点，且 Gateway 或 /api 信封以 Clarify 业务错误/结果命中 receiver |
| (d) usage / limits / cancel 通道 | 阻塞 | 未用已存在的用户 Session 证明 Harness usage 归属；禁止用探针新建 Session、假 assistant/message、私有计量器或未证明的 Session 日志写入来伪装 (d) |

## P-usage

- 状态：`observed`
- `ctx.llm.stream`：`true`
- 无 Agent-loop 标记：`true`
- 事件条数变化：`0`
- deriveMessages 条数变化：`0`
- stream 错误：`none`
- adapter 错误：`none`

## P-header

- 状态：`blocked-live-header`
- 新鲜 Session 上 `requestHeader()`：`false`
- header keys：`none`
- config keys：`none`
- 存在 `session.seq`：`true`（禁止用作 contextVersion）
- 无新消息改 system/tools：`blocked` — stock public API was not observed to mutate system/tools without an agent loop or a request/header write; probe refuses to append request/header itself

## P-web

- Host DIY `GET /clarify`：HTTP 200；DIY 签名 匹配
- `GET /clarify/probe`：HTTP 200；合同 JSON 是
- stock `POST /api/clarify/start`：HTTP 200；Remote 信封 已观察到
- Host T3（官方 `/api` 信封实跑）：通过 — GET /clarify static HTML is not an interactive T3 pass. Session source=t0-probe-test-fixture, createdByHarness=true, productionPluginCreated=false. Isolation test fixture only; production plugin and DIY must not create Session.
- Host T3 Session：source=`t0-probe-test-fixture`；createdByHarness=`true`；productionPluginCreated=`false`。仅隔离测试夹具；插件与 DIY 仍禁止 `session.create`。
- DIY 静态签名不等于交互通过：`签名匹配`；交互 T7 未声称通过
- `webServer.register`：`true`
- `ctx.typert.register`：`true`
- `typert.local` claim 四端点：`true`；列出 `clarify/start, clarify/answer, clarify/cancel, clarify/fetchDraft`
- Remote 注册：`registered`
- Gateway 到达：`observed` / `4`；仅 business hit 算抵达
- `typertGateway.invoke`：`true`
- `ctx.remote.$mount`：`false`（Client face，Host DIY 不依赖它）
- stock Web 插件 UI 挂载点：this probe does not claim a ConversationNode or settings panel; Host DIY GET /clarify is the documented fallback and must use the same /api Remote

## 对 T4+ 的影响

该精确版本的 T4 及以后按任务书停止真实推理接入，直到上表阻塞项由官方 dsh 公开 API 补齐。T1–T3 骨架、状态机与桩 Remote 继续交付。

## 命令记录

- OK `dsh --version`
- OK `dsh --help`
- OK `init dump-config`
- OK `plugin add tgz`
- OK `dump-config after add`
- OK `dsh --profile web --help`
