# T7 证据（0.1.1-rc.2）

> 协议 `t7/1`。只记录布尔值与粗带。
> 本文件记录一次 Web-only T7（t7/1 `fullT7=true`）。这不是 T4 transcript dump，不是 T5 stale，不是 T6 usage/limits，也不是新推荐联合基线。
> 污染项 `transcript/queue/pending/plan/goal` 因无公开读缝记 `unavailable`，不等于已证明 unchanged。Clarify 窗内公开 `session.list` 投影 unchanged；官方发送后 `blankTurns` 变为有 turn。无 key / mock / `--from-pack` 仍不等于该结论。
> 用户价值证据必须来自校验和核验的已发布资产。

## 总结论

| 项 | 结论 |
| --- | --- |
| 闸门 | T7 |
| G0 | 阻塞 |
| 完整 T7 | 是 |
| 无 key | false |
| 资产 | from-release / 校验和核验=true / 用户价值=true |
| 推荐联合基线 | 否 |
| SeekTTY | 未安装 |
| schema | 通过 |

## G0

- Start：`n/a`
- 调用前快照：立即、第一次 Clarify RPC 之前（`immediate=true`，`beforeFirstClarifyRpc=true`）
- session 计数：`unchanged`
- blank / turns：`unchanged`
- 官方用量：`unchanged`
- Session 标签：`source=official-public-remote`，`productionPluginCreated=false`，`createdByThisScript=true`
- 插件 / DIY 不创建 Session：`true`
