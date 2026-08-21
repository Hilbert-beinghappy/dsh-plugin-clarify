# T0 矩阵摘要

> 历史 rc.6 / rc.7 / rc.8 行来自既有全矩阵。`0.1.1-rc.2` 行来自本轮精确 lane `pnpm t0:dsh011rc2`，不是全矩阵重跑。
> `docs/t0-evidence/0.1.1-rc.1/` 是同日被替换版本的历史观察，不能代替 rc.2，本目录不得覆写或删除。
> 各精确版本结论只写在 `docs/t0-evidence/<version>/`，本文件不覆盖那些目录。
> dist-tags 本轮观察到 `latest=0.1.1-rc.2 next=0.1.1-rc.2`；默认矩阵去重到 pinned set。`latest` / `next` 是动态发现，不是对未发布版本的保证。
> 子进程退出 0 不等于闸门可行。(b)/(d) 阻塞则该版本 T4+ 停止。Host T3「通过」只表示官方 /api 信封完整回合；Session 是隔离测试夹具，见 T3 Session 列。

pinned production lanes: `0.1.0-rc.6`, `0.1.0-rc.7`, `0.1.0-rc.8`, `0.1.1-rc.2`

| 请求元包 | CLI | base | 混合树 | (a) | (b) | (c) | (d) | Host T3 | T3 Session | 退出码 | 分版本报告 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.1.0-rc.6 | 0.1.0-rc.6 | 0.1.0-rc.7 | true | 可行 | 阻塞 | 可行 | 阻塞 | 通过 | t0-probe-test-fixture | 0 | docs/t0-evidence/0.1.0-rc.6/t0-blocking-report.md |
| 0.1.0-rc.7 | 0.1.0-rc.7 | 0.1.0-rc.7 | false | 可行 | 阻塞 | 可行 | 阻塞 | 通过 | t0-probe-test-fixture | 0 | docs/t0-evidence/0.1.0-rc.7/t0-blocking-report.md |
| 0.1.0-rc.8 | 0.1.0-rc.8 | 0.1.0-rc.8 | false | 可行 | 阻塞 | 可行 | 阻塞 | 通过 | t0-probe-test-fixture | 0 | docs/t0-evidence/0.1.0-rc.8/t0-blocking-report.md |
| 0.1.1-rc.2 | 0.1.1-rc.2 | 0.1.1-rc.2 | false | 可行 | 阻塞 | 可行 | 阻塞 | 阻塞 | t0-probe-test-fixture | 0 | docs/t0-evidence/0.1.1-rc.2/t0-blocking-report.md |

历史观察（同日被替换，不是生产 pin，不能代替 rc.2）：

| 请求元包 | CLI | base | 混合树 | (a) | (b) | (c) | (d) | Host T3 | T3 Session | 退出码 | 分版本报告 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.1.1-rc.1 | 0.1.1-rc.1 | 0.1.1-rc.1 | false | 可行 | 阻塞 | 可行 | 阻塞 | 阻塞 | t0-probe-test-fixture | 0 | docs/t0-evidence/0.1.1-rc.1/t0-blocking-report.md |

T0 子进程退出 0 只表示探针跑完并写了报告，不是 (a)–(d) 全绿。
记录的退出码 0（生产 pinned 行）：4/4
