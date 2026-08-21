# T0 阻塞报告索引

> 每份精确版本的结论只存在于 `docs/t0-evidence/<version>/t0-blocking-report.md`。
> 本文件不复制未重跑版本的闸门结论。动态 `latest` / `next` 只用于发现矩阵，不构成对未发布版本的保证。
> 生产精确 lane 是 `0.1.1-rc.2`。`docs/t0-evidence/0.1.1-rc.1/` 是同日被替换版本的历史观察，不能代替 rc.2。

重跑：

- `pnpm t0:matrix`
- `pnpm t0 -- --dsh-version 0.1.0-rc.6`
- `pnpm t0 -- --dsh-version 0.1.0-rc.7`
- `pnpm t0 -- --dsh-version 0.1.0-rc.8`
- `pnpm t0 -- --dsh-version 0.1.1-rc.2`
- `pnpm t0:dsh011rc2`
- `pnpm t0:dsh011rc1`（历史复现；`docs/t0-evidence/0.1.1-rc.1/` 是同日被替换版本的观察，不能代替 rc.2）
- `pnpm t0 -- --dsh-tag latest`
- `pnpm t0 -- --dsh-tag next`（仅当 next ≠ latest；与 latest 或已 pin 版本重复时矩阵去重）

矩阵摘要：`docs/t0-matrix-summary.md`（由 `pnpm t0:matrix` 生成，不覆盖各版本目录）。
