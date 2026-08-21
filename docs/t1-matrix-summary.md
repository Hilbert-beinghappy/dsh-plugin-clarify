# T1 矩阵摘要

> 历史 rc.6 / rc.7 / rc.8 行来自既有全矩阵。`0.1.1-rc.2` 行来自本轮精确 lane `pnpm t1:dsh011rc2`，不是全矩阵重跑。
> `docs/t0-evidence/0.1.1-rc.1/` 是同日被替换版本的历史观察，不能代替 rc.2，本目录不得覆写或删除。
> 各精确版本结论只写在 `docs/t0-evidence/<version>/`，本文件不覆盖那些目录。
> dist-tags 本轮观察到 `latest=0.1.1-rc.2 next=0.1.1-rc.2`；默认矩阵去重到 pinned set。`latest` / `next` 是动态发现，不是对未发布版本的保证。
> standalone T1 只陈述 stock add/boot/remove/re-add lifecycle。任务书 /doctor 零错误零警告是 final cross-project acceptance，待 Task B 既有本地 /doctor 联调。在联调证据存在前不得把 T1 写成完全通过。stock dsh 无 doctor 不得使本矩阵永久红。

pinned production lanes: `0.1.0-rc.6`, `0.1.0-rc.7`, `0.1.0-rc.8`, `0.1.1-rc.2`

| 请求元包 | CLI | base | 混合树 | standalone lifecycle | cross-project doctor | T1 完全通过 | 退出码 | 分版本报告 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.1.0-rc.6 | 0.1.0-rc.6 | 0.1.0-rc.8 | true | 通过 | 待联调 | 未完成 | 0 | docs/t0-evidence/0.1.0-rc.6/t1-report.md |
| 0.1.0-rc.7 | 0.1.0-rc.7 | 0.1.0-rc.8 | true | 通过 | 待联调 | 未完成 | 0 | docs/t0-evidence/0.1.0-rc.7/t1-report.md |
| 0.1.0-rc.8 | 0.1.0-rc.8 | 0.1.0-rc.8 | false | 通过 | 待联调 | 未完成 | 0 | docs/t0-evidence/0.1.0-rc.8/t1-report.md |
| 0.1.1-rc.2 | 0.1.1-rc.2 | 0.1.1-rc.2 | false | 通过 | 待联调 | 未完成 | 0 | docs/t0-evidence/0.1.1-rc.2/t1-report.md |

历史观察（同日被替换，不是生产 pin，不能代替 rc.2）：

| 请求元包 | CLI | base | 混合树 | standalone lifecycle | cross-project doctor | T1 完全通过 | 退出码 | 分版本报告 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.1.1-rc.1 | 0.1.1-rc.1 | 0.1.1-rc.1 | false | 通过 | 待联调 | 未完成 | 0 | docs/t0-evidence/0.1.1-rc.1/t1-report.md |

T1 standalone 退出 0：4/4（生产 pinned 行）。T1 完全通过：0/4。cross-project doctor 待联调不得把 standalone 合同打红。
记录的退出码 0（生产 pinned 行 + 历史 rc.1）：5/5
