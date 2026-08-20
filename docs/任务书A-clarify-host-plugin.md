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

- start / answer / cancel / fetch draft
- `processId`、`sessionId`、`contextVersion`、`modelRouteId`
- question、options、`multiple`、`allowCustom`、最终 draft 文本
- 状态：running / cancelled / stale / complete
- 用量与错误走既有 Harness 通道

## 5. 架构：为什么是 Host 插件，谁拥有什么

### 5.1 为什么必须是 Host 插件，而不是 Agent / Skill / 工具插件

本插件需要的四样东西，只有 Host 插件位面能拿到：

1. **注入 Harness LLM router**：以当前 Session 的 `modelRouteId` 发起一次**脱离 transcript、禁用工具**的补全（off-transcript, no-tools completion）。
2. **注入 Session 上下文读取器**：只读地获取当前 Session 上下文与其修订标识（`contextVersion`）。
3. **注入 usage / limits / cancel**：把本进程的推理消耗记入 Harness 既有用量通道，受既有限额约束，并可被 Harness 取消。
4. **注册一个 Remote**：让任意 Surface（官方 Web、SeekTTY、未来的壳）通过统一 RPC 面调用 start / answer / cancel / fetch draft。

Agent 插件跑的是常规 Agent 循环（违反契约"不得运行常规 Agent 循环"）；Skill 走 transcript（违反"不得创建正式消息"）；工具插件由 Agent 调用（方向反了，这里是 Surface 调用插件）。因此结论固定为 Host 插件。

**阻塞声明**：T0(a) 至 T0(d) 任一能力在当前官方 dsh 中不存在，T4 及以后全部阻塞；T1 至 T3 的无真实推理骨架、状态机与桩 Remote 可以继续并公开交付。此时必须发布一份精确到公开 API 缺口的阻塞报告，指明需要 Harness 侧补齐的 Host inject / Remote / usage / limits / cancel 能力。**禁止**用隐藏 Session、向真实 Session 写入伪造或空的 assistant/message 再隐藏、或另建私有计量器来绕过——这些是硬禁令，不是备选方案。

### 5.2 所有权划分

| 归属 | 内容 |
| --- | --- |
| Harness（Host 服务，插件只消费） | 模型与 Provider 路由、凭据、Profile、Session 上下文读取、用量记录、限额、取消信号、错误通道、插件安装与生命周期（`dsh plugin`） |
| 本插件 | 临时推理进程状态机、TTL 进程状态、start / answer / cancel / fetch draft 四个接口、stale 侦测与标记、澄清提问与 draft 生成的 prompt 策略、Remote 注册 |
| Surface（Web / SeekTTY / 其他） | 各自的壳：发现 Remote、渲染 question / options / `allowCustom`、展示 draft、把 draft 填入各自的常规 composer |
| 用户 | 决定是否发送 draft；发送只走常规 Session 提交路径 |

## 6. 接口规范与数据流

本节是接口的规范文本。字段用表格描述，不给代码；实现者按 Harness Remote 惯例落地形状，但**字段名与状态名不得偏离本节**。

### 6.1 通用规则

- 每个响应都携带：`processId`、当前状态（running / cancelled / stale / complete）、进程绑定的 `contextVersion` 与 `modelRouteId` 回显。
- 状态为 stale 时必须携带 `staleReason`（枚举：session-changed / route-changed / context-changed / new-official-message / compaction / recall-injection / ttl-expired）。
- 错误不自造错误体系：走 Harness 既有错误通道，Surface 收到的错误形状与其他 Host 调用一致。
- `contextVersion` 的取值来源：优先使用 Harness 暴露的上下文修订标识；若当前 dsh 版本不暴露，则降级为对**模型可见输入**做稳定规范化指纹，至少覆盖 system prompt、工具 schema 上下文与 Harness 派生后的消息历史。不得使用只反映日志长度的 `session.seq`，也不得只 hash transcript。具体公开字段必须先经 P-header 探针证明；两种来源对消费者透明，消费者只做不透明字符串的相等比较。
- `modelRouteId` 是 Harness 当前路由的稳定规范化指纹；候选输入为公开 `requestHeader().config` 中的 provider、model、reasoningEffort 三元组，最终字段来源必须经 P-header 探针证明。

### 6.2 start

| 方向 | 字段 | 说明 |
| --- | --- | --- |
| 请求 | `sessionId` | 必填。绑定的当前 Session。 |
| 请求 | seedText | 可选。用户已敲出的半成品文字，作为澄清起点。 |
| 响应 | `processId` | 新建进程标识。 |
| 响应 | `contextVersion`、`modelRouteId` | 进程创建瞬间从 Harness 读取并绑定，此后不变。 |
| 响应 | question | 第一轮问题（见 6.3 的 question 形状）。 |

同一 `sessionId` 上已有 running 进程时，start 先 cancel 旧进程再新建（一 Session 至多一个活跃进程）。

### 6.3 answer

| 方向 | 字段 | 说明 |
| --- | --- | --- |
| 请求 | `processId`、questionId | 必填。 |
| 请求 | selectedOptionIds 或 customText | 二选一；customText 仅当该 question 的 `allowCustom` 为真时合法。 |
| 响应 | 下一个 question，**或** 状态翻转为 complete | complete 时 draft 已就绪，可 fetch。 |

question 的形状：questionId、题干文本、options 列表（每项含 optionId 与展示文本）、必填的 `multiple` 布尔值、`allowCustom` 布尔值。一轮一个 question；多问必须拆成多轮。

- `multiple = false` 时，selectedOptionIds 必须恰好含一个 optionId。
- `multiple = true` 时，selectedOptionIds 必须至少含一个 optionId。
- selectedOptionIds 与 customText 严格异或；不支持“多选再附加自定义文本”，也不接受空选择。

对 stale / cancelled / complete 状态的进程调用 answer，返回该状态与 `staleReason`（如适用），不执行任何推理。

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
| 响应 | 状态 + draft 文本 | 仅 complete 时含 draft 文本；running 返回状态；stale 返回状态与 `staleReason`，不返回 draft。 |

draft 是纯用户草稿文本。它不是助手回复、不是计划、不含工具调用指令。

### 6.6 状态机与 stale 规则

- running →（answer 循环）→ complete；running → cancelled；running / complete → stale。
- 进入 stale 后只允许 cancel 或对同一 Session 重新 start；stale 的 question / options / draft 一律不得继续消费——接口层面强制，不依赖 Surface 自觉。
- 触发 stale 的事件（插件必须订阅 Harness 相应信号）：绑定 Session 被切换或归档、`modelRouteId` 变化、`contextVersion` 变化、主 Session 出现新的正式消息、compaction、recall / 上下文注入。
- TTL 到期（默认建议 15 分钟无交互，可由实现调整但必须有）等价 stale（`staleReason` = ttl-expired）并随即清理。

### 6.7 用量归属

每次补全的 token 消耗经 Harness 既有 usage 通道记入绑定 Session 的用量，并以 Harness 支持的来源标注方式标记为本插件进程所产生（若当前 dsh 的 usage 通道不支持来源标注，如实记入 Session 用量即可，并在兼容性说明中记录该限制）。不新建任何计量体系。

## 7. 进程状态

- **存放处**：Host 进程内存中、由本插件持有的 TTL 表，键为 `processId`，值为绑定四元组（`processId` / `sessionId` / `contextVersion` / `modelRouteId`）、状态、问答历史、draft。
- **禁止持久化到**：磁盘文件、Profile、Settings 命名空间、`.env`、Session transcript、SeekTTY 任何文件。没有例外。
- **清理时机**：cancel 即刻清理；stale 即刻清理（仅保留可查询的终态与 `staleReason`，保留期不超过 TTL）；complete 后 draft 被 fetch 一次或 TTL 到期后清理。
- **Host 重启**：进程状态随之消失，等价于全体 cancel。这是可接受的——进程本就是临时的。重启后 Surface 对旧 `processId` 的任何调用得到"进程不存在"的常规错误。

## 8. Web / 官方 Harness 路径

- 官方 Web（或 Host DIY 页面）通过与 SeekTTY 完全相同的 Remote 调用 start / answer / cancel / fetch draft，渲染 question / options / `allowCustom`，展示 draft，并把 draft 填入 Web 自己的常规 composer。
- Web 路径必须先经 P-web 探针证明：要么 Host bundle 能注册合法的同源 GET HTML 路由，要么 bundle 的 Client half 可通过公开挂载点 / panel 注入最小 UI。若 stock Web 暂无插件 UI 挂载点，可接受的兜底是 Host DIY 的最小页面（仍只走同一 Remote）；不可接受的是为 Web 单开接口或字段。
- 仅用脚本或 `/api` POST 调通 Remote 只证明 T3，不构成 T7 的 Web-only UI 验收。
- **验收硬条件**：在**未安装 SeekTTY** 的环境完成一次完整的澄清 → draft 回合。

## 9. 打包与安装

- 独立 npm 包，含 `dsh.bundle.patch` 清单；不含任何 `workspace:` 依赖；`package.json` 中不出现对 `seektty` 的任何依赖或引用。
- 安装 / 卸载 / 重装全部走原生命令：`dsh plugin --profile <p> add <spec>` / `remove` / 再次 `add`。
- 兼容策略不得锁死在单一 dsh 版本：最低基线为官方 `@deepseek-ai/dsh@0.1.0-rc.6`，发布前必须至少分别实测 **rc.6、rc.7、当时 npm `latest`，以及与 `latest` 不同时的官方 `next`**。公开兼容表只把实际跑过第 11 节合同的精确版本标为“已验证”；对尚未发布的未来版本采用公开能力探测 + 包内版本化适配器 + 安全降级，不虚构“已验证”结论，也不得无故设置上限或写死 rc.6/rc.7 私有实现。2026-08-20 的标签快照为 `latest=0.1.0-rc.7`、`next=0.1.0-rc.8`。
- 仓库保持公开。首版版本为 `0.1.0`，合并后从 `main` 创建 annotated `v0.1.0`，GitHub Release 附带 `pnpm pack` 生成的 tgz、`SHA256SUMS`、精确 dsh 兼容范围与安装 / 校验说明；首版不发布 npm、不引入 SBOM / SLSA / provenance 工作流。

## 10. 有序任务（小步、每步可验证）

| # | 任务 | 验证方式 |
| --- | --- | --- |
| T0 | **能力探针（闸门）**：在相互隔离的 `DSH_HOME` 上，对官方 stock dsh rc.6、rc.7、执行时 npm `latest` 与不同于 `latest` 的官方 `next` 分别运行同一套 P-usage（直接 `ctx.llm.stream`、no-tools、无 Agent-loop 标记，比较事件 / deriveMessages / Surface 与 usage 投影）、P-header（system / tools 改变而无新消息，验证 `contextVersion` 与 `modelRouteId` 的公开指纹面）、P-web（stock Web、无 SeekTTY，验证 Remote 及合法 UI 挂载路径），并验证 (a) off-transcript、no-tools 补全；(b) 只读上下文及修订标识；(c) Surface 可发现 Remote；(d) usage / limits / cancel 通道 | 每个精确版本的四项逐条“可行 / 阻塞”并附可重跑证据；任一目标版本阻塞则该版本的 T4+ 停止并发布精确阻塞报告，T1-T3 仍可继续；CI 保留动态 latest/next 发现未来兼容回归 |
| T1 | 包骨架：独立包 + `dsh.bundle.patch`，空插件可被加载 | `dsh plugin add` → 启动 → `remove` → 再 `add`，四步在隔离 `DSH_HOME` 全绿；`/doctor` 无错误 |
| T2 | 进程状态机与 TTL 表（推理用固定桩代替） | 单测覆盖全部状态迁移、TTL 到期、幂等 cancel、单 Session 单活跃进程 |
| T3 | Remote 落地四接口（仍用桩推理），含错误与状态回显 | 用脚本客户端跑 start → answer×N → fetch draft 全流程；对 stale / cancelled 进程调 answer 得到正确拒绝 |
| T4 | 接入真实 Harness router：澄清式提问的 prompt 策略与 draft 生成；严格 off-transcript、no-tools | 真实补全一轮后，dump Session transcript 与前后逐字节比对，零差异；确认无工具调用记录 |
| T5 | stale 侦测：订阅 Session 切换、路由变化、新正式消息、compaction、recall 注入，逐项翻转 stale | 逐事件触发并断言状态与 `staleReason`；stale 后 fetch draft 拿不到 draft |
| T6 | usage / limits / cancel / 错误全量走 Harness 通道 | 补全消耗出现在 Session 用量中；触发限额时进程得到 Harness 错误并终止；cancel 中断进行中的补全 |
| T7 | Web-only 验收：stock Web 或 Host DIY 页面完成完整回合 | 无 SeekTTY 环境下，人工走完澄清 → draft → 手动粘入 Web composer → 常规发送 |
| T8 | 固化第 11 节测试计划为可重跑脚本，记录兼容基线 | 单命令重跑全绿；README 级文档写明精确 dsh 范围 |

## 11. 测试计划

全部测试使用彼此隔离的 `DSH_HOME`，在官方 stock dsh rc.6、rc.7、执行时 npm `latest` 与不同于 `latest` 的官方 `next` 上分别执行；与 dsh 无关的纯状态机测试只需运行一次，但 Host / Remote / lifecycle / Web 合同不得共用结论：

1. **安装合同**：add → boot → remove → 再 add，Profile 状态干净，`/doctor` 零错误零警告。
2. **transcript 零污染**：任意完整回合前后，Session transcript、input queue、pending、Plan、Goal、分支列表逐项比对无变化。
3. **stale 全事件**：Session 切换、`modelRouteId` 变化、新正式消息、compaction、recall 注入、TTL 到期，六种触发各自产生正确的 `staleReason`，且 stale 结果无法被继续消费。
4. **cancel**：交互中 cancel、补全进行中 cancel、重复 cancel，均到达终态且 Harness 侧请求被中断。
5. **usage / limits**：消耗记入 Session 用量；限额触发时得到 Harness 标准错误。
6. **错误**：路由不可用、上下文读取失败等，错误形状与其他 Host 调用一致，无自造错误体系。
7. **Web-only**：不安装 SeekTTY 完成完整回合（对应 T7）。
8. **无自动发送**：全套测试中断言从未出现由插件发起的 `session.prompt` 或等价提交。

## 12. 风险与阻塞

- **头号阻塞**：dsh 可能不存在 off-transcript、no-tools 补全通道。对策已定：T0 探针 + 阻塞报告，禁止隐藏 Session 与"发了再藏"两种绕法（被明确拒绝的替代方案）。
- **`contextVersion` 无单一官方修订号**：降级为模型可见 system / tools / derived messages 的稳定规范化指纹（6.1 已定）；若公开字段不足以覆盖这些输入则阻塞，不得退化为 `session.seq` 或 transcript-only hash。
- **usage 通道不支持来源标注**：如实记入 Session 用量并记录限制（6.7 已定）。
- **stock Web 无 UI 挂载点**：Host DIY 页面兜底（第 8 节已定）。
- **Host 重启丢状态**：设计上等价全体 cancel，可接受（第 7 节已定）。

## 13. 附录：接口边界（两本任务书逐字一致）

- 插件拥有：临时推理进程、接口（Host Remote / API）、TTL 状态、Harness 注入（router / 上下文读取 / usage / limits / cancel）、stale 与 cancel 规则、draft 文本的生成。
- SeekTTY 拥有：现有 TUI 全部能力、后续体验打磨、可选的壳层（仅调用插件接口）。
- Web 拥有：基于同一套接口的自己的壳层。
- 共享：第 4 节契约块与接口词汇。
- 禁止：SeekTTY 定义插件不存在的字段；插件调用 SeekTTY API；任何一方自动提交 draft。

若某任务需要变更契约：先改任务书 A（本书是契约与接口规范的唯一来源），任务书 B 只做一行跟进。绝不允许反向。
