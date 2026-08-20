import {
  t1CompleteVerdict,
  t1DoctorVerdict,
  t1LifecycleVerdict,
  t1StandaloneExitOk,
  t1StandaloneVerdict,
} from './t1-verdicts.mjs'

export {
  t1CompleteVerdict,
  t1DoctorVerdict,
  t1LifecycleVerdict,
  t1StandaloneExitOk,
  t1StandaloneVerdict,
}

export function t1Verdict(t1) {
  return t1CompleteVerdict(t1)
}

export function hostT3SessionSource(gates, hostT3) {
  return gates?.hostT3?.sessionSource
    ?? hostT3?.sessionDiscovery?.source
    ?? 'n/a'
}
