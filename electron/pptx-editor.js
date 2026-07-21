const fs = require('fs')
const path = require('path')
const JSZip = require('jszip')

// PPTX 页面级编辑（第一增量）：Open XML 层的确定性编辑——
// 整稿/单页文字替换、删除指定页（关系全套清理）、新增页（沿用现有母版版式）。
// 母版、版式、图片、图表、动画、备注等未涉及部件保持原样；任何一步失败都不写输出文件。

const A_PARA_RE = /<a:p\b[\s\S]*?<\/a:p>/g
const A_TEXT_RE = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g
const SLIDE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'
const SLIDE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide'
const LAYOUT_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout'
const FORMAT_WORDS = /^(pdf|word|docx|excel|xlsx|pptx?|txt|markdown|md|文本|表格|演示稿|幻灯片)$/i
const LANGUAGE_WORDS = /^(英文|英语|中文|汉语|日语|日文|韩语|法语|德语|西班牙语|俄语)$/

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function unescapeXml(value) {
  return String(value)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

function visibleText(xml) {
  return [...xml.matchAll(A_TEXT_RE)].map((match) => unescapeXml(match[1])).join('')
}

function candidateForms(from) {
  const forms = [from]
  const liTail = /里(?:的)?([^的]+)$/.exec(from)
  if (liTail && liTail[1].length >= 1) forms.push(liTail[1])
  const deTail = /的([^的]+)$/.exec(from)
  if (deTail && deTail[1].length >= 1) forms.push(deTail[1])
  return [...new Set(forms)]
}

function splitLines(value) {
  return String(value).split(/\r?\n|(?<=[。！？；])/).map((line) => line.trim().replace(/^[。！？；]+|[。！？；]+$/g, '')).filter(Boolean)
}

function parsePptxEditInstruction(instruction) {
  const text = String(instruction || '').trim()
  if (!text) return null
  const operations = []
  const segments = text.split(/[\n]+/).map((segment) => segment.trim()).filter(Boolean)
  for (const rawSegment of segments) {
    const segment = rawSegment.replace(/["'“”‘’«»]/g, '')
    const replace = /^(?:把|将)\s*(?:第(\d+)页(?:的|里)?\s*)?([^，。]+?)\s*(?:替换成|替换为|换成|改为|改成)(?:为)?\s*([^，。]+?)$/.exec(segment)
    if (replace) {
      const from = replace[2].trim()
      const to = replace[3].trim()
      if (!from || !to) return null
      if (FORMAT_WORDS.test(to) || LANGUAGE_WORDS.test(to)) return null
      operations.push({ type: 'replace', from, to, page: replace[1] ? Number(replace[1]) : null })
      continue
    }
    const remove = /^(?:删除|删掉|去掉)\s*第?(\d+)\s*页$/.exec(segment) || /^第?(\d+)\s*页(?:删除|删掉)$/.exec(segment)
    if (remove) {
      operations.push({ type: 'remove', page: Number(remove[1]) })
      continue
    }
    const add = /^(?:在(最后|末尾|第(\d+)页后))?\s*(?:加|加一|加一?张|插入一?张?|新增一?|添加一?)页[：:]?\s*(.+)$/.exec(segment)
    if (add) {
      const lines = splitLines(add[3])
      if (lines.length === 0) return null
      const title = lines[0].replace(/^#+\s*/, '')
      operations.push({
        type: 'add',
        title,
        bullets: lines.slice(1).map((line) => line.replace(/^[-*]\s*/, '')),
        afterPage: add[2] ? Number(add[2]) : null
      })
      continue
    }
    return null
  }
  return operations.length > 0 ? operations : null
}

function relsMap(relsXml) {
  const map = new Map()
  for (const match of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = match[0]
    const id = /Id="([^"]+)"/.exec(tag)?.[1]
    const target = /Target="([^"]+)"/.exec(tag)?.[1]
    const type = /Type="([^"]+)"/.exec(tag)?.[1]
    if (id) map.set(id, { id, target, type, tag })
  }
  return map
}

function slideOrder(presentationXml, relsXml) {
  const rels = relsMap(relsXml)
  const order = []
  for (const match of presentationXml.matchAll(/<p:sldId\b[^>]*>/g)) {
    const tag = match[0]
    const rId = /r:id="([^"]+)"/.exec(tag)?.[1]
    const id = /\bid="(\d+)"/.exec(tag)?.[1]
    const rel = rId ? rels.get(rId) : null
    if (rel?.target) order.push({ id: Number(id), rId, target: rel.target.replace(/^\//, 'ppt/').replace(/^(?!ppt\/)/, 'ppt/') })
  }
  return order
}

function replaceInSlideXml(slideXml, from, to) {
  let total = 0
  const xml = slideXml.replace(A_PARA_RE, (paragraphXml) => {
    const textNodes = [...paragraphXml.matchAll(A_TEXT_RE)]
    if (textNodes.length === 0) return paragraphXml
    const combined = textNodes.map((match) => unescapeXml(match[1])).join('')
    if (!combined.includes(from)) return paragraphXml
    total += combined.split(from).length - 1
    const replaced = combined.split(from).join(to)
    let used = false
    return paragraphXml.replace(A_TEXT_RE, (whole, inner) => {
      if (used) return whole.replace(inner, '')
      used = true
      const spaceAttr = /^\s|\s$/.test(replaced) && !/xml:space="preserve"/.test(whole) ? ' xml:space="preserve"' : ''
      return whole.replace('<a:t', `<a:t${spaceAttr}`).replace(inner, escapeXml(replaced))
    })
  })
  return { xml, total }
}

function buildSlideXml(title, bullets) {
  const bulletParas = bullets.map((line) => (
    `<a:p><a:pPr marL="342900" indent="-342900"><a:buChar char="•"/></a:pPr><a:r><a:rPr lang="zh-CN" sz="2000"/><a:t xml:space="preserve">${escapeXml(line)}</a:t></a:r></a:p>`
  )).join('')
  const bodyParas = bulletParas || '<a:p/>'
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="标题 1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="609600" y="457200"/><a:ext cx="10972800" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="l"/><a:r><a:rPr lang="zh-CN" sz="3200" b="1"/><a:t xml:space="preserve">${escapeXml(title)}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="内容 2"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="609600" y="1524000"/><a:ext cx="10972800" cy="4572000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${bodyParas}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
}

function nextSlideNumber(existingPaths) {
  const numbers = existingPaths.map((name) => /slide(\d+)\.xml$/.exec(name)?.[1]).filter(Boolean).map(Number)
  return Math.max(0, ...numbers) + 1
}

function nextRelId(relsXml) {
  const ids = [...relsXml.matchAll(/Id="rId(\d+)"/g)].map((match) => Number(match[1]))
  return `rId${Math.max(0, ...ids) + 1}`
}

function nextSlideId(presentationXml) {
  const ids = [...presentationXml.matchAll(/<p:sldId\b[^>]*\bid="(\d+)"/g)].map((match) => Number(match[1]))
  return Math.max(255, ...ids) + 1
}

async function applyRemove(archive, presentationXml, relsXml, page, order) {
  if (order.length <= 1) throw new Error('只剩一页，不能删除；未改动原文件')
  if (page < 1 || page > order.length) throw new Error(`没有第 ${page} 页（共 ${order.length} 页）；未改动原文件`)
  const target = order[page - 1]
  const newPresentationXml = presentationXml.replace(new RegExp(`<p:sldId\\b[^>]*r:id="${target.rId}"[^>]*/>`), '')
  if (newPresentationXml === presentationXml) throw new Error('演示结构异常，未能定位页面；未改动原文件')
  const newRelsXml = relsXml.replace(new RegExp(`<Relationship\\b[^>]*Id="${target.rId}"[^>]*/>`), '')
  const typesFile = archive.file('[Content_Types].xml')
  let typesXml = await typesFile.async('string')
  const partName = `/${target.target}`
  typesXml = typesXml.replace(new RegExp(`<Override\\b[^>]*PartName="${partName.replace(/[/.]/g, '\\$&')}"[^>]*/>`), '')
  archive.file('[Content_Types].xml', typesXml)
  archive.remove(target.target)
  const slideRelsPath = target.target.replace('slides/', 'slides/_rels/').replace('.xml', '.xml.rels')
  if (archive.file(slideRelsPath)) {
    // 级联清理该页引用的备注页（slide→notesSlide 方向），避免孤儿部件
    const slideRelsXml = await archive.file(slideRelsPath).async('string')
    for (const match of slideRelsXml.matchAll(/<Relationship\b[^>]*>/g)) {
      const tag = match[0]
      if (!tag.includes('notesSlide')) continue
      const notesTarget = /Target="([^"]+)"/.exec(tag)?.[1]
      if (!notesTarget) continue
      const notesPath = notesTarget.replace(/^\.\.\//, 'ppt/')
      if (archive.file(notesPath)) {
        archive.remove(notesPath)
        typesXml = typesXml.replace(new RegExp(`<Override\\b[^>]*PartName="/${notesPath.replace(/[/.]/g, '\\$&')}"[^>]*/>`), '')
        archive.file('[Content_Types].xml', typesXml)
      }
      const notesRelsPath = notesPath.replace('notesSlides/', 'notesSlides/_rels/').replace('.xml', '.xml.rels')
      if (archive.file(notesRelsPath)) archive.remove(notesRelsPath)
    }
    archive.remove(slideRelsPath)
  }
  return { presentationXml: newPresentationXml, relsXml: newRelsXml }
}

async function applyAdd(archive, presentationXml, relsXml, operation, order) {
  const slidePaths = order.map((entry) => entry.target)
  const number = nextSlideNumber(slidePaths)
  const target = `ppt/slides/slide${number}.xml`
  const newRelId = nextRelId(relsXml)
  const newSlideIdValue = nextSlideId(presentationXml)
  const referencePath = order[order.length - 1]?.target
  let layoutTarget = null
  if (referencePath && archive.file(referencePath)) {
    const refRelsPath = referencePath.replace('slides/', 'slides/_rels/').replace('.xml', '.xml.rels')
    const refRels = archive.file(refRelsPath)
    if (refRels) {
      const refRelsXml = await refRels.async('string')
      layoutTarget = [...refRelsXml.matchAll(/<Relationship\b[^>]*>/g)]
        .map((match) => match[0])
        .filter((tag) => tag.includes('slideLayout'))
        .map((tag) => /Target="([^"]+)"/.exec(tag)?.[1])[0] || null
    }
  }
  archive.file(target, buildSlideXml(operation.title, operation.bullets))
  if (layoutTarget) {
    const slideRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${LAYOUT_REL_TYPE}" Target="${layoutTarget}"/></Relationships>`
    archive.file(target.replace('slides/', 'slides/_rels/').replace('.xml', '.xml.rels'), slideRelsXml)
  }
  const typesFile = archive.file('[Content_Types].xml')
  let typesXml = await typesFile.async('string')
  typesXml = typesXml.replace('</Types>', `<Override PartName="/${target}" ContentType="${SLIDE_CONTENT_TYPE}"/></Types>`)
  archive.file('[Content_Types].xml', typesXml)
  const newRelsXml = relsXml.replace('</Relationships>', `<Relationship Id="${newRelId}" Type="${SLIDE_REL_TYPE}" Target="slides/slide${number}.xml"/></Relationships>`)
  const sldIdTag = `<p:sldId id="${newSlideIdValue}" r:id="${newRelId}"/>`
  let newPresentationXml
  if (operation.afterPage && operation.afterPage >= 1 && operation.afterPage <= order.length) {
    const anchorRid = order[operation.afterPage - 1].rId
    const anchorRe = new RegExp(`(<p:sldId\\b[^>]*r:id="${anchorRid}"[^>]*/>)`)
    newPresentationXml = presentationXml.replace(anchorRe, `$1${sldIdTag}`)
    if (newPresentationXml === presentationXml) throw new Error('演示结构异常，未能插入页面；未改动原文件')
  } else {
    const listClose = presentationXml.lastIndexOf('</p:sldIdLst>')
    if (listClose === -1) throw new Error('演示结构异常（缺少 sldIdLst）；未改动原文件')
    newPresentationXml = presentationXml.slice(0, listClose) + sldIdTag + presentationXml.slice(listClose)
  }
  return { presentationXml: newPresentationXml, relsXml: newRelsXml }
}

async function editPptx(sourcePath, finalPath, operations) {
  const archive = await JSZip.loadAsync(fs.readFileSync(sourcePath))
  const presentationFile = archive.file('ppt/presentation.xml')
  const relsFile = archive.file('ppt/_rels/presentation.xml.rels')
  if (!presentationFile || !relsFile) throw new Error('不是有效的 PPTX（缺少 presentation.xml 或其关系）')
  let presentationXml = await presentationFile.async('string')
  let relsXml = await relsFile.async('string')
  let order = slideOrder(presentationXml, relsXml)
  if (order.length === 0) throw new Error('PPTX 没有任何页面')

  const summaries = []
  const replaces = operations.filter((operation) => operation.type === 'replace')
  if (replaces.length > 0) {
    const slideXmlCache = new Map()
    const changedSlides = new Set()
    const readSlide = async (target) => {
      if (!slideXmlCache.has(target)) slideXmlCache.set(target, await archive.file(target).async('string'))
      return slideXmlCache.get(target)
    }
    let total = 0
    const unresolved = []
    for (const item of replaces) {
      const candidates = candidateForms(item.from)
      const pages = item.page ? [item.page] : order.map((_entry, index) => index + 1)
      let itemTotal = 0
      for (const page of pages) {
        if (page < 1 || page > order.length) throw new Error(`没有第 ${page} 页（共 ${order.length} 页）；未改动原文件`)
        const target = order[page - 1].target
        const slideXml = await readSlide(target)
        const use = candidates.find((candidate) => visibleText(slideXml).includes(candidate))
        if (!use) continue
        const result = replaceInSlideXml(slideXml, use, item.to)
        if (result.total > 0) {
          slideXmlCache.set(target, result.xml)
          changedSlides.add(target)
        }
        itemTotal += result.total
      }
      if (itemTotal === 0) unresolved.push(item.from)
      total += itemTotal
    }
    if (unresolved.length > 0) throw new Error(`没有找到要替换的文字：${unresolved.join('、')}；未改动原文件`)
    for (const target of changedSlides) archive.file(target, slideXmlCache.get(target))
    summaries.push(`替换 ${total} 处文字`)
  }

  for (const operation of operations) {
    if (operation.type === 'remove') {
      const result = await applyRemove(archive, presentationXml, relsXml, operation.page, order)
      presentationXml = result.presentationXml
      relsXml = result.relsXml
      order = slideOrder(presentationXml, relsXml)
      summaries.push(`删除第 ${operation.page} 页`)
    } else if (operation.type === 'add') {
      const result = await applyAdd(archive, presentationXml, relsXml, operation, order)
      presentationXml = result.presentationXml
      relsXml = result.relsXml
      order = slideOrder(presentationXml, relsXml)
      summaries.push(`新增页「${operation.title}」`)
    }
  }

  archive.file('ppt/presentation.xml', presentationXml)
  archive.file('ppt/_rels/presentation.xml.rels', relsXml)
  const buffer = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const tempPath = `${finalPath}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(finalPath), { recursive: true })
  fs.writeFileSync(tempPath, buffer)
  fs.renameSync(tempPath, finalPath)
  return summaries.join('；')
}

module.exports = { editPptx, parsePptxEditInstruction }
