export const HISTORICAL_MATRIX_HEADING = '历史观察（非生产 pin，不计入矩阵通过率）：'

export function matrixSummaryProvenanceLine({ fromEvidence, versions }) {
  const lanes = versions.map((version) => `\`${version}\``).join(', ')
  return fromEvidence
    ? `> 摘要由已有精确版本证据刷新，未重跑 Host。当前合同行：${lanes}。`
    : `> 本次矩阵已逐一重跑合同行：${lanes}。各版本证据写入 \`docs/t0-evidence/<version>/\`。`
}
