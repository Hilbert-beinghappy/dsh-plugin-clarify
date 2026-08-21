export function classifyLaneSpawn(result) {
  const signal = result?.signal ?? null
  if (result?.error?.code === 'ETIMEDOUT') {
    return { timedOut: true, exit: 124, signal, label: 'TIMEOUT' }
  }
  const exit = result?.status ?? 1
  return {
    timedOut: false,
    exit,
    signal,
    label: exit === 0 && !signal ? 'OK' : 'BLOCK/FAIL',
  }
}

export function formatLaneSpawnFailure(script, version, classified) {
  if (classified.timedOut) {
    return `TIMEOUT ${script} ${version} exit 124`
  }
  const signalPart = classified.signal ? ` signal ${classified.signal}` : ''
  return `BLOCK/FAIL ${script} ${version} exit ${classified.exit}${signalPart}`
}
