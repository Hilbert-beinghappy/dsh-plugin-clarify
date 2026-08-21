<div align="center">

<h1>Clarify</h1>

<p>基于当前 Session 和你的草稿，把模糊想法逐步问成一份待确认、可自行发送的 Draft。</p>

<p>
  <a href="https://github.com/Hilbert-beinghappy/dsh-plugin-clarify/releases"><img src="https://img.shields.io/badge/Version-0.2.2-orange" alt="Version 0.2.2"></a>
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-0.1.1--rc.2-5B5BD6" alt="DeepSeek Harness 0.1.1-rc.2">
  <img src="https://img.shields.io/badge/Host%20still%20supported-0.1.0--rc.8-0A7EA4" alt="Host 0.1.0-rc.8 still supported">
  <img src="https://img.shields.io/badge/Host%20Plugin-Clarify-0A7EA4" alt="DeepSeek Harness Host plugin">
  <a href="https://github.com/Hilbert-beinghappy/dsh-plugin-clarify/actions/workflows/ci.yml"><img src="https://github.com/Hilbert-beinghappy/dsh-plugin-clarify/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow" alt="MIT License"></a>
</p>

<p>
  <a href="#项目概览">项目概览</a>
  ·
  <a href="#clarify-与-plan">Clarify 与 Plan</a>
  ·
  <a href="#使用体验">使用体验</a>
  ·
  <a href="#工作原理">工作原理</a>
  ·
  <a href="#快速开始">快速开始</a>
  ·
  <a href="#接口与兼容">接口与兼容</a>
</p>

<p>中文主文档 · <a href="https://github.com/Hilbert-beinghappy/seektty#clarify-and-plan">English overview</a></p>

</div>

---

## 项目概览

Clarify 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Host 插件。它绑定当前真实 Session，读取用户草稿与模型可见上下文，沿当前模型路由生成苏格拉底式问题、上下文相关选项、后续分支和 live Draft preview。用户每回答一个问题，后续状态与预览稿都会吸收已经确认的决定；仍有关键未知时继续追问，预览已经可发送时进入审阅。

澄清完成后，Clarify 冻结当前预览并返回一份待用户确认的 Draft。终端中的 [SeekTTY](https://github.com/Hilbert-beinghappy/seektty) 会把它写回普通输入框，用户可以继续编辑并决定何时发送。其他 Surface 可以通过同一组 Remote 接入；仓库自带的 `GET /clarify` 提供 Host DIY 页面。

真实推理由同一 Host 进程中的 [Auxiliary Runtime](https://github.com/Hilbert-beinghappy/dsh-plugin-auxiliary-runtime) 执行并单独计量。Clarify 专注于澄清状态机与 Draft 生成，模型准备、流式输出、限额、取消和辅助用量由 Auxiliary Runtime 统一承接。

```text
[当前 Session + 用户草稿]
              |
              v
     +------------------+      start / answer / refine
     | 消费 Surface     | --------------------------------+
     | SeekTTY 或 DIY   | <-------------------------------+|
     +--------+---------+      问题 / 选项 / live Draft    ||
              |                                           ||
              | accept                                    vv
              |                                  +------------------+
              |                                  | Clarify          |
              |                                  | 决策与预览状态   |
              |                                  +--------+---------+
              |                                           |
              |                                           | 同进程 run
              |                                           v
              |                                  +------------------+
              |                                  | Auxiliary Runtime|
              |                                  | 模型 / 限额 /用量|
              |                                  +------------------+
              v
       [待确认 Draft]
              |
              | 用户审阅并发送
              v
       [正式 Session 消息]
              |
              | 需要实施方案时
              v
       [Harness 原生 /plan]
```

## Clarify 与 Plan

Clarify 和 Plan 接在同一条工作流的前后两段。

Clarify 处理“要做什么还需要问清”的阶段：读取当前 Session 与输入草稿，逐题追问，并把答案写进不断更新的 live Draft preview。采用之后，你得到一份与当前 preview 一致的 Draft，可以在普通输入框里确认和修改。

Plan 处理“需求已经明确、需要决定怎么做”的阶段：Harness 原生 `/plan` 把已经提交的需求写成实施方案，并进入计划审查。

推荐路径是先用 `/clarify` 问清需求并采用 Draft，审阅后发送，再在需要时运行 `/plan`。Clarify 产出用户需求草稿，Plan 产出实施方案，两者共同覆盖从模糊想法到可执行工作的完整过程。

## 使用体验

### 在 SeekTTY 中

兼容的 Clarify 六方法 Remote 与 `clarify.wire/1` 激活后，SeekTTY 会把 `/clarify` 加入本地命令目录。当前未发布目标是 `0.2.2`；已发布回滚工件仍是 `0.2.1` / `0.2.0`。

- 从命令面板执行：保留整个输入区作为 seed。
- 输入 `/clarify some text`：以参数文本作为 seed。
- 在现有草稿末尾单独加入 `/clarify` token 或一行：以前面的草稿作为 seed。

需要继续澄清时，界面通常一次只显示一道基于上下文生成的问题、对应选项和最新 Draft preview；预览已经达到可发送状态时，流程会直接进入审阅。提问次数由当前 Session、草稿和已确认决定共同确定。你可以选择选项、输入自定义答案、直接 refine 当前预览、采用当前 Draft，或结束本次澄清。采用后，完整 Draft 回到普通输入框；发送仍由用户明确完成。

### Host DIY 页面

`GET /clarify` 使用相同的 `/api` Remote，适合集成验证和其他 Surface 开发。页面要求填入一个已经存在的 `sessionId`，澄清结束后可以复制 Draft，并在原 Surface 中自行发送。

## 工作原理

### 动态问题与逐答预览

问题、选项和 Draft preview 均由模型根据当前 Session、初始草稿、已经接受的决定和上一版预览动态生成。每轮输出都经过结构化校验；新预览需要体现本轮决定，后续问题会沿已经确认的方向继续深入。`refine` 接收一次性反馈，在保留已确认决定的基础上重写当前预览。

### 临时澄清状态

每个进程绑定已有 `sessionId`，状态为 `running`、`cancelled`、`stale` 或 `complete`。默认 15 分钟无交互后进入 `stale`，并返回 `staleReason=ttl-expired`。Session、模型路由或上下文发生影响一致性的变化时，进程也会以明确原因进入 `stale`。终态 Draft 通过单独的 `fetchDraft` 返回。

### 主 Session 对话记录

问题、选项、live Draft preview 和 refine 反馈保留在 Host 内存中的临时进程里。主 Session transcript 继续保存正式对话：用户审阅并发送后的消息、助手回复、工具记录，以及随后 `/plan` 产生的计划审查。澄清状态与 input queue、pending、Plan、Goal、Profile 和本地文件相互分离。

### 辅助模型用量

每一次模型调用都经同进程 `auxiliaryRuntime` 执行，用量写入官方 `storageDomain` 的 `auxiliary_runtime` 域。官方 `tokenUsage` 继续表示 Agent 循环。SeekTTY `/status` 在快照健康时分栏展示 Official、Auxiliary 和读取时派生的 Combined。配对规则只写在文档里：Host `0.1.1-rc.2` 配 Auxiliary Runtime `0.1.1`，Host `0.1.0-rc.8` 配 `0.1.0`（`0.1.1` 仍承认 rc.8）。Clarify 不把这对规则做成 wire 或公共 API 检查。

辅助账本保存调用标识、purpose、状态、Token 桶、规范化失败和时间戳。prompt、消息正文、模型输出、自定义回答、凭据和文件路径保留在账本之外。

## 快速开始

### 已发布旧栈（回滚）

最近一次联合验收仍是官方 `@deepseek-ai/dsh@0.1.0-rc.8` + Clarify `0.2.1` + Auxiliary Runtime `0.1.0` + SeekTTY `1.2.0`。从 GitHub Releases 安装已经构建好的 tarball。

在终端体验 `/clarify` 时，把三包安装进同一个 `tui` Profile：

```sh
pnpm add --global @deepseek-ai/dsh@0.1.0-rc.8

dsh plugin --profile tui add https://github.com/Hilbert-beinghappy/seektty/releases/download/v1.2.0/seektty-1.2.0.tgz
dsh plugin --profile tui add https://github.com/Hilbert-beinghappy/dsh-plugin-auxiliary-runtime/releases/download/v0.1.0/dsh-plugin-auxiliary-runtime-0.1.0.tgz
dsh plugin --profile tui add https://github.com/Hilbert-beinghappy/dsh-plugin-clarify/releases/download/v0.2.1/dsh-plugin-clarify-0.2.1.tgz
dsh --profile tui
```

Host DIY 页面使用独立的 `web` Profile：

```sh
dsh plugin --profile web add https://github.com/Hilbert-beinghappy/dsh-plugin-auxiliary-runtime/releases/download/v0.1.0/dsh-plugin-auxiliary-runtime-0.1.0.tgz
dsh plugin --profile web add https://github.com/Hilbert-beinghappy/dsh-plugin-clarify/releases/download/v0.2.1/dsh-plugin-clarify-0.2.1.tgz
dsh --profile web
```

卸载和重装继续使用官方原生命令：

```sh
dsh plugin --profile tui remove dsh-plugin-clarify
dsh plugin --profile tui add https://github.com/Hilbert-beinghappy/dsh-plugin-clarify/releases/download/v0.2.1/dsh-plugin-clarify-0.2.1.tgz
```

### 未发布新目标 `0.2.2`

`0.2.2` 的生产目标是精确 Host `0.1.1-rc.2` + Auxiliary Runtime `0.1.1`。`0.1.0-rc.8` 仍作为 admission pin，可配 Auxiliary `0.1.0` 或 `0.1.1`。这不是已发布 Release，也不是完整联合验收。Lane A 无 key 真实 PTY 已观察；Lane B 于 2026-08-22 在 `candidate4` 上已观察，详见 [接口与兼容](#接口与兼容)。`docs/t0-evidence/0.1.1-rc.1/` 是同日被替换版本的历史观察，不能代替 `0.1.1-rc.2`。

安装顺序：先在 Auxiliary Runtime 源码树 `pnpm pack` 得到 `dsh-plugin-auxiliary-runtime-0.1.1.tgz`（尚无 `v0.1.1` GitHub Release 资产，不要编造下载 URL）。本仓库 `pnpm pack` **只**生成 `dsh-plugin-clarify-0.2.2.tgz`，再本地 add Clarify。

```sh
pnpm add --global @deepseek-ai/dsh@0.1.1-rc.2
dsh plugin --profile web add /path/to/dsh-plugin-auxiliary-runtime-0.1.1.tgz
pnpm pack
dsh plugin --profile web add ./dsh-plugin-clarify-0.2.2.tgz
```

安装会按 `package.json#dsh.bundle.patch` 中的 `cordis.patch.yml` 更新目标 Profile。Cordis 子上下文让 Clarify 等待 `auxiliaryRuntime`，Auxiliary Runtime 等待官方 `storageDomain`；服务激活由依赖可用性决定，与添加命令的先后顺序解耦。

## 接口与兼容

Typert Remote 命名空间 `clarify` 提供六个方法：

| 方法 | 作用 |
| --- | --- |
| `start` | 绑定已有 Session 和可选 seed，创建临时澄清进程 |
| `answer` | 提交选项或自定义回答，生成下一问题与新预览 |
| `refine` | 根据一次性反馈重写当前预览 |
| `accept` | 冻结当前预览并进入 `complete` |
| `fetchDraft` | 从完成态单独取得 Draft |
| `cancel` | 结束当前澄清进程 |

消费者使用 stock Connection 信封，例如：

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

公开兼容与验证声明分两层：

| 栈 | 状态 | 组合 | 证据 |
| --- | --- | --- | --- |
| 已发布旧栈 | 已联合验收 | Host `0.1.0-rc.8` + Clarify `0.2.1` + Auxiliary `0.1.0` + SeekTTY `1.2.0` | 2026-08-21 隔离 `DSH_HOME` / 真实 PTY；`0.2.1` 无 Key 复验 add／boot／remove／re-add 与隔离 `MISSING_CREDENTIAL` |
| 未发布新目标 `0.2.2` | Lane A 已观察；Lane B 已观察；非 Release / 非完整联合验收 | Host `0.1.1-rc.2` + Auxiliary `0.1.1` + SeekTTY `1.2.1`；rc.8 仍可配 Auxiliary `0.1.0` 或 `0.1.1` | 2026-08-21 未修改 stock rc.2、隔离 `DSH_HOME`、真实 PTY：`/doctor` 0 error / 0 warning、99 plugins running；`/status` 健康；`/clarify` 到 Auxiliary 后无 key 返回 `MISSING_CREDENTIAL` 且保留 composer；Vision-Exp 可见可选；PNG `/restart` 恢复。丢失源文件：单测仅 basename、两种通知顺序、无绝对路径；hardcopy/可见区只检出 `vision-logo.png`，未检出 `private/tmp`/`/tmp`/`Users`/`Volumes`；不能证明关 onboarding modal 后 restore error 仍显示（Esc 清 notice）。T0/T1 脚本仍是 standalone（T1 写 `/doctor` 待联调 = 脚本未跑 cross-project doctor）。Lane B（2026-08-22，未修改 stock rc.2、隔离 `DSH_HOME`、`candidate4`）：已显式选 Vision-Exp；PNG image-only 成功且发送即清附件、识别 logo，但纯图无问题导致模型又调用 `read_image`；真实 JFIF JPEG 经 SeekTTY 入队、官方 Host 正常转 PNG variant 后，无工具 OCR 成功；Clarify 经 Auxiliary 6 轮动态问答、41 行完整审阅、二次确认 accept 回 composer 且不自动发送；`/status` 有官方／辅助／组合用量；895 文件扫 secret literal 0。未证明 Web UI、GIF/WebP、超限拒绝、JPEG 原字节直通、PNG 完全不靠工具、本轮中断恢复、成本／缓存 A/B |

- `0.2.1` 继承 `0.2.0` 的六方法 Remote、`clarify.wire/1` 和精确 rc.8 兼容边界。`0.2.0` live-provider 联合验收覆盖动态问题／选项／preview、多轮演进、采用后只写回输入框、中断恢复、用量来源和隐私。`0.2.1` 未重跑 live-provider 动态多轮，也没有 cache／cost A/B。
- rc.6 / rc.7 只保留历史探针车道，不是 `0.2.2` 生产组合。

精确兼容矩阵与 T0 证据见 [`docs/compatibility.md`](docs/compatibility.md) 和 [`docs/t0-evidence/`](docs/t0-evidence/)。`pnpm t3` 提供进程内 Remote 冒烟，真实 Host/TUI 验收使用联合轨道。

T0 探针由 `CLARIFY_PROBE=1` 或隔离 `DSH_HOME/.clarify-probe` 标记启用，并提供 `GET /clarify/probe`。这一入口服务于隔离测试夹具；日常 Profile 保持探针关闭。

## 开发

```sh
pnpm install
pnpm test
pnpm build
pnpm pack:check
pnpm t3
pnpm t0:dsh011rc2
pnpm t1:dsh011rc2
pnpm t0:dsh011rc1
pnpm t1:dsh011rc1
pnpm t0:matrix
pnpm t1:matrix
```

`pnpm t0:dsh011rc2` / `pnpm t1:dsh011rc2` 是当前生产精确 lane。`pnpm t0:dsh011rc1` / `pnpm t1:dsh011rc1` 只复现同日被替换的 `0.1.1-rc.1`，不能代替 rc.2。

CI `verify` 运行测试、干净构建、打包检查和进程内冒烟。Release 前还会在三个项目的联合轨道中执行官方 Host、真实 PTY、安装、卸载和重装门禁。

## 许可

[MIT](LICENSE)
