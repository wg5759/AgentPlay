import { useEffect, useMemo, useState } from 'react'
import { usePlayerStore } from '../stores/playerStore'

type Tab = 'breakdown' | 'deep' | 'recut' | 'create'

interface Marker {
  id: string
  at: number
  thumbnail?: string
  shotSize: string
  movement: string
  function: string
  emotion: string
  note: string
}

interface Segment {
  id: string
  start: number
  end: number
  title: string
}

interface CreativeShot {
  id: string
  kind: 'source' | 'generated'
  segmentId: string
  duration: number
  title: string
  prompt: string
  narration: string
  caption: string
  assetPath: string
  status: string
}

interface CreativePlan {
  version: number
  title: string
  hook: string
  narration: string
  musicBrief: string
  subtitleStyle: 'clean' | 'impact' | 'documentary'
  deepAnalysis: { narrative: string; visual: string; editing: string; audio: string; hook: string; weaknesses: string[] }
  modality: 'text-evidence' | 'vision+text-evidence'
  provider?: string
  model?: string
  visualEvidenceCount?: number
  visualFallbackReason?: string
  riskNotes: string[]
  shots: CreativeShot[]
}

interface SavedProject {
  version: 2
  mediaName: string | null
  sourcePath: string
  duration: number
  markers: Marker[]
  segments: Segment[]
  offlineAnalysis: string
  aiAnalysis: string
  originalGoal: string
  style: string
  creativePlan: CreativePlan | null
  voicePath: string
  musicPath: string
  musicVolume: number
  imageModel: string
  voiceEngine: 'system' | 'cloud'
  voiceModel: string
  voiceName: string
  updatedAt: number
}

interface Props { onClose: () => void }

const STORAGE_KEY = 'ai-player-analysis-projects-v1'
const shotSizes = ['大全景', '全景', '中景', '近景', '特写', '细节']
const movements = ['固定', '推', '拉', '摇', '移', '跟', '手持', '航拍', '转场']
const functions = ['钩子', '交代', '冲突', '证据', '转折', '高潮', '情绪', '总结', '行动点']
const emotions = ['平静', '好奇', '紧张', '愉悦', '悲伤', '愤怒', '惊讶', '热血', '治愈']

function formatTime(value: number) {
  const total = Math.max(0, Number(value) || 0)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = Math.floor(total % 60)
  const ms = Math.floor((total % 1) * 10)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${ms}`
}

function loadSavedProject(sourcePath: string): Partial<SavedProject> | null {
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Record<string, Partial<SavedProject>>
    return all[sourcePath] || null
  } catch { return null }
}

function saveProject(project: SavedProject) {
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Record<string, SavedProject>
    all[project.sourcePath] = project
    const entries = Object.entries(all).sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0)).slice(0, 20)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch { /* project remains usable in memory when storage is full */ }
}

function captureCurrentFrame() {
  const video = document.querySelector<HTMLVideoElement>('video[data-ai-player-video="true"]')
  if (!video || !video.videoWidth || !video.videoHeight) return undefined
  try {
    const canvas = document.createElement('canvas')
    const width = Math.min(320, video.videoWidth)
    canvas.width = width
    canvas.height = Math.max(1, Math.round(width * video.videoHeight / video.videoWidth))
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.55)
  } catch { return undefined }
}

export default function AnalysisStudio({ onClose }: Props) {
  const mediaName = usePlayerStore((state) => state.mediaName)
  const sourcePath = usePlayerStore((state) => state.videoSrc)
  const currentTime = usePlayerStore((state) => state.currentTime)
  const duration = usePlayerStore((state) => state.duration)
  const [tab, setTab] = useState<Tab>('breakdown')
  const saved = useMemo(() => sourcePath ? loadSavedProject(sourcePath) : null, [sourcePath])
  const [markers, setMarkers] = useState<Marker[]>(() => saved?.markers || [])
  const [segments, setSegments] = useState<Segment[]>(() => saved?.segments || [])
  const [offlineAnalysis, setOfflineAnalysis] = useState(() => saved?.offlineAnalysis || '')
  const [aiAnalysis, setAiAnalysis] = useState(() => saved?.aiAnalysis || '')
  const [originalGoal, setOriginalGoal] = useState(() => saved?.originalGoal || '重写开场钩子，压缩重复信息，形成更清晰的原创叙事')
  const [style, setStyle] = useState(() => saved?.style || '节奏紧凑、观点明确、保留事实依据')
  const [creativePlan, setCreativePlan] = useState<CreativePlan | null>(() => saved?.creativePlan || null)
  const [voicePath, setVoicePath] = useState(() => saved?.voicePath || '')
  const [musicPath, setMusicPath] = useState(() => saved?.musicPath || '')
  const [musicVolume, setMusicVolume] = useState(() => saved?.musicVolume ?? 0.12)
  const [imageModel, setImageModel] = useState(() => saved?.imageModel || 'gpt-image-1')
  const [voiceEngine, setVoiceEngine] = useState<'system' | 'cloud'>(() => saved?.voiceEngine || 'system')
  const [voiceModel, setVoiceModel] = useState(() => saved?.voiceModel || 'gpt-4o-mini-tts')
  const [voiceName, setVoiceName] = useState(() => saved?.voiceName || 'alloy')
  const [cues, setCues] = useState<Array<{ start: number; end: number; text: string }>>([])
  const [subtitlePath, setSubtitlePath] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [working, setWorking] = useState(false)
  const [capabilities, setCapabilities] = useState<{ platform: string; systemVoice: boolean; advancedRender: boolean; renderBinary: string | null } | null>(null)

  const project = useMemo<SavedProject | null>(() => sourcePath ? ({
    version: 2, mediaName, sourcePath, duration, markers, segments, offlineAnalysis, aiAnalysis,
    originalGoal, style, creativePlan, voicePath, musicPath, musicVolume, imageModel,
    voiceEngine, voiceModel, voiceName, updatedAt: Date.now()
  }) : null, [aiAnalysis, creativePlan, duration, imageModel, markers, mediaName, musicPath, musicVolume, offlineAnalysis, originalGoal, segments, sourcePath, style, voiceEngine, voiceModel, voiceName, voicePath])

  useEffect(() => {
    window.aiPlayer?.player?.hideContainer()
    return () => window.aiPlayer?.player?.showContainer()
  }, [])

  useEffect(() => {
    if (!sourcePath || !window.aiPlayer?.studio) return
    void window.aiPlayer.studio.capabilities().then((next) => {
      setCapabilities(next)
      if (!next.systemVoice) setVoiceEngine('cloud')
    })
    void window.aiPlayer.studio.context(sourcePath).then((context) => {
      setCues(context.cues)
      setSubtitlePath(context.subtitlePath)
    })
  }, [sourcePath])

  useEffect(() => {
    if (!project) return
    const timer = window.setTimeout(() => saveProject(project), 250)
    return () => window.clearTimeout(timer)
  }, [project])

  const addMarker = () => {
    const marker: Marker = {
      id: crypto.randomUUID(), at: currentTime, thumbnail: captureCurrentFrame(),
      shotSize: '中景', movement: '固定', function: '交代', emotion: '平静', note: ''
    }
    setMarkers((items) => [...items, marker].sort((a, b) => a.at - b.at))
    setStatus(`已记录 ${formatTime(currentTime)} 的镜头点`)
  }

  const updateMarker = (id: string, patch: Partial<Marker>) => {
    setMarkers((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item).sort((a, b) => a.at - b.at))
  }

  const jumpTo = (at: number) => {
    usePlayerStore.getState().seek(at)
    usePlayerStore.setState({ isPlaying: false })
  }

  const makeOfflineAnalysis = async () => {
    if (!window.aiPlayer?.studio) return
    setWorking(true)
    try {
      const report = await window.aiPlayer.studio.offlineAnalysis({ mediaName, duration, markers, cues })
      setOfflineAnalysis(report)
      setStatus('离线深度解剖底稿已生成')
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setWorking(false) }
  }

  const makeAiAnalysis = async () => {
    if (!window.aiPlayer?.studio) return
    if (!offlineAnalysis) await makeOfflineAnalysis()
    setWorking(true)
    setStatus('AI 正在联合画面关键帧、字幕和人工拉片证据进行多模态解剖…')
    try {
      const evidenceSegments = segments.length ? segments : markers.map((marker, index) => ({
        id: `evidence-${index + 1}`, start: marker.at,
        end: Math.max(marker.at + 1, Math.min(duration || marker.at + 4, markers[index + 1]?.at || marker.at + 4)),
        title: marker.note || `${marker.function} · ${marker.shotSize}`
      }))
      const plan = await window.aiPlayer.studio.creativePlan({ mediaName, duration, originalGoal, style, markers, segments: evidenceSegments, cues })
      const analysis = plan.deepAnalysis
      const report = [
        `# ${mediaName || '当前视频'} · AI 深度解剖`,
        '', `证据模式：${plan.modality === 'vision+text-evidence' ? `多模态（${plan.visualEvidenceCount || 0} 张关键帧 + 字幕 + 拉片）` : '文本证据（字幕 + 拉片）'}`,
        `分析模型：${plan.provider || '已配置模型'} / ${plan.model || ''}`,
        '', '## 叙事结构', analysis.narrative || '模型未给出独立叙事结论。',
        '', '## 镜头语言与构图', analysis.visual || '缺少可验证画面帧，无法可靠评价构图和表演。',
        '', '## 剪辑与节奏', analysis.editing || '模型未给出独立剪辑结论。',
        '', '## 声音、台词与音乐', analysis.audio || '模型未给出独立声音结论。',
        '', '## 传播钩子', analysis.hook || plan.hook || '模型未给出独立钩子结论。',
        '', '## 缺陷与风险', ...(analysis.weaknesses.length ? analysis.weaknesses.map((item) => `- ${item}`) : ['- 暂无结构化缺陷结论。']),
        ...plan.riskNotes.map((item) => `- ${item}`)
      ].join('\n')
      setAiAnalysis(report)
      if (segments.length) setCreativePlan(plan)
      setStatus(plan.modality === 'vision+text-evidence' ? '多模态深度解剖已完成' : '文本证据解剖已完成；补充关键帧可升级视觉分析')
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setWorking(false) }
  }

  const generateSegments = () => {
    const ordered = [...markers].sort((a, b) => a.at - b.at)
    if (!ordered.length) {
      setStatus('请先在拉片页至少标记一个要保留的镜头点')
      return
    }
    const next = ordered.map((marker, index) => ({
      id: crypto.randomUUID(), start: marker.at,
      end: Math.max(marker.at + 0.2, Math.min(duration || marker.at + 5, ordered[index + 1]?.at || marker.at + 5)),
      title: marker.note || `${marker.function} · ${marker.shotSize}`
    }))
    setSegments(next)
    setTab('recut')
    setStatus(`已从 ${next.length} 个拉片点生成重构时间线，可调整顺序和入出点`)
  }

  const updateSegment = (id: string, patch: Partial<Segment>) => {
    setSegments((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item))
  }

  const moveSegment = (index: number, delta: number) => {
    setSegments((items) => {
      const target = index + delta
      if (target < 0 || target >= items.length) return items
      const copy = [...items]
      ;[copy[index], copy[target]] = [copy[target], copy[index]]
      return copy
    })
  }

  const exportProject = async () => {
    if (!project || !window.aiPlayer?.studio) return
    try {
      const result = await window.aiPlayer.studio.exportProject(project as unknown as Record<string, unknown>)
      if (result.success) setStatus(`项目已导出：${result.outputPath}`)
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
  }

  const render = async () => {
    if (!sourcePath || !window.aiPlayer?.studio || !segments.length) return
    setWorking(true)
    setStatus('正在用内置 mpv 渲染原创重构成片，请保持程序运行…')
    try {
      const result = await window.aiPlayer.studio.render({ mediaName, sourcePath, segments })
      if (result.success) setStatus(`成片已生成：${result.outputPath}`)
      else if (result.cancelled) setStatus('已取消选择输出位置')
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setWorking(false) }
  }

  const generateCreativePlan = async () => {
    if (!window.aiPlayer?.studio || !segments.length) {
      setStatus('请先从拉片点生成并确认重构时间线')
      return
    }
    setWorking(true)
    setStatus('正在按画面帧、字幕和拉片证据生成原创方案…')
    try {
      const plan = await window.aiPlayer.studio.creativePlan({
        mediaName, duration, originalGoal, style, markers, segments, cues
      })
      setCreativePlan(plan)
      setTab('create')
      setStatus(plan.modality === 'vision+text-evidence'
        ? `已用 ${plan.visualEvidenceCount || 0} 张关键帧完成多模态方案（${plan.provider} / ${plan.model}）`
        : plan.visualFallbackReason || `已完成文本证据方案（${plan.provider} / ${plan.model}）；补充带缩略图的拉片点可升级为多模态`)
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setWorking(false) }
  }

  const updateCreativeShot = (id: string, patch: Partial<CreativeShot>) => {
    setCreativePlan((plan) => plan ? { ...plan, shots: plan.shots.map((shot) => shot.id === id ? { ...shot, ...patch } : shot) } : plan)
  }

  const generateShotImage = async (shot: CreativeShot) => {
    if (!window.aiPlayer?.studio) return
    setWorking(true)
    updateCreativeShot(shot.id, { status: 'generating' })
    setStatus(`正在生成新镜头：${shot.title}`)
    try {
      const result = await window.aiPlayer.studio.generateImage({ id: shot.id, prompt: shot.prompt, model: imageModel })
      updateCreativeShot(shot.id, { assetPath: result.outputPath, status: 'ready' })
      setStatus(`新镜头已生成：${result.outputPath}`)
    } catch (error) {
      updateCreativeShot(shot.id, { status: 'failed' })
      setStatus(error instanceof Error ? error.message : String(error))
    } finally { setWorking(false) }
  }

  const importShotImage = async (shot: CreativeShot) => {
    const selected = await window.aiPlayer?.studio?.selectAsset('image')
    if (selected) {
      updateCreativeShot(shot.id, { assetPath: selected, status: 'ready' })
      setStatus(`已导入新镜头素材：${selected}`)
    }
  }

  const generateVoice = async () => {
    if (!creativePlan?.narration.trim() || !window.aiPlayer?.studio) {
      setStatus('请先生成或填写完整旁白')
      return
    }
    setWorking(true)
    setStatus(voiceEngine === 'cloud' ? '正在生成 AI 配音…' : '正在调用本机系统配音…')
    try {
      const result = await window.aiPlayer.studio.generateVoice({
        text: creativePlan.narration, engine: voiceEngine, model: voiceModel, voice: voiceName
      })
      setVoicePath(result.outputPath)
      setStatus(`旁白音频已生成（${result.engine}）：${result.outputPath}`)
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setWorking(false) }
  }

  const chooseMusic = async () => {
    const selected = await window.aiPlayer?.studio?.selectAsset('audio')
    if (selected) {
      setMusicPath(selected)
      setStatus(`已选择音乐：${selected}`)
    }
  }

  const renderCreative = async () => {
    if (!sourcePath || !creativePlan || !window.aiPlayer?.studio) return
    const missing = creativePlan.shots.filter((shot) => shot.kind === 'generated' && !shot.assetPath)
    if (missing.length) {
      setStatus(`还有 ${missing.length} 个新镜头未生成或导入，不能渲染成片`)
      return
    }
    setWorking(true)
    setStatus('正在预渲染镜头、烧录字幕并混合旁白与音乐…')
    try {
      const result = await window.aiPlayer.studio.renderCreative({
        mediaName, title: creativePlan.title, sourcePath, segments, shots: creativePlan.shots,
        subtitleStyle: creativePlan.subtitleStyle, voicePath, musicPath, musicVolume
      })
      if (result.success) setStatus(`AI 原创成片已生成：${result.outputPath}`)
      else if (result.cancelled) setStatus('已取消选择输出位置')
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setWorking(false) }
  }

  if (!sourcePath) {
    return <div className="fixed inset-0 z-[80] bg-black/80 flex items-center justify-center"><div className="bg-player-surface rounded-2xl p-8 text-center"><p className="mb-4">请先打开一个本地视频，再进入拉片工作台。</p><button onClick={onClose} className="px-4 py-2 rounded bg-player-accent">返回</button></div></div>
  }

  return (
    <div className="fixed inset-0 z-[80] bg-[#080b12] text-gray-100 flex flex-col">
      <header className="h-16 shrink-0 border-b border-white/10 flex items-center gap-4 px-5">
        <div className="min-w-0 flex-1"><h2 className="font-semibold">AI 拉片与原创工作台</h2><p className="text-xs text-gray-500 truncate">{mediaName} · {formatTime(currentTime)} / {formatTime(duration)}</p></div>
        <button onClick={addMarker} className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-sm">＋ 标记当前镜头</button>
        <button onClick={() => void exportProject()} className="px-3 py-2 rounded-lg bg-white/10 text-sm">导出项目</button>
        <button onClick={onClose} className="px-3 py-2 text-xl">✕</button>
      </header>
      <nav className="h-12 shrink-0 border-b border-white/10 flex px-5 gap-2">
        {([['breakdown', `1 拉片（${markers.length}）`], ['deep', '2 深度解剖'], ['recut', `3 原创重构（${segments.length}）`], ['create', `4 AI 成片（${creativePlan?.shots.length || 0}）`]] as Array<[Tab, string]>).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} className={`px-4 text-sm border-b-2 ${tab === id ? 'border-cyan-400 text-cyan-300' : 'border-transparent text-gray-500'}`}>{label}</button>
        ))}
      </nav>
      <main className="flex-1 min-h-0 overflow-auto p-5">
        {tab === 'breakdown' && (
          <div className="max-w-6xl mx-auto">
            <div className="rounded-xl bg-white/5 border border-white/10 p-4 mb-4 flex flex-wrap gap-3 items-center text-sm">
              <span>播放到关键画面，点“标记当前镜头”，再补景别、运镜、叙事功能和观察笔记。</span>
              <button onClick={generateSegments} className="ml-auto px-3 py-2 rounded bg-violet-600">生成重构时间线 →</button>
            </div>
            <div className="space-y-3">
              {markers.length === 0 && <div className="py-20 text-center text-gray-600">还没有拉片点。建议从开场钩子、信息转折、高潮和结尾行动点开始标记。</div>}
              {markers.map((marker) => (
                <div key={marker.id} className="grid grid-cols-[150px_110px_1fr] gap-3 rounded-xl border border-white/10 bg-white/[.035] p-3">
                  <button onClick={() => jumpTo(marker.at)} className="text-left">
                    {marker.thumbnail ? <img src={marker.thumbnail} className="w-36 h-20 object-cover rounded bg-black" /> : <div className="w-36 h-20 rounded bg-black flex items-center justify-center text-xs text-gray-600">当前内核无法抓帧</div>}
                  </button>
                  <div><button onClick={() => jumpTo(marker.at)} className="text-cyan-300 font-mono text-sm">{formatTime(marker.at)}</button><input type="number" step="0.1" value={marker.at} onChange={(event) => updateMarker(marker.id, { at: Number(event.target.value) })} className="mt-2 w-full bg-black/40 rounded px-2 py-1 text-xs" /><button onClick={() => setMarkers((items) => items.filter((item) => item.id !== marker.id))} className="mt-3 text-xs text-red-400">删除</button></div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    <select value={marker.shotSize} onChange={(event) => updateMarker(marker.id, { shotSize: event.target.value })} className="bg-[#111827] rounded px-2 py-2 text-sm">{shotSizes.map((value) => <option key={value}>{value}</option>)}</select>
                    <select value={marker.movement} onChange={(event) => updateMarker(marker.id, { movement: event.target.value })} className="bg-[#111827] rounded px-2 py-2 text-sm">{movements.map((value) => <option key={value}>{value}</option>)}</select>
                    <select value={marker.function} onChange={(event) => updateMarker(marker.id, { function: event.target.value })} className="bg-[#111827] rounded px-2 py-2 text-sm">{functions.map((value) => <option key={value}>{value}</option>)}</select>
                    <select value={marker.emotion} onChange={(event) => updateMarker(marker.id, { emotion: event.target.value })} className="bg-[#111827] rounded px-2 py-2 text-sm">{emotions.map((value) => <option key={value}>{value}</option>)}</select>
                    <textarea value={marker.note} onChange={(event) => updateMarker(marker.id, { note: event.target.value })} placeholder="构图、台词、声音、转场、为什么有效/无效…" className="col-span-2 md:col-span-4 min-h-16 bg-black/40 rounded px-3 py-2 text-sm resize-y" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {tab === 'deep' && (
          <div className="max-w-6xl mx-auto grid lg:grid-cols-2 gap-4">
            <section className="rounded-xl border border-white/10 bg-white/[.035] p-4">
              <h3 className="font-medium mb-2">分析证据</h3><p className="text-xs text-gray-500 mb-4">{subtitlePath ? `已读取同名字幕：${subtitlePath}` : '未发现同名字幕；仍可依据人工拉片点分析，不会假装看到了未标注内容。'}</p>
              <label className="text-xs text-gray-400">原创目标</label><textarea value={originalGoal} onChange={(event) => setOriginalGoal(event.target.value)} className="w-full mt-1 mb-3 min-h-20 bg-black/40 rounded p-3 text-sm" />
              <label className="text-xs text-gray-400">表达风格</label><textarea value={style} onChange={(event) => setStyle(event.target.value)} className="w-full mt-1 mb-4 min-h-20 bg-black/40 rounded p-3 text-sm" />
              <div className="flex gap-2"><button disabled={working} onClick={() => void makeOfflineAnalysis()} className="px-4 py-2 rounded bg-white/10 disabled:opacity-50">生成离线结构稿</button><button disabled={working} onClick={() => void makeAiAnalysis()} className="px-4 py-2 rounded bg-violet-600 disabled:opacity-50">AI 深度解剖</button></div>
            </section>
            <section className="rounded-xl border border-white/10 bg-white/[.035] p-4 min-h-[60vh] overflow-auto"><h3 className="font-medium mb-3">解剖报告</h3><pre className="whitespace-pre-wrap text-sm leading-6 text-gray-300 font-sans">{aiAnalysis || offlineAnalysis || '先生成离线结构稿；配置模型后可进一步执行 AI 深度解剖。'}</pre></section>
          </div>
        )}
        {tab === 'recut' && (
          <div className="max-w-6xl mx-auto">
            <div className="rounded-xl bg-white/5 border border-white/10 p-4 mb-4"><p className="text-sm mb-2">这里不是“复制原片”：请调整顺序、入出点；确认后可让多模态模型生成新镜头、旁白、字幕和音乐方案。</p><div className="flex flex-wrap gap-2"><button onClick={generateSegments} className="px-3 py-2 rounded bg-white/10 text-sm">从拉片点重新生成</button><button disabled={working || !segments.length} onClick={() => void render()} className="px-4 py-2 rounded bg-cyan-700 disabled:opacity-50 text-sm">一键渲染 MP4（仅裁剪）</button><button disabled={working || !segments.length} onClick={() => void generateCreativePlan()} className="px-4 py-2 rounded bg-violet-600 disabled:opacity-50 text-sm">AI 生成完整成片方案 →</button>{working && <button onClick={() => void window.aiPlayer?.studio?.cancelRender()} className="px-3 py-2 rounded bg-red-700 text-sm">取消渲染</button>}</div></div>
            <div className="space-y-2">{segments.map((segment, index) => <div key={segment.id} className="grid grid-cols-[50px_1fr_130px_130px_130px] gap-2 items-center rounded-lg border border-white/10 bg-white/[.035] p-3"><span className="text-gray-500">#{index + 1}</span><input value={segment.title} onChange={(event) => updateSegment(segment.id, { title: event.target.value })} className="bg-black/40 rounded px-3 py-2 text-sm" /><label className="text-xs text-gray-500">入点<input type="number" step="0.1" value={segment.start} onChange={(event) => updateSegment(segment.id, { start: Number(event.target.value) })} className="w-full bg-black/40 rounded px-2 py-1 text-sm text-white" /></label><label className="text-xs text-gray-500">出点<input type="number" step="0.1" value={segment.end} onChange={(event) => updateSegment(segment.id, { end: Number(event.target.value) })} className="w-full bg-black/40 rounded px-2 py-1 text-sm text-white" /></label><div className="flex gap-1"><button onClick={() => moveSegment(index, -1)} className="px-2 py-1 bg-white/10 rounded">↑</button><button onClick={() => moveSegment(index, 1)} className="px-2 py-1 bg-white/10 rounded">↓</button><button onClick={() => setSegments((items) => items.filter((item) => item.id !== segment.id))} className="px-2 py-1 text-red-400">删</button></div></div>)}</div>
          </div>
        )}
        {tab === 'create' && (
          <div className="max-w-7xl mx-auto grid xl:grid-cols-[1fr_360px] gap-4">
            <section className="space-y-3">
              {!creativePlan && <div className="rounded-xl border border-white/10 bg-white/[.035] p-10 text-center"><p className="mb-4 text-gray-400">先在“原创重构”页确认片段，再生成完整 AI 成片方案。</p><button disabled={working || !segments.length} onClick={() => void generateCreativePlan()} className="px-4 py-2 rounded bg-violet-600 disabled:opacity-50">生成成片方案</button></div>}
              {creativePlan && <>
                <div className="rounded-xl border border-white/10 bg-white/[.035] p-4">
                  <div className="flex flex-wrap items-start gap-3"><div className="flex-1"><input value={creativePlan.title} onChange={(event) => setCreativePlan({ ...creativePlan, title: event.target.value })} className="w-full bg-transparent text-lg font-semibold outline-none" /><p className="text-xs text-cyan-300 mt-1">{creativePlan.modality === 'vision+text-evidence' ? `多模态：${creativePlan.visualEvidenceCount || 0} 张关键帧 + 字幕 + 拉片` : '文本证据模式：字幕 + 拉片'} · {creativePlan.provider} / {creativePlan.model}</p></div><button disabled={working} onClick={() => void generateCreativePlan()} className="px-3 py-2 rounded bg-white/10 text-sm">重新生成</button></div>
                  <label className="block text-xs text-gray-500 mt-4">开场钩子</label><textarea value={creativePlan.hook} onChange={(event) => setCreativePlan({ ...creativePlan, hook: event.target.value })} className="w-full mt-1 min-h-16 rounded bg-black/40 p-3 text-sm" />
                </div>
                {creativePlan.shots.map((shot, index) => <div key={shot.id} className="rounded-xl border border-white/10 bg-white/[.035] p-4">
                  <div className="flex flex-wrap gap-2 items-center mb-3"><span className={`px-2 py-1 rounded text-xs ${shot.kind === 'generated' ? 'bg-violet-600/30 text-violet-200' : 'bg-cyan-700/30 text-cyan-200'}`}>{shot.kind === 'generated' ? 'AI 新镜头' : '原片重构'}</span><span className="text-gray-500 text-xs">#{index + 1}</span><input value={shot.title} onChange={(event) => updateCreativeShot(shot.id, { title: event.target.value })} className="flex-1 bg-black/30 rounded px-2 py-1 text-sm" /><label className="text-xs text-gray-500">时长 <input type="number" min="1" max="30" step="0.5" value={shot.duration} onChange={(event) => updateCreativeShot(shot.id, { duration: Number(event.target.value) })} className="w-16 bg-black/40 rounded px-2 py-1 text-white" /></label></div>
                  {shot.kind === 'generated' && <div className="grid md:grid-cols-[1fr_220px] gap-3"><div><label className="text-xs text-gray-500">新镜头生成提示词</label><textarea value={shot.prompt} onChange={(event) => updateCreativeShot(shot.id, { prompt: event.target.value })} className="w-full mt-1 min-h-20 rounded bg-black/40 p-3 text-sm" /><div className="flex gap-2 mt-2"><button disabled={working || !shot.prompt} onClick={() => void generateShotImage(shot)} className="px-3 py-2 rounded bg-violet-600 disabled:opacity-50 text-sm">AI 生成画面</button><button onClick={() => void importShotImage(shot)} className="px-3 py-2 rounded bg-white/10 text-sm">导入素材替换</button></div></div><div className="rounded bg-black/50 min-h-28 flex items-center justify-center overflow-hidden">{shot.assetPath ? <img src={`file://${shot.assetPath.replace(/\\/g, '/')}`} className="w-full h-32 object-contain" /> : <span className="text-xs text-gray-600">{shot.status === 'failed' ? '生成失败，可重试或导入' : shot.status === 'generating' ? '正在生成…' : '待生成/导入'}</span>}</div></div>}
                  <div className="grid md:grid-cols-2 gap-3 mt-3"><label className="text-xs text-gray-500">本镜旁白<textarea value={shot.narration} onChange={(event) => updateCreativeShot(shot.id, { narration: event.target.value })} className="w-full mt-1 min-h-16 rounded bg-black/40 p-2 text-sm text-white" /></label><label className="text-xs text-gray-500">屏幕字幕<textarea value={shot.caption} onChange={(event) => updateCreativeShot(shot.id, { caption: event.target.value })} className="w-full mt-1 min-h-16 rounded bg-black/40 p-2 text-sm text-white" /></label></div>
                </div>)}
              </>}
            </section>
            <aside className="space-y-3">
              <div className="rounded-xl border border-white/10 bg-white/[.035] p-4 xl:sticky xl:top-0">
                <h3 className="font-medium mb-3">旁白、字幕与音乐</h3>
                <label className="text-xs text-gray-500">完整旁白</label><textarea value={creativePlan?.narration || ''} onChange={(event) => creativePlan && setCreativePlan({ ...creativePlan, narration: event.target.value })} className="w-full mt-1 min-h-40 rounded bg-black/40 p-3 text-sm" />
                <div className="grid grid-cols-2 gap-2 mt-3"><label className="text-xs text-gray-500">配音方式<select value={voiceEngine} onChange={(event) => setVoiceEngine(event.target.value as 'system' | 'cloud')} className="w-full mt-1 bg-[#111827] rounded px-2 py-2 text-white"><option value="system" disabled={capabilities ? !capabilities.systemVoice : false}>本机系统配音{capabilities && !capabilities.systemVoice ? '（当前端不可用）' : ''}</option><option value="cloud">云端 AI 配音</option></select></label><label className="text-xs text-gray-500">字幕包装<select value={creativePlan?.subtitleStyle || 'clean'} onChange={(event) => creativePlan && setCreativePlan({ ...creativePlan, subtitleStyle: event.target.value as CreativePlan['subtitleStyle'] })} className="w-full mt-1 bg-[#111827] rounded px-2 py-2 text-white"><option value="clean">简洁</option><option value="impact">冲击</option><option value="documentary">纪录片</option></select></label></div>
                {voiceEngine === 'cloud' && <div className="grid grid-cols-2 gap-2 mt-2"><input value={voiceModel} onChange={(event) => setVoiceModel(event.target.value)} placeholder="TTS 模型" className="bg-black/40 rounded px-2 py-2 text-sm" /><input value={voiceName} onChange={(event) => setVoiceName(event.target.value)} placeholder="音色" className="bg-black/40 rounded px-2 py-2 text-sm" /></div>}
                <button disabled={working || !creativePlan?.narration} onClick={() => void generateVoice()} className="w-full mt-3 px-3 py-2 rounded bg-cyan-700 disabled:opacity-50 text-sm">生成旁白音频</button><p className="mt-1 text-[11px] text-gray-600 break-all">{voicePath || '尚未生成；本机配音零 Key，云配音使用模型中心保存的接口。'}</p>
                <label className="block text-xs text-gray-500 mt-4">图像生成模型</label><input value={imageModel} onChange={(event) => setImageModel(event.target.value)} className="w-full mt-1 bg-black/40 rounded px-2 py-2 text-sm" />
                <label className="block text-xs text-gray-500 mt-4">音乐方向</label><textarea value={creativePlan?.musicBrief || ''} onChange={(event) => creativePlan && setCreativePlan({ ...creativePlan, musicBrief: event.target.value })} className="w-full mt-1 min-h-16 rounded bg-black/40 p-2 text-sm" />
                <button onClick={() => void chooseMusic()} className="w-full mt-2 px-3 py-2 rounded bg-white/10 text-sm">选择授权音乐</button><p className="mt-1 text-[11px] text-gray-600 break-all">{musicPath || '可不选；请使用拥有授权的音乐。'}</p>
                <label className="block text-xs text-gray-500 mt-3">音乐音量 {Math.round(musicVolume * 100)}%</label><input type="range" min="0.02" max="0.5" step="0.01" value={musicVolume} onChange={(event) => setMusicVolume(Number(event.target.value))} className="w-full" />
                {creativePlan?.riskNotes.length ? <div className="mt-4 rounded bg-amber-950/30 p-3 text-xs text-amber-200"><p className="font-medium mb-1">发布前检查</p>{creativePlan.riskNotes.map((note, index) => <p key={index}>• {note}</p>)}</div> : null}
                <button disabled={working || !creativePlan || capabilities?.advancedRender === false} onClick={() => void renderCreative()} className="w-full mt-4 px-4 py-3 rounded bg-gradient-to-r from-violet-600 to-cyan-600 disabled:opacity-50 font-medium">生成最终 MP4</button>{capabilities?.advancedRender === false && <p className="mt-2 text-xs text-amber-300">当前 {capabilities.platform} 安装包缺少渲染内核；分析、脚本和云端素材仍可用，但不能冒充已具备本机 MP4 成片能力。</p>}{working && <button onClick={() => void window.aiPlayer?.studio?.cancelRender()} className="w-full mt-2 px-3 py-2 rounded bg-red-800 text-sm">取消当前任务</button>}
              </div>
            </aside>
          </div>
        )}
      </main>
      <footer className="min-h-10 shrink-0 border-t border-white/10 px-5 py-2 text-xs text-gray-400">{status || '项目自动保存在本机；导出 .aiproj.json 可备份或迁移。'}</footer>
    </div>
  )
}
