import { useEffect, useMemo, useState } from 'react'

interface Provider {
  id: string
  name: string
  region: string
  protocol: 'openai' | 'anthropic' | 'gemini'
  baseUrl: string
  models: string[]
  requiresKey: boolean
  modelHint?: string
  roles: Array<'chat' | 'computerUse'>
  capabilities: { streaming?: boolean; tools?: boolean; vision?: boolean; computerUse?: boolean }
  warning?: string
  bundled?: boolean
}

interface DiscoveredService {
  id: string
  name: string
  providerId: string
  baseUrl: string
  models: string[]
}

type ModelRole = 'chat' | 'computerUse'

interface Props {
  onClose: () => void
}

export default function ModelCenter({ onClose }: Props) {
  const [providers, setProviders] = useState<Provider[]>([])
  const [role, setRole] = useState<ModelRole>('chat')
  const [providerId, setProviderId] = useState('deepseek')
  const [model, setModel] = useState('deepseek-chat')
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com/v1')
  const [apiKey, setApiKey] = useState('')
  const [hasApiKey, setHasApiKey] = useState(false)
  const [remoteModels, setRemoteModels] = useState<string[]>([])
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [discovered, setDiscovered] = useState<DiscoveredService[]>([])
  const [bundledStatus, setBundledStatus] = useState<BundledModelStatus | null>(null)
  const [whisperStatus, setWhisperStatus] = useState<{ available: boolean; reason: string; download: Partial<LocalAiDownloadProgress> & { active: boolean }; pack: { totalBytes: number } } | null>(null)
  const [whisperError, setWhisperError] = useState('')
  const [translateStatus, setTranslateStatus] = useState<{ available: boolean; reason: string; download: Partial<LocalAiDownloadProgress> & { active: boolean }; pack: { totalBytes: number } } | null>(null)
  const [translateError, setTranslateError] = useState('')
  const [downloadProgress, setDownloadProgress] = useState<LocalAiDownloadProgress | null>(null)
  const [downloadActive, setDownloadActive] = useState(false)
  const [downloadError, setDownloadError] = useState('')
  const [packBytes, setPackBytes] = useState(0)

  const roleProviders = useMemo(
    () => providers.filter((item) => item.roles.includes(role) && (!item.bundled || bundledStatus?.assetsPresent)),
    [bundledStatus?.assetsPresent, providers, role]
  )
  const provider = roleProviders.find((item) => item.id === providerId)
  const modelOptions = useMemo(
    () => [...new Set([...(remoteModels || []), ...(provider?.models || [])])],
    [provider, remoteModels]
  )

  useEffect(() => {
    let active = true
    Promise.all([window.aiPlayer?.models?.providers(), window.aiPlayer?.models?.config('chat'), window.aiPlayer?.models?.bundledStatus(), window.aiPlayer?.localAI?.status()]).then(([items, saved, localStatus, localAiStatus]) => {
      if (!active) return
      const nextProviders = items || []
      setProviders(nextProviders)
      setBundledStatus(localStatus || null)
      setPackBytes(localAiStatus?.pack?.totalBytes || 0)
      setDownloadActive(Boolean(localAiStatus?.download?.active))
      if (saved && !(saved.providerId === 'bundled-lite' && !localStatus?.assetsPresent)) {
        setProviderId(saved.providerId)
        setModel(saved.model)
        setBaseUrl(saved.baseUrl)
        setHasApiKey(saved.hasApiKey)
      } else if (nextProviders.length) {
        const initial = nextProviders.find((item) => item.id === 'deepseek') || nextProviders[0]
        setProviderId(initial.id)
        setModel(initial.models[0])
        setBaseUrl(initial.baseUrl)
      }
    })
    const offProgress = window.aiPlayer?.localAI?.onProgress?.((progress) => {
      if (!active) return
      setDownloadProgress(progress)
      setDownloadActive(progress.stage !== 'done')
      if (progress.stage === 'done') {
        void window.aiPlayer?.models?.bundledStatus().then((next) => { if (active && next) setBundledStatus(next) })
      }
    })
    void window.aiPlayer?.transcribe?.status().then((status) => { if (active && status) setWhisperStatus(status) })
    const offWhisper = window.aiPlayer?.transcribe?.onProgress?.(() => {
      void window.aiPlayer?.transcribe?.status().then((status) => { if (active && status) setWhisperStatus(status) })
    })
    void window.aiPlayer?.translatePack?.status().then((status) => { if (active && status) setTranslateStatus(status) })
    const offTranslate = window.aiPlayer?.translatePack?.onProgress?.(() => {
      void window.aiPlayer?.translatePack?.status().then((status) => { if (active && status) setTranslateStatus(status) })
    })
    return () => { active = false; offProgress?.(); offWhisper?.(); offTranslate?.() }
  }, [])

  const changeRole = async (nextRole: ModelRole) => {
    setRole(nextRole)
    setBusy(true)
    setStatus('正在加载该角色的独立配置…')
    const saved = await window.aiPlayer?.models?.config(nextRole)
    setBusy(false)
    setRemoteModels([])
    setDiscovered([])
    setApiKey('')
    if (saved) {
      setProviderId(saved.providerId)
      setModel(saved.model)
      setBaseUrl(saved.baseUrl)
      setHasApiKey(saved.hasApiKey)
    } else {
      const initial = providers.find((item) => item.roles.includes(nextRole))
      if (initial) changeProvider(initial.id)
    }
    setStatus('')
  }

  const changeProvider = (id: string) => {
    const next = roleProviders.find((item) => item.id === id)
    if (!next) return
    setProviderId(id)
    setModel(next.models[0] || '')
    setBaseUrl(next.baseUrl)
    setApiKey('')
    setHasApiKey(false)
    setRemoteModels([])
    setStatus('')
  }

  const connectionInput = () => ({
    providerId,
    role,
    model,
    baseUrl,
    apiKey,
    useSavedKey: hasApiKey && !apiKey
  })

  const refreshModels = async () => {
    setBusy(true)
    setStatus('正在读取账户可用模型…')
    const result = await window.aiPlayer?.models?.list(connectionInput())
    setBusy(false)
    if (!result?.success) {
      setStatus(`读取失败：${result?.error || '未知错误'}`)
      return
    }
    setRemoteModels(result.models)
    if (result.models.length && !result.models.includes(model)) setModel(result.models[0])
    setStatus(`已读取 ${result.models.length} 个可用模型`)
  }

  const discoverLocal = async () => {
    setBusy(true)
    setStatus('正在查找本机已启动的模型服务…')
    try {
      const results = await window.aiPlayer?.models?.discoverLocal(role) || []
      setDiscovered(results)
      setStatus(results.length ? `✓ 找到 ${results.length} 个本地模型服务` : '没有发现已启动的本地模型服务；请先启动 Ollama、LM Studio、vLLM、llama.cpp 或 Fara 服务。')
    } catch (error) {
      setStatus(`发现失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const useDiscovered = (service: DiscoveredService) => {
    const next = roleProviders.find((item) => item.id === service.providerId)
    if (!next) return
    setProviderId(next.id)
    setBaseUrl(service.baseUrl)
    setRemoteModels(service.models)
    setModel(service.models[0] || next.models[0] || '')
    setApiKey('')
    setHasApiKey(false)
    setStatus(`已填入 ${service.name}，请测试连接后保存。`)
  }

  const startLocalAiDownload = async () => {
    setDownloadError('')
    setDownloadActive(true)
    try {
      const result = await window.aiPlayer?.localAI?.download()
      if (!result) throw new Error('桌面本地下载接口不可用')
      if (!result.success) throw new Error(result.error || '下载失败')
      if (result.status) setBundledStatus(result.status)
      setStatus('✓ 本地 AI 组件已下载并通过校验，可以启动内置模型。')
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : String(error))
    } finally {
      setDownloadActive(false)
      setDownloadProgress(null)
    }
  }

  const cancelLocalAiDownload = async () => {
    await window.aiPlayer?.localAI?.cancel()
  }

  const startWhisperDownload = async () => {
    setWhisperError('')
    try {
      const result = await window.aiPlayer?.transcribe?.download()
      if (!result?.success) throw new Error(result?.error || '下载失败')
      const status = await window.aiPlayer?.transcribe?.status()
      if (status) setWhisperStatus(status)
    } catch (error) {
      setWhisperError(error instanceof Error ? error.message : String(error))
    }
  }

  const cancelWhisperDownload = async () => {
    await window.aiPlayer?.transcribe?.cancelDownload()
  }

  const startTranslateDownload = async () => {
    setTranslateError('')
    try {
      const result = await window.aiPlayer?.translatePack?.download()
      if (!result?.success) throw new Error(result?.error || '下载失败')
      const status = await window.aiPlayer?.translatePack?.status()
      if (status) setTranslateStatus(status)
    } catch (error) {
      setTranslateError(error instanceof Error ? error.message : String(error))
    }
  }

  const cancelTranslateDownload = async () => {
    await window.aiPlayer?.translatePack?.cancelDownload()
  }

  const startBundled = async () => {
    setBusy(true)
    setStatus('正在校验并加载内置模型；已采用低占用配置，首次启动通常需要数秒…')
    try {
      const result = await window.aiPlayer?.models?.startBundled()
      if (!result) throw new Error('桌面本地模型接口不可用')
      setBundledStatus(result)
      setProviderId(result.providerId)
      setBaseUrl(result.baseUrl)
      setModel(result.model)
      setRemoteModels([result.model])
      setApiKey('')
      setHasApiKey(false)
      setStatus('✓ 内置轻量模型已在本机启动；播放器控制不经过模型，闲置后会自动释放内存。')
    } catch (error) {
      const next = await window.aiPlayer?.models?.bundledStatus().catch(() => null)
      if (next) setBundledStatus(next)
      setStatus(`启动失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const stopBundled = async () => {
    setBusy(true)
    try {
      const result = await window.aiPlayer?.models?.stopBundled()
      if (result) setBundledStatus(result)
      setStatus('内置模型已停止并释放内存')
    } finally {
      setBusy(false)
    }
  }

  const testConnection = async () => {
    setBusy(true)
    setStatus('正在测试连接…')
    const result = await window.aiPlayer?.models?.test(connectionInput())
    setBusy(false)
    setStatus(result?.success ? `✓ ${result.message}` : `连接失败：${result?.message || '未知错误'}`)
  }

  const save = async () => {
    setBusy(true)
    setStatus('正在安全保存…')
    try {
      const saved = await window.aiPlayer?.models?.save({ role, providerId, model, baseUrl, apiKey })
      setHasApiKey(Boolean(saved?.hasApiKey))
      setApiKey('')
      setStatus(`✓ 已保存：${provider?.name || providerId} / ${model}，Key 使用系统加密存储`)
    } catch (error) {
      setStatus(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const clearKey = async () => {
    await window.aiPlayer?.models?.save({ role, providerId, model, baseUrl, clearApiKey: true })
    setApiKey('')
    setHasApiKey(false)
    setStatus('已清除保存的 API Key')
  }

  return (
    <div className="fixed inset-0 z-[70] bg-black/70 flex items-center justify-center p-6" onClick={onClose}>
      <div className="w-full max-w-3xl max-h-[88vh] overflow-y-auto rounded-2xl border border-white/10 bg-[#151515] shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-start justify-between px-6 py-5 border-b border-white/10 bg-[#151515]">
          <div>
            <h2 className="text-lg font-medium">模型接入中心</h2>
            <p className="text-xs text-gray-500 mt-1">按用途选公司、型号和地址；聊天与电脑观察配置互不影响</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-lg">✕</button>
        </div>

        <div className="p-6 space-y-5">
          <div>
            <span className="block text-xs text-gray-400 mb-2">用途</span>
            <div className="grid grid-cols-2 gap-2 rounded-xl bg-black/25 p-1">
              <button disabled={busy} onClick={() => void changeRole('chat')} className={`rounded-lg py-2 text-sm ${role === 'chat' ? 'bg-player-accent text-white' : 'text-gray-400 hover:bg-white/5'}`}>AI 对话</button>
              <button disabled={busy} onClick={() => void changeRole('computerUse')} className={`rounded-lg py-2 text-sm ${role === 'computerUse' ? 'bg-amber-600 text-white' : 'text-gray-400 hover:bg-white/5'}`}>电脑操作建议</button>
            </div>
          </div>

          {role === 'computerUse' && <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">安全预览阶段：模型只观察当前应用画面并给出建议，不会点击鼠标、输入键盘或执行命令。</div>}

          {role === 'chat' && bundledStatus && <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-4 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm text-emerald-100">内置离线模型 · {bundledStatus.modelName}</div>
                <div className="mt-1 text-xs text-gray-500">
                  {bundledStatus.modelSizeMb}MB · 当前可用 {bundledStatus.hardware.availableMemoryGb}/{bundledStatus.hardware.totalMemoryGb}GB · AI {bundledStatus.hardware.threads}/{bundledStatus.hardware.logicalCpus} 线程 · {bundledStatus.hardware.contextSize / 1024}K 上下文
                </div>
                <div className={`mt-2 text-xs ${bundledStatus.hardware.eligible ? 'text-emerald-300/80' : 'text-amber-300'}`}>{bundledStatus.hardware.reason}</div>
                <div className="mt-2 text-xs text-sky-300/80">暂停、快进、音量、倍速、字幕、画面比例、窗口和截图均走本地快速路由；模型只做语义与字幕摘要，闲置 {bundledStatus.idleReleaseMinutes} 分钟自动释放。</div>
                {!bundledStatus.assetsPresent && <div className="mt-3 rounded-lg border border-sky-500/25 bg-sky-500/5 p-3">
                  <div className="text-xs text-gray-400">当前是标准版，未携带本地模型。可在线下载本地 AI 组件（约 {packBytes ? `${Math.round(packBytes / 1024 / 1024)}MB` : '426MB'}，只需下载一次，支持断点续传和 SHA-256 校验），下载完成后即可离线使用；也可以直接连接云端或已有 Ollama、LM Studio、vLLM、llama.cpp 服务。</div>
                  {downloadActive ? (
                    <div className="mt-3">
                      <div className="h-2 overflow-hidden rounded-full bg-black/40"><div className="h-full bg-sky-500 transition-all" style={{ width: `${downloadProgress && downloadProgress.totalBytes ? Math.min(100, Math.round((downloadProgress.receivedBytes / downloadProgress.totalBytes) * 100)) : 0}%` }} /></div>
                      <div className="mt-2 flex items-center justify-between gap-3 text-xs text-gray-400">
                        <span>{downloadProgress ? `${({ download: '下载中', verify: '校验中', extract: '解压中', done: '完成' } as Record<string, string>)[downloadProgress.stage] || downloadProgress.stage} ${downloadProgress.currentFile || ''} · ${(downloadProgress.receivedBytes / 1024 / 1024).toFixed(0)}/${(downloadProgress.totalBytes / 1024 / 1024).toFixed(0)}MB` : '正在连接…'}</span>
                        <button onClick={() => void cancelLocalAiDownload()} className="shrink-0 text-red-300 hover:text-red-200">取消</button>
                      </div>
                    </div>
                  ) : (
                    <button disabled={busy} onClick={() => void startLocalAiDownload()} className="mt-3 rounded-lg bg-sky-600/80 px-4 py-2 text-sm text-white hover:bg-sky-600 disabled:opacity-40">下载本地 AI 组件</button>
                  )}
                  {downloadError && <div className="mt-2 text-xs text-red-300">{downloadError}</div>}
                </div>}
                {bundledStatus.lastNotice && <div className="mt-2 text-xs text-sky-300">{bundledStatus.lastNotice}</div>}
                {bundledStatus.lastError && <div className="mt-2 text-xs text-red-300">{bundledStatus.lastError}</div>}
              </div>
              {bundledStatus.running
                ? <button disabled={busy} onClick={() => void stopBundled()} className="rounded-lg bg-white/10 px-4 py-2 text-sm hover:bg-white/15 disabled:opacity-40">停止并释放内存</button>
                : <button disabled={busy || !bundledStatus.assetsPresent || !bundledStatus.hardware.eligible} onClick={() => void startBundled()} className="rounded-lg bg-emerald-600/80 px-4 py-2 text-sm hover:bg-emerald-600 disabled:opacity-40">启动内置模型</button>}
            </div>
          </div>}

          {role === 'chat' && whisperStatus && <div className="rounded-xl border border-violet-500/25 bg-violet-500/5 px-4 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm text-violet-100">录音转写组件 · whisper.cpp + ggml-tiny</div>
                <div className="mt-1 text-xs text-gray-500">约 {Math.round((whisperStatus.pack?.totalBytes || 0) / 1024 / 1024)}MB · 离线中文语音转文字，可出带时间轴字幕</div>
                {!whisperStatus.available && !whisperStatus.download?.active && <div className="mt-2 text-xs text-amber-300">{whisperStatus.reason}；下载一次即可离线使用。</div>}
                {whisperStatus.available && <div className="mt-2 text-xs text-emerald-300">已就绪：音频附件说“转写这段录音”，视频右键菜单可“生成双语字幕”。</div>}
                {whisperError && <div className="mt-2 text-xs text-red-300">{whisperError}</div>}
              </div>
              {!whisperStatus.available && (whisperStatus.download?.active
                ? <button onClick={() => void cancelWhisperDownload()} className="rounded-lg bg-white/10 px-4 py-2 text-sm hover:bg-white/15">取消下载</button>
                : <button disabled={busy} onClick={() => void startWhisperDownload()} className="rounded-lg bg-violet-600/80 px-4 py-2 text-sm hover:bg-violet-600 disabled:opacity-40">下载转写组件</button>)}
            </div>
            {whisperStatus.download?.active && (
              <div className="mt-3">
                <div className="h-2 overflow-hidden rounded-full bg-black/40"><div className="h-full bg-violet-500 transition-all" style={{ width: `${Math.min(100, Math.round(((whisperStatus.download.receivedBytes || 0) / (whisperStatus.download.totalBytes || 1)) * 100))}%` }} /></div>
                <div className="mt-1 text-xs text-gray-400">{whisperStatus.download.currentFile || '下载中'} · {((whisperStatus.download.receivedBytes || 0) / 1024 / 1024).toFixed(0)}/{((whisperStatus.download.totalBytes || 0) / 1024 / 1024).toFixed(0)}MB</div>
              </div>
            )}
          </div>}

          {role === 'chat' && translateStatus && <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-4 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm text-emerald-100">离线翻译组件 · OPUS-MT 英译中</div>
                <div className="mt-1 text-xs text-gray-500">约 {Math.round((translateStatus.pack?.totalBytes || 0) / 1024 / 1024)}MB · 纯本地翻译英文字幕，不用云模型、不发任何内容出机</div>
                {!translateStatus.available && !translateStatus.download?.active && <div className="mt-2 text-xs text-amber-300">{translateStatus.reason}；下载一次即可离线使用。</div>}
                {translateStatus.available && <div className="mt-2 text-xs text-emerald-300">已就绪：双语字幕与实时翻译遇到英文字幕时自动走本地，其它语言仍用云端模型。</div>}
                {translateError && <div className="mt-2 text-xs text-red-300">{translateError}</div>}
              </div>
              {!translateStatus.available && (translateStatus.download?.active
                ? <button onClick={() => void cancelTranslateDownload()} className="rounded-lg bg-white/10 px-4 py-2 text-sm hover:bg-white/15">取消下载</button>
                : <button disabled={busy} onClick={() => void startTranslateDownload()} className="rounded-lg bg-emerald-600/80 px-4 py-2 text-sm hover:bg-emerald-600 disabled:opacity-40">下载离线翻译组件</button>)}
            </div>
            {translateStatus.download?.active && (
              <div className="mt-3">
                <div className="h-2 overflow-hidden rounded-full bg-black/40"><div className="h-full bg-emerald-500 transition-all" style={{ width: `${Math.min(100, Math.round(((translateStatus.download.receivedBytes || 0) / (translateStatus.download.totalBytes || 1)) * 100))}%` }} /></div>
                <div className="mt-1 text-xs text-gray-400">{translateStatus.download.currentFile || '下载中'} · {((translateStatus.download.receivedBytes || 0) / 1024 / 1024).toFixed(0)}/{((translateStatus.download.totalBytes || 0) / 1024 / 1024).toFixed(0)}MB</div>
              </div>
            )}
          </div>}

          <div className="rounded-xl border border-sky-500/20 bg-sky-500/5 px-4 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm text-sky-100">已有本地模型服务？</div>
                <div className="mt-1 text-xs text-gray-500">只检测本机端口，不下载模型、不启动后台服务。</div>
              </div>
              <button disabled={busy} onClick={() => void discoverLocal()} className="rounded-lg bg-sky-600/80 px-4 py-2 text-sm hover:bg-sky-600 disabled:opacity-40">自动发现本地模型</button>
            </div>
            {discovered.length > 0 && <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {discovered.map((service) => <button key={`${service.id}-${service.baseUrl}`} onClick={() => useDiscovered(service)} className="rounded-lg border border-white/10 bg-black/20 px-3 py-3 text-left hover:border-sky-500/50">
                <span className="block text-sm text-gray-200">{service.name}</span>
                <span className="mt-1 block truncate text-xs text-gray-500">{service.models.length} 个型号 · {service.baseUrl}</span>
              </button>)}
            </div>}
          </div>

          <label className="block">
            <span className="block text-xs text-gray-400 mb-2">1. 模型公司 / 服务</span>
            <select value={providerId} onChange={(event) => changeProvider(event.target.value)} className="w-full bg-black/35 border border-white/10 rounded-lg px-3 py-3 text-sm outline-none focus:border-player-accent">
              {roleProviders.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.region}</option>)}
            </select>
          </label>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="block">
              <span className="block text-xs text-gray-400 mb-2">2. 大模型型号</span>
              <input list="model-options" value={model} onChange={(event) => setModel(event.target.value)} placeholder="可选择，也可直接输入型号" className="w-full bg-black/35 border border-white/10 rounded-lg px-3 py-3 text-sm outline-none focus:border-player-accent" />
              <datalist id="model-options">{modelOptions.map((item) => <option key={item} value={item} />)}</datalist>
              {provider?.modelHint && <p className="text-xs text-amber-400/80 mt-2">{provider.modelHint}</p>}
              {provider?.warning && <p className="text-xs text-amber-400/80 mt-2">{provider.warning}</p>}
            </label>
            <label className="block">
              <span className="block text-xs text-gray-400 mb-2">3. API Key {provider?.requiresKey ? '' : '（本地服务可不填）'}</span>
              <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={hasApiKey ? '已安全保存；留空表示继续使用' : '粘贴 API Key'} className="w-full bg-black/35 border border-white/10 rounded-lg px-3 py-3 text-sm outline-none focus:border-player-accent" />
            </label>
          </div>

          <label className="block">
            <span className="block text-xs text-gray-400 mb-2">4. API / 网页服务地址</span>
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://.../v1" className="w-full bg-black/35 border border-white/10 rounded-lg px-3 py-3 text-sm font-mono outline-none focus:border-player-accent" />
            <p className="text-xs text-gray-600 mt-2">支持官方接口、本地 Ollama / LM Studio、OpenAI 兼容代理和自建服务；不会抓取网页账号或 Cookie。</p>
          </label>

          <div className="flex flex-wrap gap-3">
            <button disabled={busy} onClick={refreshModels} className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-sm disabled:opacity-40">读取可用型号</button>
            <button disabled={busy} onClick={testConnection} className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-sm disabled:opacity-40">测试连接</button>
            <button disabled={busy || !model || !baseUrl} onClick={save} className="px-5 py-2 rounded-lg bg-player-accent hover:bg-blue-600 text-sm disabled:opacity-40">保存并启用</button>
            {hasApiKey && <button disabled={busy} onClick={clearKey} className="px-3 py-2 text-xs text-red-300 hover:text-red-200">清除已存 Key</button>}
          </div>

          {status && <div className={`rounded-lg px-4 py-3 text-sm ${status.startsWith('✓') ? 'bg-emerald-500/10 text-emerald-300' : 'bg-white/5 text-gray-300'}`}>{status}</div>}

          <div className="rounded-xl bg-black/25 px-4 py-3 text-xs text-gray-500 leading-6">
            已内置全球及国内主流服务，并以“实时读取账户模型”应对厂商型号更新。本地框架可连接 Ollama、LM Studio、vLLM、llama.cpp、Colibri 和 Fara 的 OpenAI 兼容服务，只允许本机回环地址，绝不自动下载大模型权重。API Key 由系统安全存储加密后落盘。
          </div>
        </div>
      </div>
    </div>
  )
}
