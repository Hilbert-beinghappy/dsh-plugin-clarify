# T0 矩阵摘要

> 摘要由已有精确版本证据刷新，未重跑 Host。当前合同行：`0.1.0-rc.6`, `0.1.0-rc.7`, `0.1.0-rc.8`, `0.1.1-rc.2`。
> dist-tags 快照：`latest=0.1.1-rc.2 next=0.1.1-rc.2`。`latest` / `next` 是动态发现，不是对未发布版本的保证。
> 子进程退出 0 不等于闸门可行。(b)/(d) 阻塞则该版本 T4+ 停止。Host T3「通过」只表示官方 /api 信封完整回合；Session 是隔离测试夹具，见 T3 Session 列。

pinned contract lanes: `0.1.0-rc.6`, `0.1.0-rc.7`, `0.1.0-rc.8`, `0.1.1-rc.2`

| 请求元包 | CLI | base | 混合树 | (a) | (b) | (c) | (d) | Host T3 | T3 Session | 退出码 | 分版本报告 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.1.0-rc.6 | 0.1.0-rc.6 | 0.1.0-rc.8 | true | 可行 | 阻塞 | 可行 | 阻塞 | 通过 | t0-probe-test-fixture | 0 | docs/t0-evidence/0.1.0-rc.6/t0-blocking-report.md |
| 0.1.0-rc.7 | 0.1.0-rc.7 | 0.1.0-rc.8 | true | 可行 | 阻塞 | 可行 | 阻塞 | 通过 | t0-probe-test-fixture | 0 | docs/t0-evidence/0.1.0-rc.7/t0-blocking-report.md |
| 0.1.0-rc.8 | 0.1.0-rc.8 | 0.1.0-rc.8 | false | 可行 | 阻塞 | 可行 | 阻塞 | 阻塞 | t0-probe-test-fixture | 0 | docs/t0-evidence/0.1.0-rc.8/t0-blocking-report.md |
| 0.1.1-rc.2 | 0.1.1-rc.2 | 0.1.1-rc.2 | false | 可行 | 阻塞 | 可行 | 阻塞 | 阻塞 | t0-probe-test-fixture | 0 | docs/t0-evidence/0.1.1-rc.2/t0-blocking-report.md |

历史观察（非生产 pin，不计入矩阵通过率）：

| 请求元包 | CLI | base | 混合树 | (a) | (b) | (c) | (d) | Host T3 | T3 Session | 退出码 | 分版本报告 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.1.1-rc.1 | 0.1.1-rc.1 | 0.1.1-rc.1 | false | 可行 | 阻塞 | 可行 | 阻塞 | 阻塞 | t0-probe-test-fixture | 0 | docs/t0-evidence/0.1.1-rc.1/t0-blocking-report.md |

T0 子进程退出 0 只表示探针跑完并写了报告，不是 (a)–(d) 全绿。
记录的退出码 0：4/4
