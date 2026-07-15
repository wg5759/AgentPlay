import React, { useEffect, useState } from 'react'
import { useAgentStore } from '../stores/agentStore'
import Recorder from './Recorder'

interface MediaFile {
  name: string
  path: string
  ext: string
  size: number
}

interface Props {
  onPlay: (name: string, path: string) => void
}

export default function MediaLibrary({ onPlay }: Props) {
  const openPanel = useAgentStore((s) => s.openPanel)
  const [files, setFiles] = useState<MediaFile[]>([])
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
  const [peerUrl, setPeerUrl] = useState('')
  const [syncStatus, setSyncStatus] = useState('')
  const [urlInput, setUrlInput] = useState('')
  const [showMore, setShowMore] = useState(false)

  const addNetworkSource = () => {
    const url = urlInput.trim()
    if (!url) return
    const next = [...networkSources, url]
    setNetworkSources(next)
    localStorage.setItem('networkSources', JSON.stringify(next))
    setUrlInput('')
    setShowAddUrl(false)
  }

  const handleSync = async (action: 'upload' | 'download') => {
    if (!window.aiPlayer?.sync) return
    if (peerUrl) await window.aiPlayer.sync.setPeer(peerUrl)
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

  useEffect(() => {
    if (isDesktop && window.aiPlayer?.wifi) {
      window.aiPlayer.wifi.url().then(setWifiUrl)
      window.aiPlayer.wifi.pin().then(setWifiPin)
    }
    if (isDesktop && window.aiPlayer?.sync) {
      window.aiPlayer.sync.url().then(setSyncUrl)
    }
  }, [])

  useEffect(() => {
    if (!isDesktop || !window.aiPlayer?.files) return
    setLoading(true)
    window.aiPlayer.files
      .scan()
      .then((result) => {
        setFiles(result)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const filtered = query
    ? files.filter((f) => f.name.toLowerCase().includes(query.toLowerCase()))
    : files

  const PRINTABLE = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.pdf']
  const isPrintable = (ext: string) => PRINTABLE.includes(ext)
  const handlePrint = (e: React.MouseEvent, path: string) => {
    e.stopPropagation()
    window.aiPlayer?.print?.file(path)
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
          className="flex-1 max-w-md bg-player-surface rounded-lg px-4 py-2 text-sm outline-none focus:ring-1 ring-player-accent"
        />
        <button
          onClick={() => setShowAddUrl(!showAddUrl)}
          className="px-3 py-2 bg-player-surface rounded-lg text-sm hover:ring-1 ring-player-accent"
        >
          + 网络源
        </button>
        <Recorder />
        <button
          onClick={() => setShowMore(!showMore)}
          className="px-3 py-2 bg-player-surface rounded-lg text-sm hover:ring-1 ring-player-accent"
        >
          {showMore ? '收起' : '更多'}
        </button>
      </div>
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
        {showMore && wifiUrl && (
          <div className="mb-6 bg-player-surface rounded-lg p-4">
            <p className="text-sm">📱 WiFi 传文件</p>
            <p className="text-xs text-gray-500 mt-1">手机浏览器访问：{wifiUrl}</p>
            <p className="text-xs text-gray-500">配对 PIN：{wifiPin || '...'}</p>
          </div>
        )}
        {showMore && syncUrl && (
          <div className="mb-6 bg-player-surface rounded-lg p-4">
            <p className="text-sm">🔄 跨设备同步</p>
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
            {syncStatus && <p className="text-xs text-gray-500 mt-1">{syncStatus}</p>}
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
        <h2 className="text-gray-400 text-sm mb-3">
          {isDesktop ? `媒体库（${files.length}）` : '媒体库（Web 端示例）'}
        </h2>
        {loading ? (
          <p className="text-gray-500 text-sm">扫描中…</p>
        ) : filtered.length === 0 ? (
          <p className="text-gray-600 text-sm">
            {isDesktop
              ? '未找到视频文件，可拖拽文件到播放区'
              : 'Web 端请拖拽视频文件到播放区'}
          </p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {filtered.map((f) => (
              <div
                key={f.path}
                onClick={() => onPlay(f.name, f.path)}
                className="relative aspect-[2/3] bg-player-surface rounded-lg flex flex-col items-end justify-between p-3 hover:ring-2 ring-player-accent transition-all cursor-pointer"
              >
                {isPrintable(f.ext) && (
                  <button
                    onClick={(e) => handlePrint(e, f.path)}
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
                <span className="text-xs text-gray-500 self-start">
                  {f.ext.slice(1).toUpperCase()}
                </span>
                <span className="text-sm text-left break-all line-clamp-3">
                  {f.name}
                </span>
                <span className="text-xs text-gray-600">{fmtSize(f.size)}</span>
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
