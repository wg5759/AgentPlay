const path = require('path')

function material(id, role, value = {}) {
  const filePath = String(value.path || '').trim()
  if (!filePath) throw new Error(`EDL 缺少${role}素材路径`)
  return { id, role, path: filePath, name: String(value.name || path.basename(filePath)) }
}

function finiteRange(start, end, label) {
  const from = Number(start)
  const to = Number(end)
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from) throw new Error(`EDL ${label}无效`)
  return { start: from, end: to }
}

function videoMaterialAndTracks(source) {
  return {
    materials: [material('material-video-1', 'video', source)],
    tracks: [
      { id: 'track-video-1', type: 'video', materialId: 'material-video-1' },
      { id: 'track-audio-1', type: 'audio', materialId: 'material-video-1', optional: true }
    ]
  }
}

function videoAndSubtitleMaterialAndTracks(source, subtitle) {
  const video = material('material-video-1', 'video', source)
  const captions = material('material-subtitle-1', 'subtitle', subtitle)
  return {
    materials: [video, captions],
    tracks: [
      { id: 'track-video-1', type: 'video', materialId: video.id },
      { id: 'track-audio-1', type: 'audio', materialId: video.id, optional: true },
      { id: 'track-subtitle-1', type: 'subtitle', materialId: captions.id }
    ]
  }
}

function buildEditDecisionList(decision) {
  if (!decision || decision.schemaVersion !== 1 || typeof decision.kind !== 'string') throw new Error('EDL 决策无效')
  const output = {
    container: String(decision.output?.container || ''),
    overwrite: decision.output?.overwrite === true,
    suffix: String(decision.output?.suffix || '')
  }
  if (!output.container || output.overwrite || !output.suffix) throw new Error('EDL 输出策略无效')
  const quality = JSON.parse(JSON.stringify(decision.verification || {}))

  if (decision.kind === 'media.trim') {
    const sourceRangeSeconds = finiteRange(decision.timeline?.startSeconds, decision.timeline?.endSeconds, '裁剪源范围')
    const duration = Number(decision.timeline?.durationSeconds)
    if (!Number.isFinite(duration) || duration <= 0 || Math.abs(duration - (sourceRangeSeconds.end - sourceRangeSeconds.start)) > 0.001) throw new Error('EDL 裁剪时长无效')
    const media = videoMaterialAndTracks(decision.source)
    return {
      schemaVersion: 1,
      kind: 'agentplay.edit-decision-list',
      decisionKind: decision.kind,
      ...media,
      operations: [{
        id: 'operation-1',
        type: 'trim',
        materialId: 'material-video-1',
        trackIds: ['track-video-1', 'track-audio-1'],
        sourceRangeSeconds,
        targetRangeSeconds: { start: 0, end: duration }
      }],
      output,
      quality
    }
  }
  if (decision.kind === 'media.remove-segment') {
    const sourceRangeSeconds = finiteRange(decision.timeline?.startSeconds, decision.timeline?.endSeconds, '删除源范围')
    const removedDuration = Number(decision.timeline?.removedDurationSeconds)
    if (!Number.isFinite(removedDuration) || Math.abs(removedDuration - (sourceRangeSeconds.end - sourceRangeSeconds.start)) > 0.001) throw new Error('EDL 删除时长无效')
    const media = videoMaterialAndTracks(decision.source)
    return {
      schemaVersion: 1,
      kind: 'agentplay.edit-decision-list',
      decisionKind: decision.kind,
      ...media,
      operations: [{
        id: 'operation-1', type: 'remove', materialId: 'material-video-1',
        trackIds: ['track-video-1', 'track-audio-1'], sourceRangeSeconds
      }],
      output,
      quality
    }
  }
  if (decision.kind === 'media.concat-segments') {
    const segments = Array.isArray(decision.timeline?.segments) ? decision.timeline.segments : []
    const expectedDuration = Number(decision.timeline?.durationSeconds)
    if (segments.length < 2 || segments.length > 24 || !Number.isFinite(expectedDuration) || expectedDuration <= 0) throw new Error('EDL 拼接时间线无效')
    let cursor = 0
    const operations = segments.map((segment, index) => {
      const sourceRangeSeconds = finiteRange(segment.sourceStartSeconds, segment.sourceEndSeconds, `拼接片段 ${index + 1} 源范围`)
      const targetRangeSeconds = finiteRange(segment.targetStartSeconds, segment.targetEndSeconds, `拼接片段 ${index + 1} 目标范围`)
      const duration = sourceRangeSeconds.end - sourceRangeSeconds.start
      if (Math.abs(duration - (targetRangeSeconds.end - targetRangeSeconds.start)) > 0.001 || Math.abs(targetRangeSeconds.start - cursor) > 0.001) throw new Error('EDL 拼接目标时间线不连续')
      cursor = targetRangeSeconds.end
      return {
        id: `operation-${index + 1}`, type: 'append', materialId: 'material-video-1',
        trackIds: ['track-video-1', 'track-audio-1'], sourceRangeSeconds, targetRangeSeconds
      }
    })
    if (Math.abs(cursor - expectedDuration) > 0.001) throw new Error('EDL 拼接总时长无效')
    return {
      schemaVersion: 1, kind: 'agentplay.edit-decision-list', decisionKind: decision.kind,
      ...videoMaterialAndTracks(decision.source), operations, output, quality
    }
  }
  if (decision.kind === 'media.concat-sources') {
    const sources = Array.isArray(decision.sources) ? decision.sources : []
    if (sources.length < 2 || sources.length > 20) throw new Error('EDL 跨素材数量无效')
    const materials = sources.map((source, index) => material(`material-video-${index + 1}`, 'video', source))
    const tracks = materials.flatMap((item, index) => ([
      { id: `track-video-${index + 1}`, type: 'video', materialId: item.id },
      { id: `track-audio-${index + 1}`, type: 'audio', materialId: item.id, optional: true }
    ]))
    const operations = materials.map((item, index) => ({
      id: `operation-${index + 1}`, type: 'append-source', materialId: item.id,
      trackIds: [`track-video-${index + 1}`, `track-audio-${index + 1}`], order: index
    }))
    return {
      schemaVersion: 1, kind: 'agentplay.edit-decision-list', decisionKind: decision.kind,
      materials, tracks, operations, output, quality
    }
  }
  if (decision.kind === 'media.add-music') {
    const video = material('material-video-1', 'video', decision.source)
    const music = material('material-music-1', 'music', decision.audio)
    const volume = Number(decision.audio?.volume)
    const fadeInSeconds = Number(decision.audio?.fadeInSeconds)
    const fadeOutSeconds = Number(decision.audio?.fadeOutSeconds)
    if (!Number.isFinite(volume) || volume <= 0 || volume > 1 || !Number.isFinite(fadeInSeconds) || fadeInSeconds < 0 || !Number.isFinite(fadeOutSeconds) || fadeOutSeconds < 0) throw new Error('EDL 配乐参数无效')
    const selection = decision.audio?.selection
    const sourceRangeSeconds = selection ? finiteRange(selection.startSeconds, selection.endSeconds, '音乐选段') : null
    if (sourceRangeSeconds && Math.abs(Number(selection.durationSeconds) - (sourceRangeSeconds.end - sourceRangeSeconds.start)) > 0.001) throw new Error('EDL 音乐选段时长无效')
    const operation = {
      id: 'operation-1', type: 'mix-music', materialId: music.id, trackIds: ['track-music-1'],
      ...(sourceRangeSeconds ? { sourceRangeSeconds } : {}),
      parameters: {
        volume, loop: decision.audio?.loop !== false, duck: decision.audio?.duck !== false,
        fadeInSeconds, fadeOutSeconds
      }
    }
    return {
      schemaVersion: 1, kind: 'agentplay.edit-decision-list', decisionKind: decision.kind,
      materials: [video, music],
      tracks: [
        { id: 'track-video-1', type: 'video', materialId: video.id },
        { id: 'track-audio-1', type: 'audio', materialId: video.id, optional: true },
        { id: 'track-music-1', type: 'audio', materialId: music.id }
      ],
      operations: [operation], output,
      quality: { ...quality, ...(decision.audio?.loudness ? { loudness: JSON.parse(JSON.stringify(decision.audio.loudness)) } : {}) }
    }
  }
  if (decision.kind === 'media.burn-subtitles') {
    const media = videoAndSubtitleMaterialAndTracks(decision.source, decision.subtitle)
    return {
      schemaVersion: 1, kind: 'agentplay.edit-decision-list', decisionKind: decision.kind,
      ...media,
      operations: [{
        id: 'operation-1', type: 'burn-subtitles', materialId: 'material-subtitle-1',
        trackIds: ['track-subtitle-1'],
        parameters: { style: JSON.parse(JSON.stringify(decision.subtitle?.style || {})) }
      }],
      output, quality
    }
  }
  const subtitleOperations = {
    'media.mux-subtitles': ['mux-subtitles', {}],
    'media.shift-subtitles': ['shift-subtitles', decision.shift],
    'media.translate-subtitles': ['translate-subtitles', decision.translate],
    'media.edit-subtitle-cues': ['edit-subtitle-cues', decision.cueEdit]
  }
  if (subtitleOperations[decision.kind]) {
    const [type, rawParameters] = subtitleOperations[decision.kind]
    if (!rawParameters || typeof rawParameters !== 'object') throw new Error(`EDL ${type} 参数无效`)
    const media = videoAndSubtitleMaterialAndTracks(decision.source, decision.subtitle)
    return {
      schemaVersion: 1, kind: 'agentplay.edit-decision-list', decisionKind: decision.kind,
      ...media,
      operations: [{
        id: 'operation-1', type, materialId: 'material-subtitle-1',
        trackIds: ['track-subtitle-1'], parameters: JSON.parse(JSON.stringify(rawParameters))
      }],
      output, quality
    }
  }
  throw new Error(`EDL 暂不支持决策类型：${decision.kind}`)
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function attachEditDecisionList(decision) {
  return { ...decision, edl: buildEditDecisionList(decision) }
}

function assertEditDecisionList(decision) {
  if (!decision?.edl || canonical(decision.edl) !== canonical(buildEditDecisionList(decision))) throw new Error('EDL 与冻结决策不一致')
  return decision.edl
}

module.exports = { assertEditDecisionList, attachEditDecisionList, buildEditDecisionList }
