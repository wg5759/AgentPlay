import { useRef, useState } from 'react'
import { useAgentStore } from '../stores/agentStore'
import { usePlayerStore } from '../stores/playerStore'

type CueSelection = { index: number; text: string; path: string; sourceContent: string }
export default function PlaybackTools({ source, time, duration, visible, getCue, loadSubtitle }: {
  source: string; time: number; duration: number; visible: boolean
  getCue: () => CueSelection | null; loadSubtitle: (path: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [range, setRange] = useState<{ start?: number; end?: number }>({})
  const [cue, setCue] = useState<CueSelection | null>(null)
  const [text, setText] = useState('')
  const [previousSubtitle, setPreviousSubtitle] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [status, setStatus] = useState('')
  const [cache, setCache] = useState<{ bytes: number; reclaimableBytes: number } | null>(null)
  const button = 'rounded-lg bg-white/10 px-3 py-2 text-sm disabled:opacity-40 hover:bg-white/20'
  const refreshCache = async () => { try { const next = await window.aiPlayer?.inlinePlayback?.cacheStatus(); if (next) setCache(next) } catch { setCache(null) } }
  const edit = async (subtitles: boolean) => {
    const api = window.aiPlayer?.mediaTools
    if (!api || busyRef.current) return
    if (subtitles && (!cue || !text.trim() || /[《》]/.test(text))) { setStatus('请输入字幕文字，暂不支持书名号分隔符。'); return }
    if (!subtitles && (range.start === undefined || range.end === undefined || range.start < 0 || range.end <= range.start || range.end > duration)) { setStatus('请标记有效的起点和终点。'); return }
    const instruction = subtitles && cue ? `把字幕 "${cue.path}" 第${cue.index}条改成《${text.trim()}》` : `保留第${range.start}秒到第${range.end}秒`
    const store = useAgentStore.getState()
    const id = store.startTask({ kind: 'media', label: subtitles ? '修改当前字幕' : '剪出选段', phase: 'running', instruction, source })
    busyRef.current = true; setBusy(true); setStatus('正在生成新版本…')
    try {
      if (subtitles && cue) { const current = await window.aiPlayer?.files?.readText(cue.path); if (!current?.success || current.content !== cue.sourceContent) throw new Error('字幕文件已变化，请重新加载后再修改。') }
      const plan = await api.planEdit({ sourcePath: source, instruction })
      const kinds = subtitles ? ['media.edit-subtitle-cues', 'media.transform-subtitles'] : ['media.trim']
      if (!plan.decision || !kinds.includes(plan.decision.kind)) throw new Error(plan.error || '无法确认编辑范围，请通过对话调整。')
      if (usePlayerStore.getState().videoSrc !== source) throw new Error('当前素材已切换，本次未执行。')
      const result = await api.trim({ sourcePath: source, instruction, decision: plan.decision, requestId: `direct-edit-${Date.now()}`, workspaceTaskId: id })
      if (!result.success || !result.outputPath) throw new Error(result.error || '未生成可用结果')
      store.updateTask(id, { phase: 'completed', outputs: [result.outputPath], summary: result.summary || '已另存新版本，原件保留。' })
      if (usePlayerStore.getState().videoSrc === source) {
        if (subtitles && cue) { setPreviousSubtitle(cue.path); await loadSubtitle(result.outputPath); setCue(null) }
        else usePlayerStore.getState().setMedia(result.outputPath.split(/[\\/]/).pop() || '剪辑结果', result.outputPath)
      }
      setStatus('新版本已打开，原件保留。')
    } catch (error) { const message = error instanceof Error ? error.message : String(error); store.updateTask(id, { phase: 'failed', error: message }); setStatus(message) }
    finally { busyRef.current = false; setBusy(false) }
  }
  return <div className={`absolute top-16 bottom-20 left-4 z-40 flex max-w-[calc(100%_-_2rem)] flex-col items-start pointer-events-none ${!visible && !open ? 'opacity-0' : ''}`} data-player-chrome="true" onDoubleClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <button type="button" className={`${button} shrink-0 ${visible || open ? 'pointer-events-auto' : ''}`} aria-expanded={open} onClick={() => { setOpen(!open); if (!open) void refreshCache() }}>片段与字幕</button>
    {open && <section aria-label="片段与字幕编辑" className="pointer-events-auto mt-2 min-h-0 w-80 max-w-full overflow-y-auto rounded-2xl border border-white/15 bg-slate-950/95 p-4 text-white shadow-xl">
      <div className="flex justify-between"><strong>直接修改当前内容</strong><button onClick={() => setOpen(false)} aria-label="关闭编辑面板">×</button></div>
      <p className="my-3 text-xs text-slate-300">拖动播放进度，标记想保留的范围。</p>
      <div className="flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={() => setRange({ ...range, start: Number(time.toFixed(3)) })}>起点 {range.start ?? '—'}s</button><button className={button} disabled={busy} onClick={() => setRange({ ...range, end: Number(time.toFixed(3)) })}>终点 {range.end ?? '—'}s</button><button className={button} disabled={busy || range.start === undefined || range.end === undefined} onClick={() => void edit(false)}>剪出选段</button></div>
      <button className={`${button} mt-3`} disabled={busy} onClick={() => { const selected = getCue(); setCue(selected); setText(selected?.text || ''); setStatus(selected ? '' : '当前位置没有可编辑的已加载字幕。') }}>修改当前字幕</button>
      <button className={`${button} mt-2`} disabled={busy} onClick={async () => { try { const selected = await window.aiPlayer?.subtitle?.openLocal(); if (selected?.path) { await loadSubtitle(selected.path); setCue(null); setPreviousSubtitle(''); setStatus('字幕已加载，请在对应时间点修改。') } else if (selected?.error) setStatus(selected.error) } catch { setStatus('字幕加载失败，请重新选择。') } }}>加载本地字幕</button>
      {cue && <div className="mt-3"><label className="text-xs">第 {cue.index} 条<textarea aria-label="当前字幕文字" maxLength={500} rows={3} className="mt-1 w-full rounded-lg bg-white/10 p-2 text-sm" value={text} onChange={event => setText(event.target.value)} /></label><button className={button} disabled={busy} onClick={() => void edit(true)}>保存为新字幕</button></div>}
      {previousSubtitle && <button className={`${button} mt-2`} disabled={busy} onClick={() => { void loadSubtitle(previousSubtitle).then(() => { setPreviousSubtitle(''); setStatus('已恢复上一份字幕。') }).catch(() => setStatus('恢复字幕失败，请从任务结果重新打开。')) }}>撤销本次字幕修改</button>}
      {cache && <details className="mt-4 text-xs text-slate-300"><summary>播放缓存 {(cache.bytes / 1024 ** 2).toFixed(1)} MB</summary><p className="my-2">保留原视频和正在使用的缓存。</p><button className={button} disabled={busy || !cache.reclaimableBytes} onClick={async () => { if (busyRef.current) return; busyRef.current = true; setBusy(true); try { const result = await window.aiPlayer?.inlinePlayback?.clearUnusedCache(); setStatus(result?.success ? `已清理 ${((result.removedBytes || 0) / 1024 ** 2).toFixed(1)} MB` : result?.error || '清理失败'); await refreshCache() } catch { setStatus('缓存暂时无法清理，请稍后重试。') } finally { busyRef.current = false; setBusy(false) } }}>清理未使用缓存</button></details>}
      {status && <p className="mt-3 text-sm" role="status">{status}</p>}
    </section>}
  </div>
}
