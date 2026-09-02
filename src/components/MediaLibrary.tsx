import React, { useEffect, useState } from 'react'
import { useAgentStore } from '../stores/agentStore'
import Recorder from './Recorder'
import { usePlayerStore } from '../stores/playerStore'
import mediaFormats from '../../electron/media-formats.json'

interface MediaFile {
  name: string
  path: string
  ext: string
  size: number
  tags?: string[]
  group?: string
}

interface Props {
  onPlay: (name: string, path: string) => void
  rootDir?: string
  actionRequest?: { id: number; action: string } | null
}


export default function MediaLibrary({ onPlay, rootDir, actionRequest }: Props) {
  const openPanel = useAgentStore((s) => s.openPanel)
  const [menu, setMenu] = useState<{ x: number; y: number; file: MediaFile } | null>(null)
  const [files, setFiles] = useState<MediaFile[]>([])
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [dedupResults, setDedupResults] = useState<Array<{ original: string; duplicate: string; name: string }> | null>(null)
  const [dedupRequestId, setDedupRequestId] = useState('')
  const [dedupStatus, setDedupStatus] = useState('')
  const [suggestResults, setSuggestResults] = useState<Array<{ tag: string; count: number; suggestion: string }> | null>(null)
  const [plugins, setPlugins] = useState<PluginSkillInfo[] | null>(null)
  const [pluginStatus, setPluginStatus] = useState('')
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [networkSources, setNetworkSources] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('networkSources') || '[]')
    } catch {
      return []
    }
  })

  const startMirrorRecv = async () => {
    setMirrorError('')
    const result = await window.aiPlayer?.mirror?.startReceiver()
    if (result?.success && result.pin) setMirrorRecv({ pin: result.pin, name: result.name || '' })
    else setMirrorError('接收模式开启失败')
  }
  const stopMirrorRecv = async () => {
    await window.aiPlayer?.mirror?.stopReceiver()
    setMirrorRecv(null)
  }
  const scanMirrorDevices = async () => {
    setMirrorScanning(true)
    setMirrorError('')
    try {
      const devices = await window.aiPlayer?.mirror?.scan()
      setMirrorDevices(devices || [])
    } finally {
      setMirrorScanning(false)
    }
  }
  const startMirrorSend = async (device: { host: string; port: number }) => {
    setMirrorError('')
    const result = await window.aiPlayer?.mirror?.startSender({ host: device.host, port: device.port, pin: mirrorPin })
    if (result?.success) setMirrorSending({ host: device.host, port: device.port })
    else setMirrorError(result?.error || '投屏连接失败')
  }
  const stopMirrorSend = async () => {
    await window.aiPlayer?.mirror?.stopSender()
    setMirrorSending(null)
  }
  const [showAddUrl, setShowAddUrl] = useState(false)
  const [wifiUrl, setWifiUrl] = useState<string | null>(null)
  const [wifiPin, setWifiPin] = useState<string | null>(null)
  const [mirrorRecv, setMirrorRecv] = useState<{ pin: string; name: string } | null>(null)
  const [mirrorSending, setMirrorSending] = useState<{ host: string; port: number } | null>(null)
  const [mirrorDevices, setMirrorDevices] = useState<Array<{ name: string; host: string; port: number }>>([])
  const [mirrorScanning, setMirrorScanning] = useState(false)
  const [mirrorPin, setMirrorPin] = useState('')
  const [mirrorError, setMirrorError] = useState('')
  const [castDevices, setCastDevices] = useState<Array<{ id: string; name: string; lastSuccess?: boolean }>>([])
  const [castFile, setCastFile] = useState<string | null>(null)
  const [castStatus, setCastStatus] = useState<{ deviceId: string; message: string; isError?: boolean; stateLabel?: string; needFirewall?: boolean } | null>(null)
  const [scanning, setScanning] = useState(false)
  const [syncUrl, setSyncUrl] = useState<string | null>(null)
  const [dlnaServerUrl, setDlnaServerUrl] = useState<string | null>(null)
  const [receiverEnabled, setReceiverEnabled] = useState(false)
  const [peerUrl, setPeerUrl] = useState('')
  const [syncStatus, setSyncStatus] = useState('')
  const [urlInput, setUrlInput] = useState('')
  const [showMore, setShowMore] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [posters, setPosters] = useState<Record<string, { poster: string | null; title: string; overview: string; year: string | null }>>(() => {
    try { return JSON.parse(localStorage.getItem('aiplayer_metadata_cache') || '{}') } catch { return {} }
  })
  const [metadataStatus, setMetadataStatus] = useState('')
  const [recordTrigger, setRecordTrigger] = useState(0)
  const favorites = usePlayerStore((state) => state.favorites)
  const toggleFavorite = usePlayerStore((state) => state.toggleFavorite)

  const addNetworkSource = () => {
    const url = urlInput.trim()
    if (!url) return
    const next = [...networkSources, url]
    setNetworkSources(next)
    localStorage.setItem('networkSources', JSON.stringify(next))
    setUrlInput('')
    setShowAddUrl(false)
  }

  const handleDedup = async () => {
    if (!window.aiPlayer?.media || dedupRequestId) return
    const requestId = crypto.randomUUID()
    setDedupRequestId(requestId)
    setDedupStatus('正在扫描媒体库…')
    setDedupResults(null)
    setShowMore(true)
    try {
      const result = await window.aiPlayer.media.dedup({ requestId, dir: rootDir })
      if (result.cancelled) {
        setDedupStatus('扫描已取消，后台已停止读盘')
        return
      }
      if (!result.success) throw new Error(result.error || '重复文件扫描失败')
      setDedupResults(result.duplicates)
      setDedupStatus(result.duplicates.length
        ? `已扫描 ${result.filesScanned} 个媒体文件，发现 ${result.duplicates.length} 组重复`
        : `已扫描 ${result.filesScanned} 个媒体文件，没有发现重复`)
    } catch (error) {
      setDedupStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setDedupRequestId('')
    }
  }

  const cancelDedup = async () => {
    if (!dedupRequestId) return
    const cancelled = await window.aiPlayer?.media?.cancel(dedupRequestId)
    if (!cancelled) setDedupStatus('后台没有确认取消，扫描状态保持不变')
  }

  const handleSuggest = async () => {
    const r = await window.aiPlayer?.media?.suggest()
    setSuggestResults(r || [])
    setShowMore(true)
  }
  const handlePlugins = async () => {
    const r = await window.aiPlayer?.plugin?.list()
    setPlugins(r || [])
    setPluginStatus('')
    setShowMore(true)
  }

  const installPlugin = async () => {
    setPluginStatus('正在校验插件包…')
    const result = await window.aiPlayer?.plugin?.install()
    if (result?.plugins) setPlugins(result.plugins)
    setPluginStatus(result?.cancelled ? '' : result?.success ? '插件已安装，默认保持禁用' : result?.error || '插件安装失败')
  }

  const togglePlugin = async (plugin: PluginSkillInfo) => {
    const enabled = !plugin.enabled
    if (enabled) {
      const permissions = plugin.permissions.length ? plugin.permissions.join('、') : '无额外权限'
      if (!window.confirm(`启用“${plugin.name}”？\n\n本次确认权限：${permissions}\n\n插件只能调用 AgentPlay 已有受控工具，不能执行第三方代码。`)) return
    }
    const result = await window.aiPlayer?.plugin?.setEnabled({ id: plugin.id, enabled, permissions: plugin.permissions })
    if (result?.plugins) setPlugins(result.plugins)
    setPluginStatus(result?.success ? (enabled ? '插件已启用' : '插件已禁用') : result?.error || '状态更新失败')
  }

  const removePlugin = async (plugin: PluginSkillInfo) => {
    if (!window.confirm(`移除“${plugin.name}”？\n\n插件会移入本机可恢复回收目录，不会直接永久删除。`)) return
    const result = await window.aiPlayer?.plugin?.remove({ id: plugin.id, confirmed: true })
    if (result?.plugins) setPlugins(result.plugins)
    setPluginStatus(result?.success ? '插件已移入可恢复回收目录' : result?.error || '插件移除失败')
  }

  const handleMetadata = async () => {
    const credentials = await window.aiPlayer?.serviceCredentials?.status()
    if (credentials && !credentials.services.tmdb.hasKey) {
      setMetadataStatus('请先在“运行与隐私”里填写 TMDB Key')
      return
    }
    const videos = files.filter((f) => mediaFormats.video.includes(f.ext.toLowerCase())).slice(0, 30)
    if (videos.length === 0) {
      setMetadataStatus('媒体库里没有可刮削的视频')
      return
    }
    setMetadataStatus(`正在刮削 0/${videos.length}…`)
    const next = { ...posters }
    let completed = 0
    for (let i = 0; i < videos.length; i += 3) {
      const batch = videos.slice(i, i + 3)
      await Promise.all(batch.map(async (file) => {
        const query = file.name
          .replace(/\.[^.]+$/, '')
          .replace(/[._]/g, ' ')
          .replace(/\b(19|20)\d{2}\b.*$/, '')
          .replace(/\[[^\]]+\]|\([^)]*\)/g, '')
          .trim()
        const result = await window.aiPlayer?.tmdb?.search(query)
        if (result?.success && result.data) next[file.path] = result.data
        completed += 1
        setMetadataStatus(`正在刮削 ${completed}/${videos.length}…`)
      }))
      setPosters({ ...next })
      localStorage.setItem('aiplayer_metadata_cache', JSON.stringify(next))
    }
    setMetadataStatus(`海报刮削完成：匹配 ${Object.keys(next).length}/${videos.length}`)
  }

  const handleSync = async (action: 'upload' | 'download') => {
    if (!window.aiPlayer?.sync) return
    if (peerUrl && !(await window.aiPlayer.sync.setPeer(peerUrl))) {
      setSyncStatus('失败: 对端 URL 无效，请粘贴完整配对地址')
      return
    }
    setSyncStatus(action === 'upload' ? '上传中…' : '下载中…')
    const result = await window.aiPlayer.sync[action]()
    setSyncStatus(result.error ? `失败: ${result.error}` : `成功（${result.count || 0}条）`)
  }

  const handleCast = async (filePath: string) => {
    setCastFile(filePath)
    setScanning(true)
    // 首次投屏先查防火墙：DLNA 是"推 URL、电视拉回内容"，防火墙拦 18901 入站则电视永远拉不到
    try {
      const fw = await window.aiPlayer?.cast?.ensureFirewall?.()
      if (fw?.needed) {
        setCastStatus({ deviceId: '', message: '首次投屏需要放行局域网端口 18901（Windows 防火墙一次性授权，弹窗点"是"即可）', needFirewall: true })
      }
    } catch { /* 探测失败不影响扫描 */ }
    try {
      const devices = await window.aiPlayer?.cast?.scan()
      setCastDevices(devices || [])
    } catch {
      setCastDevices([])
    }
    setScanning(false)
  }

  const allowFirewallNow = async () => {
    const result = await window.aiPlayer?.cast?.allowFirewall?.()
    if (result?.success) {
      setCastStatus({ deviceId: '', message: '已放行局域网投屏端口（仅此一次授权，长期有效）' })
    } else {
      setCastStatus({ deviceId: '', message: `放行未完成：${result?.error || '已取消'}（投屏可能因防火墙失败）`, isError: true })
    }
  }

  const doCast = async (deviceId: string) => {
    if (!castFile) return
    const result = await window.aiPlayer?.cast?.cast(deviceId, castFile)
    setCastFile(null)
    setCastDevices([])
    if (result?.success) {
      setCastStatus({ deviceId, message: result.action || '已投屏' })
      // 投屏后拉一次设备真实状态（播放中/已停止），别猜
      window.setTimeout(() => void refreshCastState(deviceId), 3000)
    } else {
      setCastStatus({ deviceId: '', message: result?.error || result?.action || '投屏失败', isError: true })
    }
  }

  const refreshCastState = async (deviceId: string) => {
    const status = await window.aiPlayer?.cast?.status(deviceId)
    if (status?.success) {
      setCastStatus((current) => (current && current.deviceId === deviceId ? { ...current, stateLabel: status.label } : current))
    }
  }

  const pauseCastNow = async () => {
    if (!castStatus?.deviceId) return
    const result = await window.aiPlayer?.cast?.pause(castStatus.deviceId)
    if (result) setCastStatus({ ...castStatus, message: result.action || castStatus.message })
    void refreshCastState(castStatus.deviceId)
  }

  const resumeCastNow = async () => {
    if (!castStatus?.deviceId) return
    const result = await window.aiPlayer?.cast?.resume(castStatus.deviceId)
    if (result) setCastStatus({ ...castStatus, message: result.action || castStatus.message })
    void refreshCastState(castStatus.deviceId)
  }

  const stopCastNow = async () => {
    if (castStatus?.deviceId) await window.aiPlayer?.cast?.stop(castStatus.deviceId)
    setCastStatus(null)
  }

  const removeNetworkSource = (url: string) => {
    const next = networkSources.filter((u) => u !== url)
    setNetworkSources(next)
    localStorage.setItem('networkSources', JSON.stringify(next))
  }

  const isDesktop = window.aiPlayer?.isElectron === true

  const enableWifi = async () => {
    const url = await window.aiPlayer?.wifi?.url()
    setWifiUrl(url || null)
    setWifiPin(url ? await window.aiPlayer?.wifi?.pin() || null : null)
  }

  const disableWifi = async () => {
    await window.aiPlayer?.wifi?.stop()
    setWifiUrl(null)
    setWifiPin(null)
  }

  const enableSync = async () => setSyncUrl(await window.aiPlayer?.sync?.url() || null)
  const disableSync = async () => { await window.aiPlayer?.sync?.stop(); setSyncUrl(null) }
  const enableDlnaServer = async () => setDlnaServerUrl(await window.aiPlayer?.dlna?.serverUrl() || null)
  const disableDlnaServer = async () => { await window.aiPlayer?.dlna?.stopServer(); setDlnaServerUrl(null) }
  const toggleReceiver = async () => {
    if (!window.aiPlayer?.receiver) return
    if (receiverEnabled) {
      await window.aiPlayer.receiver.stop()
      setReceiverEnabled(false)
    } else {
      setReceiverEnabled(Boolean(await window.aiPlayer.receiver.start()))
    }
  }

  useEffect(() => {
    if (!isDesktop || !window.aiPlayer?.media) return
    setLoading(true)
    window.aiPlayer.media
      .analyze(rootDir)
      .then((result) => {
        setFiles(result.files)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [isDesktop, rootDir])

  useEffect(() => {
    if (!dedupRequestId) return
    return window.aiPlayer?.media?.onDedupProgress((progress) => {
      if (progress.requestId !== dedupRequestId) return
      if (progress.phase === 'scanning') {
        setDedupStatus(`正在扫描媒体库 · 已发现 ${progress.filesScanned || 0} 个媒体文件`)
      } else if (progress.phase === 'hashing') {
        const total = progress.totalFiles || 0
        const done = progress.processedFiles || 0
        setDedupStatus(total > 0 ? `正在核对文件内容 ${done}/${total}` : '正在筛选可能重复的文件')
      }
    })
  }, [dedupRequestId])

  useEffect(() => {
    const handler = (event: Event) => {
      const action = (event as CustomEvent<string>).detail
      if (action === 'network-source') setShowAddUrl(true)
      else if (action === 'record') setRecordTrigger((value) => value + 1)
      else if (action === 'dedup') void handleDedup()
      else if (action === 'organize') void handleSuggest()
      else if (action === 'plugins') void handlePlugins()
      else if (action === 'poster') void handleMetadata()
      else if (action === 'devices') setShowMore(true)
    }
    window.addEventListener('ai-player-action', handler)
    return () => window.removeEventListener('ai-player-action', handler)
  })

  useEffect(() => {
    const action = actionRequest?.action
    if (action === 'network-source') setShowAddUrl(true)
    else if (action === 'record') setRecordTrigger((value) => value + 1)
    else if (action === 'dedup') void handleDedup()
    else if (action === 'organize') void handleSuggest()
    else if (action === 'plugins') void handlePlugins()
    else if (action === 'poster') void handleMetadata()
    else if (action === 'devices') setShowMore(true)
  }, [actionRequest?.id])

  const allTags = [...new Set(files.flatMap((f) => f.tags || []))]
  const filtered = (activeTag ? files.filter((f) => f.tags?.includes(activeTag)) : files).filter(
    (f) => (query ? f.name.toLowerCase().includes(query.toLowerCase()) : true)
  )

  const PRINTABLE = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.pdf', '.srt', '.ass', '.vtt', '.txt', '.md', '.doc', '.docx', '.rtf', '.odt', '.xls', '.xlsx', '.csv', '.ods', '.ppt', '.pptx', '.odp', '.html', '.htm']
  const isPrintable = (ext: string) => PRINTABLE.includes(ext)
  const handlePrint = async (e: React.MouseEvent, path: string, ext: string) => {
    e.stopPropagation()
    const result = ['.txt', '.md', '.srt', '.ass', '.vtt'].includes(ext)
      ? await window.aiPlayer?.print?.text(path)
      : await window.aiPlayer?.print?.file(path)
    if (result && result.success === false) setCastStatus({ deviceId: '', message: result.error || '打印失败', isError: true })
  }

  const fmtSize = (b: number) => {
    if (b > 1e9) return (b / 1e9).toFixed(1) + 'GB'
    if (b > 1e6) return (b / 1e6).toFixed(0) + 'MB'
    return ''
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (!file) return
    if (isDesktop) {
      onPlay(file.name, (file as File & { path: string }).path)
    } else if (file.type.startsWith('video')) {
      onPlay(file.name, URL.createObjectURL(file))
    }
  }

  return (
    <div className="relative flex-1 flex flex-col" onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}>
      <div className="flex items-center gap-3 px-6 py-4">
        <button
          onClick={openPanel}
          className="w-10 h-10 flex items-center justify-center rounded-full bg-player-accent/80 hover:bg-player-accent text-lg"
        >
          🎙️
        </button>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='搜索或说"放谍战剧"…'
          className="flex-1 bg-player-surface rounded-xl px-4 py-3 text-sm outline-none focus:ring-1 ring-player-accent"
        />
      </div>
      <Recorder trigger={recordTrigger} hidden />
      {showAddUrl && (
        <div className="flex items-center gap-2 px-6 pb-2">
          <input
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addNetworkSource()}
            placeholder="smb:// 或 webdav:// 或 https:// URL"
            className="flex-1 bg-player-surface rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 ring-player-accent"
          />
          <button onClick={addNetworkSource} className="px-3 py-2 bg-player-accent rounded-lg text-sm">
            添加
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-6 pb-6">
        {metadataStatus && <p className="text-xs text-gray-400 mb-3">{metadataStatus}</p>}
        {dedupStatus && (
          <div className="mb-3 flex items-center justify-between gap-3 rounded-lg bg-player-surface px-4 py-3 text-xs text-gray-400">
            <span>{dedupStatus}</span>
            {dedupRequestId && <button type="button" onClick={() => void cancelDedup()} className="rounded-lg bg-red-500/15 px-3 py-1.5 text-red-300 hover:bg-red-500/25">停止扫描</button>}
          </div>
        )}
        {dedupResults && dedupResults.length > 0 && (
          <div className="mb-6 bg-player-surface rounded-lg p-4">
            <p className="text-sm">🔍 去重结果（{dedupResults.length} 组重复）</p>
            {dedupResults.map((d, i) => (
              <p key={i} className="text-xs text-gray-500 mt-1">{d.name}</p>
            ))}
          </div>
        )}
        {suggestResults && suggestResults.length > 0 && (
          <div className="mb-6 bg-player-surface rounded-lg p-4">
            <p className="text-sm">🎬 素材整理建议</p>
            {suggestResults.map((s, i) => (
              <p key={i} className="text-xs text-gray-500 mt-1">{s.suggestion}</p>
            ))}
          </div>
        )}
        {plugins && (
          <div className="mb-6 bg-player-surface rounded-lg p-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="mr-auto text-sm">🧩 插件与 Skill（{plugins.length}）</p>
              <button onClick={() => void installPlugin()} className="rounded bg-player-accent px-2 py-1 text-xs text-white">安装插件包</button>
              <button onClick={() => void window.aiPlayer?.plugin?.openFolder()} className="text-xs text-player-accent">打开插件目录</button>
            </div>
            <p className="mt-2 text-[11px] leading-5 text-gray-500">只加载声明式清单和 SKILL.md；不执行第三方 JavaScript、Python 或 DLL。新插件默认禁用，权限变化后自动撤销启用。</p>
            {pluginStatus && <p className="mt-2 text-xs text-amber-300">{pluginStatus}</p>}
            {plugins.length === 0 ? (
              <p className="mt-2 text-xs text-gray-500">还没有插件。选择含 agentplay-plugin.json 的文件夹安装。</p>
            ) : (
              <div className="mt-3 space-y-2">{plugins.map((plugin) => (
                <div key={plugin.id} className="rounded-lg border border-white/10 bg-black/10 p-3">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-gray-200">{plugin.name} <span className="text-gray-500">{plugin.version}</span></p>
                      <p className="mt-1 text-[11px] text-gray-500">{plugin.description || plugin.file}</p>
                      <p className="mt-1 text-[10px] text-gray-600">Skill {plugin.skillCount} · 工具 {plugin.toolCount} · 权限 {plugin.permissions.join('、') || '无'}</p>
                    </div>
                    {plugin.kind === 'legacy-js' || !plugin.valid ? (
                      <span className="rounded bg-red-500/10 px-2 py-1 text-[10px] text-red-300">已隔离停用</span>
                    ) : (
                      <button onClick={() => void togglePlugin(plugin)} className={`rounded px-2 py-1 text-[10px] ${plugin.enabled ? 'bg-emerald-500/15 text-emerald-200' : 'bg-white/10 text-gray-300'}`}>{plugin.enabled ? '已启用' : '启用'}</button>
                    )}
                  </div>
                  {plugin.error && <p className="mt-2 text-[10px] leading-4 text-red-300">{plugin.error}</p>}
                  {plugin.kind === 'declarative' && <button onClick={() => void removePlugin(plugin)} className="mt-2 text-[10px] text-gray-500 hover:text-red-300">移入回收目录</button>}
                </div>
              ))}</div>
            )}
          </div>
        )}
        {showMore && !showAdvanced && (
          <button onClick={() => setShowAdvanced(true)} className="mb-6 rounded-lg border border-white/10 px-3 py-2 text-xs text-gray-400 hover:border-player-accent hover:text-gray-200">
            ⚙ 高级设备功能（WiFi 传文件 · 互投 · 同步 · DLNA）▸
          </button>
        )}
        {showMore && showAdvanced && (
          <div className="mb-6 bg-player-surface rounded-lg p-4">
            <p className="text-sm">📱 WiFi 传文件</p>
            {wifiUrl ? <>
              <p className="text-xs text-gray-500 mt-1">手机浏览器访问：{wifiUrl}</p>
              <p className="text-xs text-gray-500">配对 PIN：{wifiPin || '...'}</p>
              <button onClick={() => void disableWifi()} className="mt-2 px-3 py-1 bg-white/10 rounded text-xs">停止共享</button>
                    
            </> : <button onClick={() => void enableWifi()} className="mt-2 px-3 py-1 bg-player-accent rounded text-xs">启用 WiFi 传文件</button>}
          </div>
        )}
        {castStatus && (
                      <div className="mb-6 bg-player-surface rounded-lg p-4 flex items-center gap-2">
                        <p className={castStatus.isError ? 'flex-1 text-xs text-red-300' : 'flex-1 text-xs text-emerald-300'}>{castStatus.message}{castStatus.stateLabel ? `（${castStatus.stateLabel}）` : ''}</p>
                        {castStatus.needFirewall && <button onClick={() => void allowFirewallNow()} className="px-3 py-1 bg-player-accent rounded text-xs text-white">现在放行</button>}
                        {castStatus.deviceId && <button onClick={() => void pauseCastNow()} className="px-3 py-1 bg-white/10 rounded text-xs">暂停</button>}
                        {castStatus.deviceId && <button onClick={() => void resumeCastNow()} className="px-3 py-1 bg-white/10 rounded text-xs">继续</button>}
                        {castStatus.deviceId && <button onClick={() => void stopCastNow()} className="px-3 py-1 bg-white/10 rounded text-xs">停止投屏</button>}
                        <button onClick={() => setCastStatus(null)} className="px-2 py-1 text-gray-500 text-xs">✕</button>
                      </div>
                    )}
                  {showMore && showAdvanced && (
          <div className="mb-6 bg-player-surface rounded-lg p-4">
                      <p className="text-sm">🖥️ AgentPlay 互投（屏幕镜像）</p>
                      {mirrorRecv ? (
                        <div className="mt-1">
                          <p className="text-xs text-emerald-300">接收中 · PIN <span className="font-mono text-base tracking-widest">{mirrorRecv.pin}</span>（镜像窗已打开，等对方投过来）</p>
                          <button onClick={() => void stopMirrorRecv()} className="mt-2 px-3 py-1 bg-white/10 rounded text-xs">停止接收</button>
                        </div>
                      ) : (
                        <button onClick={() => void startMirrorRecv()} className="mt-2 px-3 py-1 bg-player-accent rounded text-xs">开启接收（显示 PIN）</button>
                      )}
                      {mirrorSending ? (
                        <div className="mt-2">
                          <p className="text-xs text-emerald-300">正在投屏到 {mirrorSending.host}:{mirrorSending.port}</p>
                          <button onClick={() => void stopMirrorSend()} className="mt-2 px-3 py-1 bg-white/10 rounded text-xs">停止投屏</button>
                        </div>
                      ) : (
                        <div className="mt-2">
                          <button onClick={() => void scanMirrorDevices()} className="px-3 py-1 bg-white/10 rounded text-xs">{mirrorScanning ? '扫描中…' : '扫描互投设备'}</button>
                          {mirrorDevices.map((d) => (
                            <div key={d.host + ':' + d.port} className="mt-2 flex items-center gap-2 text-xs">
                              <span className="flex-1 truncate">{d.name}（{d.host}:{d.port}）</span>
                              <input value={mirrorPin} onChange={(e) => setMirrorPin(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="PIN" className="w-16 bg-black/30 rounded px-2 py-1 text-center font-mono" />
                              <button onClick={() => void startMirrorSend(d)} className="px-3 py-1 bg-player-accent rounded">投屏</button>
                            </div>
                          ))}
                          {mirrorDevices.length === 0 && !mirrorScanning && <p className="mt-2 text-xs text-gray-500">未发现：先在另一台电脑开启接收</p>}
                        </div>
                      )}
                      {mirrorError && <p className="text-xs text-red-300 mt-2">{mirrorError}</p>}
                    </div>
        )}
        {showMore && showAdvanced && (
          <div className="mb-6 bg-player-surface rounded-lg p-4">
            <p className="text-sm">🔄 跨设备同步</p>
            {syncUrl ? <>
              <p className="text-xs text-gray-500 mt-1">本机：{syncUrl}</p>
              <div className="flex items-center gap-2 mt-2">
              <input
                type="text"
                value={peerUrl}
                onChange={(e) => setPeerUrl(e.target.value)}
                placeholder="对端 URL（http://192.168.1.50:18902）"
                className="flex-1 bg-black/40 rounded px-2 py-1 text-xs outline-none focus:ring-1 ring-player-accent"
              />
              <button onClick={() => handleSync('download')} className="px-2 py-1 bg-player-accent rounded text-xs">拉取</button>
              <button onClick={() => handleSync('upload')} className="px-2 py-1 bg-player-accent rounded text-xs">推送</button>
              </div>
              <button onClick={() => void disableSync()} className="mt-2 px-3 py-1 bg-white/10 rounded text-xs">停止同步服务</button>
              {syncStatus && <p className="text-xs text-gray-500 mt-1">{syncStatus}</p>}
            </> : <button onClick={() => void enableSync()} className="mt-2 px-3 py-1 bg-player-accent rounded text-xs">启用跨设备同步</button>}
          </div>
        )}
        {showMore && showAdvanced && (
          <div className="mb-6 bg-player-surface rounded-lg p-4">
            <p className="text-sm">📺 DLNA 共享与接收</p>
            {dlnaServerUrl ? <>
              <p className="text-xs text-gray-500 mt-1">媒体库地址：{dlnaServerUrl}</p>
              <button onClick={() => void disableDlnaServer()} className="mt-2 px-3 py-1 bg-white/10 rounded text-xs">停止共享媒体库</button>
            </> : <button onClick={() => void enableDlnaServer()} className="mt-2 px-3 py-1 bg-player-accent rounded text-xs">启用媒体库共享</button>}
            <button onClick={() => void toggleReceiver()} className={`mt-2 ml-2 px-3 py-1 rounded text-xs ${receiverEnabled ? 'bg-red-700' : 'bg-player-accent'}`}>
              {receiverEnabled ? '停止接收投屏' : '启用接收投屏'}
            </button>
          </div>
        )}
        {showMore && networkSources.length > 0 && (
          <div className="mb-6">
            <h2 className="text-gray-400 text-sm mb-3">网络源（{networkSources.length}）</h2>
            <div className="space-y-2">
              {networkSources.map((url) => {
                const name = url.split('/').pop() || url
                return (
                  <div
                    key={url}
                    className="flex items-center gap-2 bg-player-surface rounded-lg px-3 py-2"
                  >
                    <button
                      onClick={() => onPlay(name, url)}
                      className="flex-1 text-left text-sm hover:text-player-accent truncate"
                    >
                      🌐 {name}
                    </button>
                    <button
                      onClick={() => removeNetworkSource(url)}
                      className="text-gray-500 hover:text-red-400 text-sm"
                    >
                      ✕
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}
        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-4">
            <button
              onClick={() => setActiveTag(null)}
              className={`px-2 py-1 rounded text-xs ${!activeTag ? 'bg-player-accent' : 'bg-player-surface'}`}
            >
              全部
            </button>
            {allTags.slice(0, 12).map((tag) => (
              <button
                key={tag}
                onClick={() => setActiveTag(tag)}
                className={`px-2 py-1 rounded text-xs ${activeTag === tag ? 'bg-player-accent' : 'bg-player-surface'}`}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
        <h2 className="text-gray-400 text-sm mb-3">
          {isDesktop ? `媒体库（${files.length}）` : '媒体库（Web 端示例）'}
        </h2>
        {loading ? (
          <p className="text-gray-500 text-sm">扫描中…</p>
        ) : filtered.length === 0 ? (
          <div className="min-h-[280px] rounded-2xl border border-dashed border-white/15 bg-white/[0.02] flex flex-col items-center justify-center text-center px-6">
            <div className="text-4xl mb-4">🎞️</div>
            <p className="text-gray-300 text-base mb-2">这里还没有媒体文件</p>
            <p className="text-gray-500 text-sm mb-5">拖入文件，或点上方「打开」选择文件/文件夹</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {filtered.map((f) => (
              <div
                key={f.path}
                onClick={() => onPlay(f.name, f.path)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  setMenu({ x: event.clientX, y: event.clientY, file: f })
                }}
                className="relative aspect-[2/3] bg-player-surface rounded-lg flex flex-col items-end justify-between p-3 hover:ring-2 ring-player-accent transition-all cursor-pointer"
              >
                {posters[f.path]?.poster && (
                  <>
                    <img src={posters[f.path].poster || ''} alt="" className="absolute inset-0 w-full h-full object-cover rounded-lg" />
                    <div className="absolute inset-0 rounded-lg bg-gradient-to-t from-black via-black/10 to-black/40" />
                  </>
                )}
                {isPrintable(f.ext) && (
                  <button
                    onClick={(e) => handlePrint(e, f.path, f.ext)}
                    className="absolute top-2 right-2 w-7 h-7 flex items-center justify-center rounded bg-black/50 hover:bg-black/70 text-sm"
                  >
                    🖨️
                  </button>
                )}
                {mediaFormats.video.includes(f.ext.toLowerCase()) && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleCast(f.path)
                    }}
                    className="absolute top-2 left-2 w-7 h-7 flex items-center justify-center rounded bg-black/50 hover:bg-black/70 text-sm"
                  >
                    📺
                  </button>
                )}
                <button
                  title={favorites.includes(f.path) ? '取消收藏' : '收藏'}
                  onClick={(event) => {
                    event.stopPropagation()
                    toggleFavorite(f.path)
                  }}
                  className="absolute bottom-2 left-2 w-7 h-7 flex items-center justify-center rounded bg-black/50 hover:bg-black/70 text-sm"
                >{favorites.includes(f.path) ? '★' : '☆'}</button>
                <span className="relative text-xs text-gray-300 self-start">
                  {f.ext.slice(1).toUpperCase()}
                </span>
                <span className="relative text-sm text-left break-all line-clamp-3">
                  {posters[f.path]?.title || f.name}
                </span>
                <span className="relative text-xs text-gray-300">{posters[f.path]?.year || fmtSize(f.size)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {menu && (
        <div className="fixed inset-0 z-[70]" onClick={() => setMenu(null)} onContextMenu={(event) => { event.preventDefault(); setMenu(null) }}>
          <div
            className="absolute min-w-44 rounded-lg border border-white/10 theme-panel py-1 shadow-2xl"
            style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - 150) }}
            onClick={(event) => event.stopPropagation()}
          >
            <button className="block w-full px-4 py-2 text-left text-sm text-gray-200 hover:bg-white/10" onClick={() => { onPlay(menu.file.name, menu.file.path); setMenu(null) }}>打开</button>
            <button className="block w-full px-4 py-2 text-left text-sm text-gray-200 hover:bg-white/10" onClick={() => {
              const cut = Math.max(menu.file.path.lastIndexOf('\\'), menu.file.path.lastIndexOf('/'))
              void window.aiPlayer?.system?.openPath(cut > 0 ? menu.file.path.slice(0, cut) : menu.file.path)
              setMenu(null)
            }}>打开所在文件夹</button>
            {isPrintable(menu.file.ext) && (
              <button className="block w-full px-4 py-2 text-left text-sm text-gray-200 hover:bg-white/10" onClick={(event) => { handlePrint(event as unknown as React.MouseEvent, menu.file.path, menu.file.ext); setMenu(null) }}>打印</button>
            )}
            {['.txt', '.md', '.csv', '.json', '.srt', '.vtt', '.doc', '.docx', '.xlsx', '.pptx', '.pdf', '.odt', '.ods', '.odp', '.rtf', '.html', '.htm'].includes(menu.file.ext) && (
              <button className="block w-full px-4 py-2 text-left text-sm text-blue-300 hover:bg-white/10" onClick={async () => {
                const result = await window.aiPlayer?.chat?.attachPaths([menu.file.path])
                setMenu(null)
                if (result?.documents?.length) {
                  window.dispatchEvent(new CustomEvent('ai-player-attach-docs', { detail: result.documents }))
                }
              }}>用 AgentPlay 智能处理</button>
            )}
          </div>
        </div>
      )}
      {castFile && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => {
            setCastFile(null)
            setCastDevices([])
          }}
        >
          <div
            className="bg-player-surface rounded-xl p-5 min-w-[300px]"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm mb-3">{scanning ? '扫描设备中…' : '选择投屏设备'}</p>
            {castDevices.length === 0 && !scanning && (
              <p className="text-gray-500 text-sm">未发现 DLNA 设备：确认电视/盒子与本机在同一 WiFi，且电视投屏功能已打开（部分电视需在设置里启用 DLNA/多屏互动）</p>
            )}
            {castDevices.map((d) => (
              <button
                key={d.id}
                onClick={() => doCast(d.id)}
                className="block w-full text-left px-3 py-2 rounded hover:bg-white/10 text-sm"
              >
                📺 {d.name}{d.lastSuccess ? <span className="ml-2 text-xs text-emerald-300">上次成功</span> : null}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
