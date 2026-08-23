# 任务书 A：Clarify 独立 Host 插件（临时推理进程）

> 这是一本插件任务书，不是 TUI 任务书。本书是接口与契约的唯一事实来源（source of truth）；任务书 B（SeekTTY）只能消费本书定义的接口，不得增补或改名任何字段。

## 1. 一段话使命

交付一个独立的 DeepSeek Harness **Host 插件**（暂定包名 `dsh-plugin-clarify`，定名前不得含 `seektty` 字样），它向 Harness 注册一组第一等接口（Host Remote / API），提供一个绑定当前 Session 与 context version 的**临时澄清式推理进程**：通过结构化提问帮助说不清需求的用户澄清诉求，最终产出一段整理好的**用户草稿文本**。插件在**未修改的官方 dsh** 上安装、运行、卸载、重装，官方 Web 与任何后续 Surface 都可直接消费其接口；SeekTTY 只是一个可选消费者。

## 2. 目标

- 以 Host 插件形式交付第 4 节契约中的全部能力，接口对所有 Surface 一视同仁。
- 推理、路由、用量、限额、取消、错误处理全部通过 Harness 既有 Host 服务完成，插件自身零凭据、零 Provider 调用。
- 进程状态仅存在于 Harness 拥有的 TTL 进程内存中，随 cancel / stale / complete / TTL 到期清理。
- 在隔离 `DSH_HOME`、官方 stock dsh、**不安装 SeekTTY** 的条件下，完成一次完整的"澄清 → 产出 draft"回合并通过验收。
- 用原生 `dsh plugin` 完成安装、卸载、重装的合同测试，并声明精确的兼容 dsh 范围。

## 3. 非目标

- 不做任何 SeekTTY chrome：不碰 composer、keymap、状态栏、主题、`/` 命令目录。
- 不做常驻建议条、ghost 补全、F1、空 Enter 触发等任何 Surface 侧交互设计。
- 不是 `/plan`：本进程澄清"要什么"，不产出执行计划、工具调用或任何 Agent 工作。
- 不做 Skill、marketplace 演示品，或会运行工具的 Agent 预设。
- 仓库公开发布已经获得用户授权；首版发布 GitHub Release 安装包与校验和，但不发布到 npm registry。

## 4. 共享契约（两本任务书逐字一致，不得改写）

插件提供一个绑定当前 Session 与某个 context version 的临时推理进程。

- 模型与 Provider 路由、Profile、上下文读取、用量记录、限额、取消、错误处理全部由 Harness 拥有。插件消费这些 Host 服务；不得持有凭据、不得自行调用 Provider、不得打开隐藏 Session、不得运行常规 Agent 循环。
- 该进程不得创建正式的用户消息或助手消息。
- 该进程不得写入 Session transcript、input queue、pending、Plan、Goal，或 Session 分支 / fork。
- 该进程不得调用工具、MCP、Skills 或子代理。
- Harness（经由插件的接口）返回结构化的 question、options、是否 `multiple`、是否 `allowCustom`，以及最终整理后的 draft 文本。
- 进程启动后，若当前 Session、模型路由或 context version 变化，Harness 必须 cancel 该进程或将结果标记为 stale。以下同样视为 context version 变化：主 Session 出现新的正式消息、compaction、recall / 上下文注入。stale 的 options 不得静默继续。
- 草稿问答仅可作为 Harness 拥有的 TTL 进程状态存在，绝不可成为 SeekTTY 文件，绝不可进入 transcript。进程标识至少包含 `processId`、绑定的 `sessionId`、`contextVersion`（或模型可见上下文的稳定指纹）、`modelRouteId`。
- 最终文本进入正式对话的唯一途径，是用户之后通过常规 Session 提交路径（`session.prompt` 或等价物）自行发送。插件与任何 Surface 都不得自动发送。
- 输出仅为"待发出的用户草稿文本"，不是助手回复，也不是给 Agent 执行的计划。

共享接口词汇（两本书必须使用且不得改名）：

- start / answer / accept / refine / cancel / fetch draft
- `processId`、`sessionId`、`contextVersion`、`modelRouteId`
- question、options、`multiple`、`allowCustom`、最终 draft 文本
- 状态：running / cancelled / stale / complete
- 用量与错误走既有通道：官方 `tokenUsage` 只归 Agent；Clarify 辅助用量只在 Auxiliary Runtime 私有 `auxiliary_runtime` ledger

## 5. 架构：为什么是 Host 插件，谁拥有什么

### 5.1 为什么必须是 Host 插件，而不是 Agent / Skill / 工具插件

本插件需要的四样东西，只有 Host 插件位面能拿到：

1. **注入 Harness LLM router**：以当前 Session 的 `modelRouteId` 发起一次**脱离 transcript、禁用工具**的补全（off-transcript, no-tools completion）。
2. **注入 Session 上下文读取器**：只读地获取当前 Session 上下文与其修订标识（`contextVersion`）。
3. **注入 usage / limits / cancel**：消费官方限额与取消通道；官方 `tokenUsage` 仍只表示 Agent 循环。Clarify 辅助消耗只进入 Auxiliary Runtime 私有 `auxiliary_runtime` ledger，不得另建计量或写入 Session 用量。
4. **注册一个 Remote**：让任意 Surface（官方 Web、SeekTTY、未来的壳）通过统一 RPC 面调用 start / answer / accept / refine / cancel / fetch draft。

Agent 插件跑的是常规 Agent 循环（违反契约"不得运行常规 Agent 循环"）；Skill 走 transcript（违反"不得创建正式消息"）；工具插件由 Agent 调用（方向反了，这里是 Surface 调用插件）。因此结论固定为 Host 插件。

**阻塞声明**：T0(a) 至 T0(d) 任一能力在当前官方 dsh 中不存在，T4 及以后全部阻塞；T1 至 T3 的无真实推理骨架、状态机与桩 Remote 可以继续并公开交付。此时必须发布一份精确到公开 API 缺口的阻塞报告，指明需要 Harness 侧补齐的 Host inject / Remote / usage / limits / cancel 能力。**禁止**用隐藏 Session、向真实 Session 写入伪造或空的 assistant/message 再隐藏、或另建私有计量器来绕过——这些是硬禁令，不是备选方案。

### 5.2 所有权划分

| 归属 | 内容 |
| --- | --- |
| Harness（Host 服务，插件只消费） | 模型与 Provider 路由、凭据、Profile、Session 上下文读取、用量记录、限额、取消信号、错误通道、插件安装与生命周期（`dsh plugin`） |
| 本插件 | 临时推理进程状态机、TTL 进程状态、start / answer / accept / refine / cancel / fetch draft 接口、stale 侦测与标记、澄清提问与 draft 生成的 prompt 策略、Remote 注册 |
| Surface（Web / SeekTTY / 其他） | 各自的壳：发现 Remote、渲染 question / options / `allowCustom`、展示 draft、把 draft 填入各自的常规 composer |
| 用户 | 决定是否发送 draft；发送只走常规 Session 提交路径 |

## 6. 接口规范与数据流

本节是接口的规范文本。字段用表格描述，不给代码；实现者按 Harness Remote 惯例落地形状，但**字段名与状态名不得偏离本节**。

### 6.1 通用规则

- 每个响应都携带：`processId`、当前状态（running / cancelled / stale / complete）、进程绑定的 `contextVersion` 与 `modelRouteId` 回显。
- 状态为 stale 时必须携带 `staleReason`（枚举：session-changed / route-changed / context-changed / new-official-message / compaction / recall-injection / ttl-expired）。
- 六个 Remote 方法的业务结果走公开线约 `clarify.wire/1`（见 6.8）：内层联合作为官方 Gateway 外层成功值。外层 `internal` / `cancelled` / transport 仍是 Harness 既有错误通道，不得用它们反推 Clarify 业务。`ClarifyError` 的 `code` 仍是既有业务码，另带必填五类 `category`。
- `contextVersion` 的取值来源：优先使用 Harness 暴露的上下文修订标识；若当前 dsh 版本不暴露，则降级为对**模型可见输入**做稳定规范化指纹，至少覆盖 system prompt、工具 schema 上下文与 Harness 派生后的消息历史。不得使用只反映日志长度的 `session.seq`，也不得只 hash transcript。具体公开字段必须先经 P-header 探针证明；两种来源对消费者透明，消费者只做不透明字符串的相等比较。
- `modelRouteId` 是 Harness 当前路由的稳定规范化指纹；候选输入为公开 `requestHeader().config` 中的 provider、model、reasoningEffort 三元组，最终字段来源必须经 P-header 探针证明。

### 6.2 start

| 方向 | 字段 | 说明 |
| --- | --- | --- |
| 请求 | `sessionId` | 必填。绑定的当前 Session。 |
| 请求 | seedText | 可选。用户已敲出的半成品文字，作为澄清起点。 |
| 响应 | `processId` | 新建进程标识。 |
| 响应 | `contextVersion`、`modelRouteId` | 进程创建瞬间从 Harness 读取并绑定，此后不变。 |
| 响应 | question | 第一轮问题（见 6.3 的 question 形状）。若模型本轮给出 `await_accept` 则省略。 |
| 响应 | `kind`、`previewVersion`、`draftPreview`、`materialChanges` | 必填于 running。`kind` 只能是 `ask` / `await_accept`；Host 为当前 preview 分配不透明 `previewVersion`；`draftPreview` 是待 accept 的用户草稿预览，不是终态 draft；`materialChanges` 说明本轮决策级变化。 |

同一 `sessionId` 上已有 running 进程时，start 先 cancel 旧进程再新建（一 Session 至多一个活跃进程）。start、answer 与 refine 都发布新的 `previewVersion`；进程不会因模型输出而直接进入 complete。

### 6.3 answer

| 方向 | 字段 | 说明 |
| --- | --- | --- |
| 请求 | `processId`、questionId、`previewVersion` | 必填。必须等于当前 live question 与 live preview；任一不匹配都是非变更错误（`PREVIEW_OUTDATED` 或 `INVALID_ANSWER`），不是 process stale。 |
| 请求 | selectedOptionIds 或 customText | 二选一；customText 仅当该 question 的 `allowCustom` 为真时合法。 |
| 响应 | 下一个 question（`ask`）或省略 question（`await_accept`），并发布新的 `previewVersion` / `draftPreview` | 进程保持 running。complete 只通过 6.3a 的 accept。answer / cancel 的终态回显不得泄漏 draft。 |

question 的形状：questionId、题干文本、options 列表（每项含 optionId 与展示文本）、必填的 `multiple` 布尔值、`allowCustom` 布尔值。一轮一个 question；多问必须拆成多轮。`questionId` / `optionId` / `previewVersion` **只由 Host 分配**，对模型不透明。模型推理的严格联合为 `ask{question 文本, 模型生成的 option 文本, multiple, allowCustom, draftPreview, materialChanges}` 或 `await_accept{draftPreview, materialChanges}`。写入模型的私有 input 使用 `acceptedDecisions`（每条为 `questionText` 加上严格 XOR：`selected_options` 且非空 `selectedOptionTexts`，或 `custom` 且非空 `customText`）、可选的 `priorPublishedDraft`（仅当次回答或 refine 前最新成功发布的 `draftPreview` 与 `materialChanges`），以及可选的一次性 `refineFeedback`（仅 refine；trim 后非空；只进 DATA envelope，不得写入 `seedText` 或 control-system instruction）。`start` / `answer` 省略 `refineFeedback`。`start` 时 `acceptedDecisions` 为空且无 prior。不得含内部 ID，不得把历史 preview 链写入模型。每一轮成功发布的 preview 必须相对上一轮发生超出标点与词序的实质变化；非法或非实质结果保持旧 preview / version / question 不变。

- `multiple = false` 时，selectedOptionIds 必须恰好含一个 optionId。
- `multiple = true` 时，selectedOptionIds 必须至少含一个 optionId。
- selectedOptionIds 与 customText 严格异或；不支持“多选再附加自定义文本”，也不接受空选择。

对 stale / cancelled / complete 状态的进程调用 answer，返回该状态与 `staleReason`（如适用），不执行任何推理。

### 6.3a accept

| 方向 | 字段 | 说明 |
| --- | --- | --- |
| 请求 | `processId`、`previewVersion` | 必填。`previewVersion` 必须等于当前 live preview。请求形状不因 `ask` / `await_accept` 而变化。 |
| 响应 | 终态 complete（或已存在的权威终态） | running 且精确匹配 live version、且存在非空 `draftPreview` 时：状态翻转为 complete，draft 与被接受的 preview **逐字节相同**。终态回显不带 draft。`ask` 与 `await_accept` 均可 accept。接受 `ask` 时丢弃未回答的 live question，**不得**因此发明一条 `AcceptedDecision`。 |

- 同一 `previewVersion` 的重复 accept 在 TTL 内幂等回放同一终态，不重新推理。
- cancel 与 accept 竞态：返回权威终态（complete 或 cancelled），不得混写。
- live preview / version 不匹配是非变更的 `PREVIEW_OUTDATED`（或 `INVALID_ANSWER`），不是 stale。`status: stale` 仍只表示 binding 失效。
- 推理进行中（`inFlight`）的 accept 返回非变更的 `PROCESS_BUSY`，不中断进行中的补全。
- 不引入 `ready` / `gone` 状态。TTL 摘除 tombstone 后的查询仍是 `PROCESS_NOT_FOUND`。

### 6.3b refine

| 方向 | 字段 | 说明 |
| --- | --- | --- |
| 请求 | `processId`、`previewVersion`、`feedback` | 必填。`previewVersion` 必须等于当前 live preview。`feedback` trim 后必须非空。 |
| 响应 | 下一个 question（`ask`）或省略 question（`await_accept`），并发布新的 `previewVersion` / `draftPreview` | 进程保持 running。refine 不 complete。answer / refine / cancel 的终态回显不得泄漏 draft。 |

- 允许从 `ask` 与 `await_accept` 调用；同一 `processId`；CAS 为 `previewVersion`。
- 保留已提交的 `acceptedDecisions`。`priorPublishedDraft` 是本轮 refine 前的当前 live preview。
- 一次性、不可信的 `refineFeedback` 只进入私有模型 DATA envelope，不得写入 `seedText`，不得写入 control-system instruction，不得使用 `当前草稿：` / `继续完善要求：` 拼进 seed。
- 成功 refine 必须发布相对上一轮发生实质变化的 preview 与新 `previewVersion`；可回到 `ask` 或 `await_accept`。
- 推理 / 解析 / 非实质失败：保持旧 preview、旧 version 与旧 question。
- Busy / cancel / stale 语义与 answer 相同（`PROCESS_BUSY`、abort、binding 重验、stale 胜出）。

### 6.4 cancel

| 方向 | 字段 | 说明 |
| --- | --- | --- |
| 请求 | `processId` | 必填。 |
| 响应 | 终态 cancelled | 幂等：对已终结的进程重复 cancel 返回其现有终态，不报错。 |

cancel 必须同时中断 Harness 侧尚在进行的补全请求（经 Harness 的 cancel 通道）。

### 6.5 fetch draft

| 方向 | 字段 | 说明 |
| --- | --- | --- |
| 请求 | `processId` | 必填。 |
| 响应 | 状态 + 当前已发布结果或 draft 文本 | running 返回与最近一次成功 `start` / `answer` / `refine` 完全相同的已发布结果：`kind`、`previewVersion`、`draftPreview`、`materialChanges`，并仅在 `kind = ask` 时包含 question；即使推理正在进行，也返回最后一次已提交结果，不报 `PROCESS_BUSY`，且绝不含 draft。仅 complete 时含冻结的 draft 文本；stale 返回状态与 `staleReason`，不返回 question / preview / draft。fetchDraft 在 TTL 内对同一 complete tombstone 幂等；TTL 摘除后为 `PROCESS_NOT_FOUND`。 |

draft 是纯用户草稿文本。它不是助手回复、不是计划、不含工具调用指令。complete 后必须单独 `fetchDraft` 才返回 draft。

### 6.6 状态机与 stale 规则

- running →（answer / refine 循环，每轮发布 preview）→ accept → complete；running → cancelled；仅 running 可因 binding 失效转为 stale。complete 是已冻结的权威终态，不再因后续 Session 变化失效。不存在 ready / gone。
- 进入 stale 后只允许 cancel 或对同一 Session 重新 start；stale 的 question / options / draft 一律不得继续消费——接口层面强制，不依赖 Surface 自觉。
- 对 running 进程触发 stale 的事件（插件必须订阅 Harness 相应信号）：绑定 Session 被切换或归档、`modelRouteId` 变化、`contextVersion` 变化、主 Session 出现新的正式消息、compaction、recall / 上下文注入。
- TTL 到期（默认建议 15 分钟无交互，可由实现调整但必须有）：running 等价 stale（`staleReason` = ttl-expired）；complete / cancelled / stale tombstone 到期后摘除，查询为 `PROCESS_NOT_FOUND`。不引入 gone。

### 6.7 用量归属

官方 Agent 循环的 `tokenUsage` 是权威用量面。Clarify 的辅助推理消耗不得改写或记入官方 Session `tokenUsage`，只允许出现在 Auxiliary Runtime 私有 `auxiliary_runtime` ledger。Clarify 不新建、不投影、不改写官方计量体系。若公开读缝不存在，T6/T7 只记录 unavailable，不得编造相等或 hash。

> 6.7 已按现行生产组成更正：官方 `tokenUsage` 只归 Agent；Clarify 辅助用量只在 Auxiliary Runtime 私有 `auxiliary_runtime` ledger。

### 6.8 模型 DATA、draftPreview、错误与重试

- 私有 DATA 含：`sessionSystem`、`seedText`、`acceptedDecisions`、`priorPublishedDraft`、可选 `refineFeedback`、预算后的 `sessionHistory`。不得含 Host ID。repair 复制当前 input（含 `refineFeedback`）。
- 控制提示必须推动从当前 Session 上下文、已接受决策、上一份已发布草稿与可选一次性 refine 反馈做真正收敛；没有固定提问次数。`await_accept` 仅当剩余未知不会改变可发送的用户请求。不得把“用户下一条再贴”当成已关闭事实。`multiple=true` 仅用于真正独立的并行约束。问题与选项必须简洁、高信息量、由模型按 DATA 动态生成，不得使用硬编码领域问卷。
- `draftPreview` 是普通 composer 内容。常规编码任务写成可直接发给 Agent 的用户请求；仅当用户明确要求通知 / 邮件 / UI 文案 / 其他制品时，draft 可以是该制品正文。不得写成助手评论，也不得把页面文案误当成所请求的编码任务。
- 未知推理异常一律映射为 `INFERENCE_UNAVAILABLE`。既有业务错误码不变：`INVALID_ANSWER`、`PREVIEW_OUTDATED`、`PROCESS_BUSY`、`PROCESS_NOT_FOUND`、`SESSION_ID_REQUIRED`。
- 公开线约 `clarify.wire/1`：六个 Typert Remote 方法的返回值都是 JSON-safe `ClarifyWireResult<T> = {protocol,ok:true,value:T}|{protocol,ok:false,error:{code,message,category}}`，且只出现在官方 Gateway **外层成功**的 `result.value` 里。`ClarifyError` 在源点必须带 `category`：`retryable` / `configuration` / `conflict` / `invalid-request` / `protocol`。Remote 只捕获 `ClarifyError` 并原样拷贝，禁止用 code/message 反推；无关异常与载体 `cancelled` 再抛，不得收成内层联合。禁止使用 `TypertLookupFailure`。
- category 映射（同一 code 可不同 category）：已绑定后的瞬时推理/流式/未知推理异常、耗尽后的模型解析/repair、非材料 preview → `retryable`。绑定/snapshot/provider/model/`requestHeader`/路由/未授权引擎，以及建进程前未知 `resolveBinding` 失败 → `configuration`，且 `start` 不得建进程。TTL/未知旧进程、`PROCESS_BUSY`、preview CAS、现行 `questionId` 不匹配 → `conflict`。XOR/空 custom/选项/重复/`multiple` 个数/空 feedback、以及本地漏发 `previewVersion` → `invalid-request`。空 `sessionId`、start 时公开 Session 不存在、未知 method、畸形 question/running/wire/echo → `protocol`。应用 `cancel()` 成功是正常 echo；外层 `cancelled` 仍是载体中止。
- 重试：失败的 start 在首次成功发布前已丢弃进程，Retry 再次 start，同一 Session / seed，得到新 `processId`。失败的 answer / refine 保留旧已发布状态，Retry 在重验 CAS 后对同一进程重复原操作。不得自动重试推理。`configuration` 不得提供 Retry。`PROCESS_BUSY` 不得自动重提。已消失进程不得对旧 `processId` Retry。

## 7. 进程状态

- **存放处**：Host 进程内存中、由本插件持有的 TTL 表，键为 `processId`，值为绑定四元组（`processId` / `sessionId` / `contextVersion` / `modelRouteId`）、状态、问答历史、draft。
- **禁止持久化到**：磁盘文件、Profile、Settings 命名空间、`.env`、Session transcript、SeekTTY 任何文件。没有例外。
- **清理时机**：cancel 即刻进入终态 tombstone；stale 即刻进入终态 tombstone（仅保留可查询的终态与 `staleReason`，保留期不超过 TTL）；complete 后保留可幂等 `fetchDraft` / 重复 accept 的 tombstone 与 draft，直到 TTL 到期后摘除（此后为 `PROCESS_NOT_FOUND`）。
- **Host 重启**：进程状态随之消失，等价于全体 cancel。这是可接受的——进程本就是临时的。重启后 Surface 对旧 `processId` 的任何调用得到"进程不存在"的常规错误。

## 8. Web / 官方 Harness 路径

- 官方 Web（或 Host DIY 页面）通过与 SeekTTY 完全相同的 Remote 调用 start / answer / accept / refine / cancel / fetch draft，渲染 question / options / `allowCustom`，展示 draft，并把 draft 填入 Web 自己的常规 composer。`ask` 与 `await_accept` 均可 accept / refine。
- Web 路径必须先经 P-web 探针证明：要么 Host bundle 能注册合法的同源 GET HTML 路由，要么 bundle 的 Client half 可通过公开挂载点 / panel 注入最小 UI。若 stock Web 暂无插件 UI 挂载点，可接受的兜底是 Host DIY 的最小页面（仍只走同一 Remote）；不可接受的是为 Web 单开接口或字段。
- 仅用脚本或 `/api` POST 调通 Remote 只证明 T3，不构成 T7 的 Web-only UI 验收。
- **验收硬条件**：在**未安装 SeekTTY** 的环境完成一次完整的澄清 → draft 回合。

## 9. 打包与安装

- 独立 npm 包，含 `dsh.bundle.patch` 清单；不含任何 `workspace:` 依赖；`package.json` 中不出现对 `seektty` 的任何依赖或引用。
- 安装 / 卸载 / 重装全部走原生命令：`dsh plugin --profile <p> add <spec>` / `remove` / 再次 `add`。
- 兼容策略不得锁死在单一 dsh 版本：最低基线为官方 `@deepseek-ai/dsh@0.1.0-rc.6`，发布前必须至少分别实测 **rc.6、rc.7、当时 npm `latest`，以及与 `latest` 不同时的官方 `next`**。公开兼容表只把实际跑过第 11 节合同的精确版本标为“已验证”；对尚未发布的未来版本采用公开能力探测 + 包内版本化适配器 + 安全降级，不虚构“已验证”结论，也不得无故设置上限或写死 rc.6/rc.7 私有实现。2026-08-20 的标签快照为 `latest=0.1.0-rc.7`、`next=0.1.0-rc.8`。
- 已发布首版为 `0.1.0`；本轮六方法动态语义协议的目标版本为 `0.2.0`（Unreleased）。只有 T0(a–d) 全部闭合、联合验收通过且获得远程动作授权后，才从合并后的 `main` 创建 annotated `v0.2.0`，GitHub Release 附带 `pnpm pack` 生成的 tgz、`SHA256SUMS`、精确 dsh 兼容范围与安装 / 校验说明；不发布 npm、不引入 SBOM / SLSA / provenance 工作流。

## 10. 有序任务（小步、每步可验证）

| # | 任务 | 验证方式 |
| --- | --- | --- |
| T0 | **能力探针（闸门）**：在相互隔离的 `DSH_HOME` 上，对官方 stock dsh rc.6、rc.7、执行时 npm `latest` 与不同于 `latest` 的官方 `next` 分别运行同一套 P-usage（直接 `ctx.llm.stream`、no-tools、无 Agent-loop 标记，比较事件 / deriveMessages / Surface 与 usage 投影）、P-header（system / tools 改变而无新消息，验证 `contextVersion` 与 `modelRouteId` 的公开指纹面）、P-web（stock Web、无 SeekTTY，验证 Remote 及合法 UI 挂载路径），并验证 (a) off-transcript、no-tools 补全；(b) 只读上下文及修订标识；(c) Surface 可发现 Remote；(d) usage / limits / cancel 通道 | 每个精确版本的四项逐条“可行 / 阻塞”并附可重跑证据；任一目标版本阻塞则该版本的 T4+ 停止并发布精确阻塞报告，T1-T3 仍可继续；CI 保留动态 latest/next 发现未来兼容回归 |
| T1 | 包骨架：独立包 + `dsh.bundle.patch`，空插件可被加载 | `dsh plugin add` → 启动 → `remove` → 再 `add`，四步在隔离 `DSH_HOME` 全绿；`/doctor` 无错误 |
| T2 | 进程状态机与 TTL 表（推理用固定桩代替） | 单测覆盖全部状态迁移、TTL 到期、幂等 cancel、单 Session 单活跃进程 |
| T3 | Remote 落地六接口（仍用桩推理），含错误与状态回显 | 用脚本客户端解包 `clarify.wire/1` 后跑 start → answer×N → refine → accept → fetch draft，以及 ask 上的 accept；对 stale / cancelled 进程调 answer / refine 得到正确内层拒绝 |
| T4 | 接入真实 Harness router：澄清式提问的 prompt 策略与 draft 生成；严格 off-transcript、no-tools | 真实补全一轮后，dump Session transcript 与前后逐字节比对，零差异；确认无工具调用记录 |
| T5 | stale 侦测：订阅 Session 切换、路由变化、新正式消息、compaction、recall 注入，逐项翻转 stale | 逐事件触发并断言状态与 `staleReason`；stale 后 fetch draft 拿不到 draft |
| T6 | usage / limits / cancel / 错误全量走既有通道 | 官方 Agent `tokenUsage` 保持权威且不被 Clarify 改写；Clarify 辅助消耗只出现在 Auxiliary Runtime 私有 `auxiliary_runtime` ledger；触发限额时进程得到既有错误并终止；cancel 中断进行中的补全 |
| T7 | Web-only 验收：stock Web 或 Host DIY 页面完成完整回合 | 无 SeekTTY 环境下，人工走完澄清 → draft → 手动粘入 Web composer → 常规发送 |
| T8 | 固化第 11 节测试计划为可重跑脚本，记录兼容基线 | 单命令重跑全绿；README 级文档写明精确 dsh 范围 |

## 11. 测试计划

全部测试使用彼此隔离的 `DSH_HOME`，在官方 stock dsh rc.6、rc.7、执行时 npm `latest` 与不同于 `latest` 的官方 `next` 上分别执行；与 dsh 无关的纯状态机测试只需运行一次，但 Host / Remote / lifecycle / Web 合同不得共用结论：

1. **安装合同**：add → boot → remove → 再 add，Profile 状态干净，`/doctor` 零错误零警告。
2. **transcript 零污染**：任意完整回合前后，Session transcript、input queue、pending、Plan、Goal、分支列表逐项比对无变化。
3. **stale 全事件**：Session 切换、`modelRouteId` 变化、新正式消息、compaction、recall 注入、TTL 到期，六种触发各自产生正确的 `staleReason`，且 stale 结果无法被继续消费。
4. **cancel**：交互中 cancel、补全进行中 cancel、重复 cancel，均到达终态且 Harness 侧请求被中断。
5. **usage / limits**：官方 Agent `tokenUsage` 是权威面；Clarify 辅助用量只在 Auxiliary Runtime 私有 `auxiliary_runtime` ledger。限额触发时得到既有标准错误。不得把无 key / mock 写成已把消耗记入 Session 用量。
6. **错误**：路由不可用、上下文读取失败等，源点抛带 `category` 的 `ClarifyError`；Remote 包装为内层 `clarify.wire/1`。外层 Gateway / 载体中止仍走 Harness 通道，不得用 code/message 反推 category。
7. **Web-only**：不安装 SeekTTY 完成完整回合（对应 T7）。
8. **无自动发送**：全套测试中断言从未出现由插件发起的 `session.prompt` 或等价提交。

## 12. 风险与阻塞

- **头号阻塞**：dsh 可能不存在 off-transcript、no-tools 补全通道。对策已定：T0 探针 + 阻塞报告，禁止隐藏 Session 与"发了再藏"两种绕法（被明确拒绝的替代方案）。
- **`contextVersion` 无单一官方修订号**：降级为模型可见 system / tools / derived messages 的稳定规范化指纹（6.1 已定）；若公开字段不足以覆盖这些输入则阻塞，不得退化为 `session.seq` 或 transcript-only hash。
- **官方 tokenUsage 不接收 Clarify 辅助用量**：如实保持官方 Agent `tokenUsage` 权威，辅助用量只在 `auxiliary_runtime` ledger（6.7 已定）。
- **stock Web 无 UI 挂载点**：Host DIY 页面兜底（第 8 节已定）。
- **Host 重启丢状态**：设计上等价全体 cancel，可接受（第 7 节已定）。

## 13. 附录：接口边界（两本任务书逐字一致）

- 插件拥有：临时推理进程、接口（Host Remote / API）、TTL 状态、Harness 注入（router / 上下文读取 / usage / limits / cancel）、stale 与 cancel 规则、draft 文本的生成。
- SeekTTY 拥有：现有 TUI 全部能力、后续体验打磨、可选的壳层（仅调用插件接口）。
- Web 拥有：基于同一套接口的自己的壳层。
- 共享：第 4 节契约块与接口词汇。
- 禁止：SeekTTY 定义插件不存在的字段；插件调用 SeekTTY API；任何一方自动提交 draft。

若某任务需要变更契约：先改任务书 A（本书是契约与接口规范的唯一来源），任务书 B 只做一行跟进。绝不允许反向。
