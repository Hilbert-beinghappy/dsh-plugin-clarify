# T1 报告（0.1.0-rc.7）

> 本报告只记录本次实际观察到的结果。
> Clarify standalone T1 只陈述 stock add / boot / remove / re-add lifecycle。
> 任务书 `/doctor` 零错误零警告是 final cross-project acceptance，由 Task B 用既有本地 `/doctor` 在安装 Clarify 后验证。
> 本仓库不发明 dsh doctor，不探测 Host `GET /doctor`。在联调证据存在前，不得把 T1 写成完全通过。

## 总结论

| 项 | 结论 |
| --- | --- |
| standalone lifecycle | 通过 |
| cross-project doctor | 待联调 |
| dump 布尔与文字 | 通过 |
| T1 完全通过 | 未完成 |

standalone lifecycle：**通过**
cross-project doctor：**待联调**
T1 完全通过：**未完成**

## cross-project doctor

- 面：`tui-local-/doctor`；范围：`cross-project`
- stock CLI / HTTP 探测：未做（`stockCli=false`，`stockHttp=false`，`invented=false`）
- 结论：待联调 — 任务书 /doctor 零错误零警告是 final cross-project acceptance。由 Task B 用既有本地 /doctor（TUI behavior=local → plugins.doctor()）在安装 Clarify 后验证。stock dsh 无 CLI doctor，也无 Host HTTP /doctor。Clarify 不发明、不探测这些面。

## dump

- after add：`true` / `# == dsh-plugin-clarify
- id: clarify
  name: dsh-plugin-clarify`
- after remove：`false` / `dsh-plugin-clarify not found`
- after re-add：`true` / `# == dsh-plugin-clarify
- id: clarify
  name: dsh-plugin-clarify`
- 一致性：通过

## 环境

- 请求的元包：`@deepseek-ai/dsh@0.1.0-rc.7`
- 解析组件：base `0.1.0-rc.7`
- 混合树：`no` — resolved core components match the requested meta version
- 隔离 `DSH_HOME`：`.probe-work/0.1.0-rc.7/homes/t1`
