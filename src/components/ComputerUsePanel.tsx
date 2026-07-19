import { useEffect, useMemo, useState } from 'react'

interface Props { onClose: () => void }

interface ObservationResult {
  requestId: string
  mode: 'observe-only'
  warning: string
  observation: { frameId: string; width: number; height: number; dataUrl: string; createdAt: number }
  recommendation: {
    frameId: string
    reason: string
    action: { type: string; x?: number; y?: number; button?: string; text?: string; deltaY?: number; key?: string }
  }
}

const statusLabels: Record<string, string> = {
  capturing: '正在截取当前应用画面…',
  thinking: '本地视觉模型正在分析…',
  ready: '建议已生成',
  done: '分析完成'
}

export default function ComputerUsePanel({ onClose }: Props) {
  const [task, setTask] = useState('观察当前界面，告诉我下一步应该操作哪里')
  const [requestId, setRequestId] = useState<string | null>(null)
  const [status, setStatus] = useState('请先在模型接入中心配置“电脑操作建议”模型')
  const [result, setResult] = useState<ObservationResult | null>(null)
  const busy = Boolean(requestId)

  useEffect(() => window.aiPlayer?.computerUse?.onStatus((event) => {
    if (event.requestId === requestId) setStatus(statusLabels[event.status] || event.status)
  }), [requestId])

  const marker = useMemo(() => {
    const action = result?.recommendation.action
    return action && typeof action.x === 'number' && typeof action.y === 'number' ? action : null
  }, [result])

  const run = async () => {
    const id = `observe-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    setRequestId(id)
    setResult(null)
    setStatus('准备截图…')
    try {
      const next = await window.aiPlayer?.computerUse?.suggest(task, id)
      if (next) {
        setResult(next)
        setStatus('分析完成；以下仅为建议，未执行任何操作')
      }
    } catch (error) {
      setStatus(`分析失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setRequestId(null)
    }
  }

  const cancel = () => {
    if (requestId) void window.aiPlayer?.computerUse?.cancel(requestId)
    setStatus('正在取消…')
  }

  return (
    <div data-ai-capture-hide className="fixed inset-0 z-[72] bg-black/75 flex items-center justify-center p-6" onClick={onClose}>
      <div className="w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-2xl border border-amber-500/20 bg-[#151515] shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-start justify-between px-6 py-5 border-b border-white/10 bg-[#151515]">
          <div><h2 className="text-lg">电脑操作建议</h2><p className="text-xs text-amber-300 mt-1">观察模式 · 不接管鼠标键盘 · 不执行系统命令</p></div>
          <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
        </div>
        <div className="p-6 space-y-4">
          <textarea value={task} onChange={(event) => setTask(event.target.value)} rows={3} className="w-full rounded-xl bg-black/35 border border-white/10 p-3 text-sm outline-none focus:border-amber-500" placeholder="例如：找出当前页面的播放按钮，并解释为什么" />
          <div className="flex gap-3">
            <button disabled={busy || !task.trim()} onClick={() => void run()} className="rounded-lg bg-amber-600 hover:bg-amber-500 px-5 py-2 text-sm disabled:opacity-40">截图并分析</button>
            {busy && <button onClick={cancel} className="rounded-lg bg-white/10 px-4 py-2 text-sm">取消</button>}
            <button onClick={() => window.dispatchEvent(new CustomEvent('ai-player-action', { detail: 'model-center' }))} className="rounded-lg bg-white/10 px-4 py-2 text-sm">配置模型</button>
          </div>
          <div className="rounded-lg bg-white/5 px-4 py-3 text-sm text-gray-300">{status}</div>
          {result && (
            <div className="grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-4">
              <div className="relative overflow-hidden rounded-xl border border-white/10 bg-black">
                <img src={result.observation.dataUrl} alt="当前应用观察画面" className="block w-full h-auto" />
                {marker && <span className="absolute w-7 h-7 -ml-3.5 -mt-3.5 rounded-full border-2 border-red-400 bg-red-500/30 shadow-[0_0_0_5px_rgba(239,68,68,.15)]" style={{ left: `${marker.x! * 100}%`, top: `${marker.y! * 100}%` }} />}
              </div>
              <div className="rounded-xl border border-white/10 bg-black/25 p-4 text-sm space-y-3">
                <div><span className="text-gray-500">建议动作</span><p className="mt-1 text-white">{result.recommendation.action.type}</p></div>
                <div><span className="text-gray-500">理由</span><p className="mt-1 text-gray-200 leading-6">{result.recommendation.reason}</p></div>
                <pre className="text-xs text-gray-400 whitespace-pre-wrap break-all">{JSON.stringify(result.recommendation.action, null, 2)}</pre>
                <p className="text-xs text-amber-300">{result.warning}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
