// Electron work areas are in DIP, not physical pixels. Fixed 1280x800 nearly
// fills a 150%-scaled laptop; reserve desktop space even on those displays.
function windowedBounds(area) {
  const maxWidth = Math.max(1, area.width - Math.min(48, Math.floor(area.width * 0.08)))
  const maxHeight = Math.max(1, area.height - Math.min(48, Math.floor(area.height * 0.08)))
  const minWidth = Math.min(800, maxWidth)
  const minHeight = Math.min(520, maxHeight)
  const width = Math.min(maxWidth, 1280, Math.max(minWidth, Math.round(area.width * 0.8)))
  const height = Math.min(maxHeight, 800, Math.max(minHeight, Math.round(area.height * 0.8)))
  return { x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height, minWidth, minHeight }
}
module.exports = { windowedBounds }
