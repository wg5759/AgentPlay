export const SUBTITLE_POSITIONS = ['high', 'middle', 'low']

const LINE_PERCENT = Object.freeze({
  high: 54,
  middle: 70,
  low: 84
})

export function normalizeSubtitlePosition(value) {
  return SUBTITLE_POSITIONS.includes(value) ? value : 'low'
}

export function subtitleLinePercent(value) {
  return LINE_PERCENT[normalizeSubtitlePosition(value)]
}

export function shiftSubtitlePosition(value, direction) {
  const current = SUBTITLE_POSITIONS.indexOf(normalizeSubtitlePosition(value))
  const delta = direction === 'up' ? -1 : 1
  return SUBTITLE_POSITIONS[Math.max(0, Math.min(SUBTITLE_POSITIONS.length - 1, current + delta))]
}

export function subtitleCueSettings(value) {
  return `line:${subtitleLinePercent(value)}% position:50% size:72% align:center`
}
// A TextTrack is time-sorted; source-file ordinals may have a different order.
export function findSubtitleOrdinal(content, start, end) {
  const seconds = value => value.replace(',', '.').split(':').reduce((total, part) => total * 60 + Number(part), 0)
  const blocks = String(content).replace(/^\uFEFF/, '').split(/\r?\n\s*\r?\n/).filter(block => !/^(?:NOTE|STYLE|REGION)(?:\s|$)/.test(block.trim()))
  const timelines = []
  for (const block of blocks) {
    const matches = [...block.matchAll(/(?:^|\n)\s*((?:\d{2,}:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d{2,}:)?\d{2}:\d{2}[.,]\d{3})/g)]
    if (matches.length > 1) return null
    if (matches.length) timelines.push(matches[0])
  }
  const candidates = timelines.map((match, index) => ({ index: index + 1, start: seconds(match[1]), end: seconds(match[2]) })).filter(item => Math.abs(item.start - start) < 0.002 && Math.abs(item.end - end) < 0.002)
  return candidates.length === 1 ? candidates[0].index : null
}
export function positionVttContent(content, position) {
  const settings = subtitleCueSettings(position)
  // Horizontal whitespace only: \\s would consume the newline and cue text.
  return String(content).replace(/^((?:\d{2,}:)?\d{2}:\d{2}\.\d{3}[ \t]+-->[ \t]+(?:\d{2,}:)?\d{2}:\d{2}\.\d{3})(?:[ \t]+[^\r\n]*)?(\r?)$/gm, (_line, timing, carriage) => `${timing} ${settings}${carriage}`)
}
