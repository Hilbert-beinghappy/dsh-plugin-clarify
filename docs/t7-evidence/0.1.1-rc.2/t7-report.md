# T7 证据（0.1.1-rc.2）

> 协议 `t7/1`。只记录布尔值与粗带。
> G0 无 key 观察**不是完整 T7**。无 key / mock 不等于完整 T7。
> 用户价值证据必须来自校验和核验的已发布资产。`--from-pack` 与 mock 不得写成完整 T7。

## 总结论

| 项 | 结论 |
| --- | --- |
| 闸门 | G0 |
| G0 | 通过 |
| 完整 T7 | 否 |
| 无 key | true |
| 资产 | from-release / 校验和核验=true / 用户价值=true |
| 推荐联合基线 | 否 |
| SeekTTY | 未安装 |
| schema | 通过 |

## G0

- Start：`INFERENCE_UNAVAILABLE` + `providerFailureCode=ENOTSUP`
- 调用前快照：立即、第一次 Clarify RPC 之前（`immediate=true`，`beforeFirstClarifyRpc=true`）
- session 计数：`unchanged`
- blank / turns：`unchanged`
- 官方用量：`unchanged`
- Session 标签：`source=official-public-remote`，`productionPluginCreated=false`，`createdByThisScript=true`
- 插件 / DIY 不创建 Session：`true`

## 剩余 Codex live T7

完整 T7 仍要求校验和核验的已发布 Clarify+Auxiliary 资产对、真实 provider、无 SeekTTY，以及证据支撑的六方法 DIY 旅程、手动粘贴 draft、官方 composer 常规发送、cancel/recovery 观察和公开污染探针。无 key / mock / 七个布尔声明不等于完整 T7。
