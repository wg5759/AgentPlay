import React, { useEffect, useState } from 'react'
import { useAgentStore } from '../stores/agentStore'
import Recorder from './Recorder'
import { usePlayerStore } from '../stores/playerStore'

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
}

export default function MediaLibrary({ onPlay, rootDir }: Props) {
  const openPanel = useAgentStore((s) => s.openPanel)
  const [files, setFiles] = useState<MediaFile[]>([])
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [dedupResults, setDedupResults] = useState<Array<{ original: string; duplicate: string; name: string }> | null>(null)
  const [suggestResults, setSuggestResults] = useState<Array<{ tag: string; count: number; suggestion: string }> | null>(null)
  const [plugins, setPlugins] = useState<Array<{ name: string; version?: string; description?: string }> | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [networkSources, setNetworkSources] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('networkSources') || '[]')
    } catch {
      return []
    }
  })
  const [showAddUrl, setShowAddUrl] = useState(false)
  const [wifiUrl, setWifiUrl] = useState<string | null>(null)
  const [wifiPin, setWifiPin] = useState<string | null>(null)
  const [castDevices, setCastDevices] = useState<Array<{ id: string; name: string }>>([])
  const [castFile, setCastFile] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [syncUrl, setSyncUrl] = useState<string | null>(null)
  const [dlnaServerUrl, setDlnaServerUrl] = useState<string | null>(null)
  const [receiverEnabled, setReceiverEnabled] = useState(false)
  const [peerUrl, setPeerUrl] = useState('')
  const [syncStatus, setSyncStatus] = useState('')
  const [urlInput, setUrlInput] = useState('')
  const [showMore, setShowMore] = useState(false)
  const [posters, setPosters] = useState<Record<string, { poster: string | null; title: string; overview: string; year: string | null }>>(() => {
    try { return JSON.parse(localStorage.getItem('aiplayer_metadata_cache') || '{}') } catch { return {} }
  })
  const [metadataStatus, setMetadataStatus] = useState('')
  const [recordTrigger, setRecordTrigger] = useState(0)
  const recentMedia = usePlayerStore((state) => state.recentMedia)
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
    const r = await window.aiPlayer?.media?.dedup()
    setDedupResults(r || [])
    setShowMore(true)
  }
  const handleSuggest = async () => {
    const r = await window.aiPlayer?.media?.suggest()
    setSuggestResults(r || [])
    setShowMore(true)
  }
  const handlePlugins = async () => {
    const r = await window.aiPlayer?.plugin?.list()
    setPlugins(r || [])
    setShowMore(true)
  }

  const handleMetadata = async () => {
    const apiKey = localStorage.getItem('aiplayer_tmdb_key') || ''
    if (!apiKey) {
      setMetadataStatus('请先在 Agent 配置里填写 TMDB key')
      return
    }
    const videos = files.filter((f) => ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v', '.wmv'].includes(f.ext)).slice(0, 30)
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
        const result = await window.aiPlayer?.tmdb?.search(query, apiKey)
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
    try {
      const devices = await window.aiPlayer?.cast?.scan()
      setCastDevices(devices || [])
    } catch {
      setCastDevices([])
    }
    setScanning(false)
  }

  const doCast = async (deviceId: string) => {
    if (!castFile) return
    await window.aiPlayer?.cast?.cast(deviceId, castFile)
    setCastFile(null)
    setCastDevices([])
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

  const allTags = [...new Set(files.flatMap((f) => f.tags || []))]
  const filtered = (activeTag ? files.filter((f) => f.tags?.includes(activeTag)) : files).filter(
    (f) => (query ? f.name.toLowerCase().includes(query.toLowerCase()) : true)
  )

  const PRINTABLE = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.pdf', '.srt', '.ass', '.vtt', '.txt', '.md']
  const isPrintable = (ext: string) => PRINTABLE.includes(ext)
  const handlePrint = (e: React.MouseEvent, path: string, ext: string) => {
    e.stopPropagation()
    if (['.txt', '.md', '.srt', '.ass', '.vtt'].includes(ext)) {
      window.aiPlayer?.print?.text(path)
    } else {
      window.aiPlayer?.print?.file(path)
    }
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
    <div className="flex-1 flex flex-col" onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}>
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
            <p className="text-sm">🧩 插件（{plugins.length}）</p>
            <button onClick={() => void window.aiPlayer?.plugin?.openFolder()} className="text-xs text-player-accent mt-1">打开插件目录</button>
            {plugins.length === 0 ? (
              <p className="text-xs text-gray-500 mt-1">将插件放入 ~/.ai-player/plugins/</p>
            ) : (
              plugins.map((p, i) => (
                <p key={i} className="text-xs text-gray-500 mt-1">{p.name} {p.version}</p>
              ))
            )}
          </div>
        )}
        {showMore && (
          <div className="mb-6 bg-player-surface rounded-lg p-4">
            <p className="text-sm">📱 WiFi 传文件</p>
            {wifiUrl ? <>
              <p className="text-xs text-gray-500 mt-1">手机浏览器访问：{wifiUrl}</p>
              <p className="text-xs text-gray-500">配对 PIN：{wifiPin || '...'}</p>
              <button onClick={() => void disableWifi()} className="mt-2 px-3 py-1 bg-white/10 rounded text-xs">停止共享</button>
            </> : <button onClick={() => void enableWifi()} className="mt-2 px-3 py-1 bg-player-accent rounded text-xs">启用 WiFi 传文件</button>}
          </div>
        )}
        {showMore && (
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
        {showMore && (
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
        {recentMedia.length > 0 && !query && !activeTag && (
          <div className="mb-6">
            <h2 className="text-gray-400 text-sm mb-3">最近播放</h2>
            <div className="flex gap-3 overflow-x-auto pb-1">
              {recentMedia.slice(0, 8).map((item) => (
                <button key={item.src} onClick={() => onPlay(item.name, item.src)} className="min-w-[180px] max-w-[240px] bg-player-surface rounded-xl px-4 py-3 text-left hover:ring-1 ring-player-accent">
                  <span className="block text-sm truncate">▶ {item.name}</span>
                  <span className="block text-[11px] text-gray-600 mt-1">{new Date(item.openedAt).toLocaleString()}</span>
                </button>
              ))}
            </div>
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
            <p className="text-gray-500 text-sm mb-5">拖入文件，或从“文件”菜单打开文件 / 文件夹</p>
            <div className="flex gap-3">
              <button
                onClick={async () => {
                  const path = await window.aiPlayer?.dialog?.openFile()
                  if (path) onPlay(path.split(/[\\/]/).pop() || path, path)
                }}
                className="px-4 py-2 rounded-lg bg-player-accent text-sm"
              >打开文件</button>
              <button
                onClick={async () => {
                  const path = await window.aiPlayer?.dialog?.openFolder()
                  if (path) window.dispatchEvent(new CustomEvent('ai-player-open-folder', { detail: path }))
                }}
                className="px-4 py-2 rounded-lg bg-player-surface text-sm hover:bg-white/10"
              >打开文件夹</button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {filtered.map((f) => (
              <div
                key={f.path}
                onClick={() => onPlay(f.name, f.path)}
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
                {['.mp4', '.mkv', '.avi', '.mov', '.webm', '.ts', '.m4v', '.wmv'].includes(f.ext) && (
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
              <p className="text-gray-500 text-sm">未发现 DLNA 设备</p>
            )}
            {castDevices.map((d) => (
              <button
                key={d.id}
                onClick={() => doCast(d.id)}
                className="block w-full text-left px-3 py-2 rounded hover:bg-white/10 text-sm"
              >
                📺 {d.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
