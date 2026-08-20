export const CROSS_PROJECT_DOCTOR_PENDING = '待联调'
export const T1_COMPLETE_PENDING = '未完成'

export function isDoctorStepName(name) {
  const value = String(name ?? '')
  return value === 'doctor' || value === 'doctor cli' || value.startsWith('doctor ')
}

export function pendingCrossProjectDoctor() {
  return {
    verdict: CROSS_PROJECT_DOCTOR_PENDING,
    scope: 'cross-project',
    surface: 'tui-local-/doctor',
    stockCli: false,
    stockHttp: false,
    invented: false,
    reason: '任务书 /doctor 零错误零警告是 final cross-project acceptance。由 Task B 用既有本地 /doctor（TUI behavior=local → plugins.doctor()）在安装 Clarify 后验证。stock dsh 无 CLI doctor，也无 Host HTTP /doctor。Clarify 不发明、不探测这些面。',
  }
}

export function t1DoctorVerdict(t1) {
  const doctor = t1?.doctor
  if (!doctor) return CROSS_PROJECT_DOCTOR_PENDING
  if (doctor.scope === 'cross-project' || doctor.surface === 'tui-local-/doctor') {
    return doctor.verdict
  }
  if (doctor.cli || doctor.http || doctor.slash) return CROSS_PROJECT_DOCTOR_PENDING
  if (doctor.verdict === '通过' || doctor.verdict === '阻塞' || doctor.verdict === CROSS_PROJECT_DOCTOR_PENDING) {
    return doctor.verdict
  }
  return CROSS_PROJECT_DOCTOR_PENDING
}

export function t1LifecycleVerdict(t1) {
  if (t1?.lifecycle?.verdict === '通过' || t1?.lifecycle?.verdict === '阻塞') {
    return t1.lifecycle.verdict
  }
  const steps = Array.isArray(t1?.steps) ? t1.steps : []
  if (steps.length === 0) return '阻塞'
  const failed = steps.filter((item) => !item.ok && !isDoctorStepName(item.name))
  return failed.length === 0 ? '通过' : '阻塞'
}

export function t1StandaloneVerdict(t1) {
  if (t1LifecycleVerdict(t1) !== '通过') return '阻塞'
  if (t1?.dumpConsistency?.ok === false) return '阻塞'
  return '通过'
}

export function t1CompleteVerdict(t1) {
  if (t1StandaloneVerdict(t1) !== '通过') return '阻塞'
  const doctor = t1DoctorVerdict(t1)
  if (doctor === '通过') return '通过'
  if (doctor === '阻塞') return '阻塞'
  return T1_COMPLETE_PENDING
}

export function t1StandaloneExitOk(t1) {
  return t1StandaloneVerdict(t1) === '通过'
}

export function formatT1Report(evidence, graph) {
  const doctor = evidence.doctor ?? pendingCrossProjectDoctor()
  return `# T1 报告（${evidence.dshVersion}）

> 本报告只记录本次实际观察到的结果。
> Clarify standalone T1 只陈述 stock add / boot / remove / re-add lifecycle。
> 任务书 \`/doctor\` 零错误零警告是 final cross-project acceptance，由 Task B 用既有本地 \`/doctor\` 在安装 Clarify 后验证。
> 本仓库不发明 dsh doctor，不探测 Host \`GET /doctor\`。在联调证据存在前，不得把 T1 写成完全通过。

## 总结论

| 项 | 结论 |
| --- | --- |
| standalone lifecycle | ${evidence.standaloneVerdict} |
| cross-project doctor | ${doctor.verdict} |
| dump 布尔与文字 | ${evidence.dumpConsistency.ok ? '通过' : '阻塞'} |
| T1 完全通过 | ${evidence.completeVerdict} |

standalone lifecycle：**${evidence.standaloneVerdict}**
cross-project doctor：**${doctor.verdict}**
T1 完全通过：**${evidence.completeVerdict}**

## cross-project doctor

- 面：\`${doctor.surface}\`；范围：\`${doctor.scope}\`
- stock CLI / HTTP 探测：未做（\`stockCli=${doctor.stockCli}\`，\`stockHttp=${doctor.stockHttp}\`，\`invented=${doctor.invented}\`）
- 结论：${doctor.verdict} — ${doctor.reason}

## dump

- after add：\`${evidence.dumpContainsClarifyAfterAdd}\` / \`${excerptOf(evidence, 'dump-config after add')}\`
- after remove：\`${evidence.dumpContainsClarifyAfterRemove}\` / \`${excerptOf(evidence, 'dump-config after remove')}\`
- after re-add：\`${evidence.dumpContainsClarifyAfterReadd}\` / \`${excerptOf(evidence, 'dump-config after re-add')}\`
- 一致性：${evidence.dumpConsistency.ok ? '通过' : evidence.dumpConsistency.contradictions.join('；')}

## 环境

- 请求的元包：\`@deepseek-ai/dsh@${evidence.dshVersion}\`
- 解析组件：base \`${graph?.core?.['@deepseek-ai/dsh-base'] ?? 'n/a'}\`
- 混合树：\`${graph?.mixed ? 'yes' : 'no'}\` — ${graph?.note ?? ''}
- 隔离 \`DSH_HOME\`：\`.probe-work/${evidence.dshVersion}/homes/t1\`
`
}

function excerptOf(evidence, name) {
  return evidence.steps?.find((item) => item.name === name)?.output ?? ''
}
