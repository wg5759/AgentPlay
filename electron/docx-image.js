const fs = require('fs')
const path = require('path')
const JSZip = require('jszip')

// DOCX 插图：把图片嵌入文档（word/media + document.xml.rels + w:drawing 内联图片）。
// 未涉及的样式、表格、页眉页脚保持原样；任何一步失败都不写输出文件。

const IMAGE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'
const DRAWING_ML = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const EMU_PER_PIXEL = 9525

function imageSize(buffer, ext) {
  if (ext === '.png') {
    if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('无效的 PNG 文件')
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  if (ext === '.jpg' || ext === '.jpeg') {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) throw new Error('无效的 JPEG 文件')
      const marker = buffer[offset + 1]
      const length = buffer.readUInt16BE(offset + 2)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) }
      }
      offset += 2 + length
    }
    throw new Error('JPEG 中未找到尺寸信息')
  }
  if (ext === '.gif') {
    if (buffer.length < 10) throw new Error('无效的 GIF 文件')
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
  }
  if (ext === '.bmp') {
    if (buffer.length < 26 || buffer.toString('ascii', 0, 2) !== 'BM') throw new Error('无效的 BMP 文件')
    return { width: Math.abs(buffer.readInt32LE(18)), height: Math.abs(buffer.readInt32LE(22)) }
  }
  throw new Error(`暂不支持读取 ${ext} 图片尺寸（支持 png/jpg/gif/bmp）`)
}

function nextImageName(existingNames, ext) {
  const numbers = existingNames
    .map((name) => /image(\d+)\.[a-z0-9]+$/i.exec(name)?.[1])
    .filter(Boolean)
    .map(Number)
  return `image${Math.max(0, ...numbers) + 1}${ext}`
}

function nextRelId(relsXml) {
  const ids = [...relsXml.matchAll(/Id="rId(\d+)"/g)].map((match) => Number(match[1]))
  return `rId${Math.max(0, ...ids) + 1}`
}

function nextDocPrId(documentXml) {
  const ids = [...documentXml.matchAll(/<wp:docPr\b[^>]*\bid="(\d+)"/g)].map((match) => Number(match[1]))
  return Math.max(0, ...ids) + 1
}

async function insertImageIntoDocx(docPath, imagePath, finalPath, { anchor = null, maxWidthPx = 500 } = {}) {
  const ext = path.extname(imagePath).toLowerCase()
  const imageBuffer = fs.readFileSync(imagePath)
  const { width, height } = imageSize(imageBuffer, ext)
  const scale = Math.min(1, maxWidthPx / width)
  const cx = Math.round(width * scale * EMU_PER_PIXEL)
  const cy = Math.round(height * scale * EMU_PER_PIXEL)

  const archive = await JSZip.loadAsync(fs.readFileSync(docPath))
  const documentFile = archive.file('word/document.xml')
  const relsFile = archive.file('word/_rels/document.xml.rels')
  if (!documentFile || !relsFile) throw new Error('不是有效的 DOCX（缺少 document.xml 或其关系）')
  let documentXml = await documentFile.async('string')
  let relsXml = await relsFile.async('string')

  const existingMedia = Object.keys(archive.files).filter((name) => /^word\/media\//.test(name))
  const imageName = nextImageName(existingMedia, ext)
  const relId = nextRelId(relsXml)
  const docPrId = nextDocPrId(documentXml)
  archive.file(`word/media/${imageName}`, imageBuffer)
  relsXml = relsXml.replace('</Relationships>', `<Relationship Id="${relId}" Type="${IMAGE_REL_TYPE}" Target="media/${imageName}"/></Relationships>`)

  const drawing = `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${docPrId}" name="图片 ${docPrId}"/><a:graphic xmlns:a="${DRAWING_ML}"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="${imageName}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
  const paragraph = `<w:p>${drawing}</w:p>`

  if (anchor) {
    let inserted = false
    const PARAGRAPH_RE = /<w:p\b[\s\S]*?<\/w:p>/g
    const TEXT_RE = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g
    documentXml = documentXml.replace(PARAGRAPH_RE, (paragraphXml) => {
      if (inserted) return paragraphXml
      const text = [...paragraphXml.matchAll(TEXT_RE)].map((match) => match[1]).join('')
      if (!text.includes(anchor)) return paragraphXml
      inserted = true
      return paragraphXml + paragraph
    })
    if (!inserted) throw new Error(`没有找到锚点「${anchor}」；未改动原文件`)
  } else {
    const sectionIndex = documentXml.lastIndexOf('<w:sectPr')
    const insertAt = sectionIndex === -1 ? documentXml.lastIndexOf('</w:body>') : sectionIndex
    if (insertAt === -1) throw new Error('DOCX 结构无效（缺少 w:body）')
    documentXml = documentXml.slice(0, insertAt) + paragraph + documentXml.slice(insertAt)
  }

  archive.file('word/document.xml', documentXml)
  archive.file('word/_rels/document.xml.rels', relsXml)
  const buffer = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const tempPath = `${finalPath}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(finalPath), { recursive: true })
  fs.writeFileSync(tempPath, buffer)
  fs.renameSync(tempPath, finalPath)
  return { imageName, width, height }
}

module.exports = { insertImageIntoDocx, imageSize }
