function base(kind, source, locator, excerpt = '') {
  return { schemaVersion: 1, kind: 'agentplay.evidence-reference', evidenceKind: kind, source: String(source || ''), locator, excerpt: String(excerpt || '').slice(0, 500) }
}
const videoTime = (source, startSeconds, endSeconds, excerpt) => base('video-time', source, { startSeconds: Math.max(0, Number(startSeconds) || 0), endSeconds: Math.max(0, Number(endSeconds) || 0) }, excerpt)
const documentPage = (source, page, excerpt) => base('document-page', source, { page: Math.max(1, Math.trunc(Number(page) || 1)) }, excerpt)
const webParagraph = (source, paragraph, excerpt) => base('web-paragraph', source, { paragraph: Math.max(1, Math.trunc(Number(paragraph) || 1)) }, excerpt)
const sheetCell = (source, sheet, cell, excerpt) => base('sheet-cell', source, { sheet: String(sheet || ''), cell: String(cell || '').toUpperCase() }, excerpt)
const imageRegion = (source, region = {}, excerpt) => base('image-region', source, { x: Number(region.x) || 0, y: Number(region.y) || 0, width: Number(region.width) || 1, height: Number(region.height) || 1 }, excerpt)

function assertEvidenceReference(reference) {
  if (reference?.schemaVersion !== 1 || reference?.kind !== 'agentplay.evidence-reference' || !reference.source) throw new Error('证据引用协议无效')
  const kinds = new Set(['video-time', 'document-page', 'web-paragraph', 'sheet-cell', 'image-region'])
  if (!kinds.has(reference.evidenceKind) || !reference.locator || typeof reference.locator !== 'object') throw new Error('证据定位类型无效')
  if (reference.evidenceKind === 'video-time' && !(reference.locator.endSeconds >= reference.locator.startSeconds)) throw new Error('视频证据时间范围无效')
  if (reference.evidenceKind === 'sheet-cell' && (!reference.locator.sheet || !/^[A-Z]{1,3}\d+$/.test(reference.locator.cell))) throw new Error('表格证据单元格无效')
  return reference
}

module.exports = { videoTime, documentPage, webParagraph, sheetCell, imageRegion, assertEvidenceReference }
