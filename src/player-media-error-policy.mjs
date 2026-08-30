function validStat(value) {
  return Boolean(value && Number.isFinite(Number(value.size)) && Number.isFinite(Number(value.mtimeMs)))
}

export function sameMediaFileStat(left, right) {
  if (!validStat(left) || !validStat(right)) return false
  return Number(left.size) === Number(right.size) && Math.trunc(Number(left.mtimeMs)) === Math.trunc(Number(right.mtimeMs))
}

export function isCurrentMediaRecovery({ recoveryToken, currentToken, sourcePath, currentSourcePath }) {
  return Number(recoveryToken) === Number(currentToken) && Boolean(sourcePath) && sourcePath === currentSourcePath
}

export function classifyMediaPlaybackError({ localFile, openedStat, currentStat }) {
  if (!localFile) return 'unavailable'
  if (validStat(openedStat) && validStat(currentStat) && !sameMediaFileStat(openedStat, currentStat)) return 'growing'
  return 'stable-error'
}
