import { useEffect, useRef, useState } from 'react'
import PlayerControls from './PlayerControls'
import { usePlayerStore } from '../stores/playerStore'

interface Props {
  onBack: () => void
}

const VIDEO_EXTS = ['.mp4', '.mkv', '.avi', '.mov', '.flv', '.webm', '.ts', '.m4v', '.wmv']
const AUDIO_EXTS = ['.mp3', '.flac', '.wav', '.aac', '.m4a', '.ogg']
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.svg']
const TEXT_EXTS = ['.txt', '.md', '.json', '.csv', '.xml', '.html', '.css', '.js', '.ts', '.py', '.java', '.c', '.cpp', '.sh', '.yml', '.yaml', '.ini', '.log', '.sql']
const OFFICE_EXTS = ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx']

function getFileType(name?: string | null): string {
  if (!name) return 'none'
  const ext = ('.' + (name.split('.').pop() || '')).toLowerCase()
  if (VIDEO_EXTS.includes(ext)) return 'video'
  if (AUDIO_EXTS.includes(ext)) return 'audio'
  if (IMAGE_EXTS.includes(ext)) return 'image'
  if (ext === '.pdf') return 'pdf'
  if (TEXT_EXTS.includes(ext)) return 'text'
  if (OFFICE_EXTS.includes(ext)) return 'office'
  return 'other'
}

export default function PlayerView({ onBack }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const mediaName = usePlayerStore((s) => s.mediaName)
  const videoSrc = usePlayerStore((s) => s.videoSrc)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const volume = usePlayerStore((s) => s.volume)
  const currentTime = usePlayerStore((s) => s.currentTime)
  const setControlsVisible = usePlayerStore((s) => s.setControlsVisible)
  const controlsVisible = usePlayerStore((s) => s.controlsVisible)
  const setDuration = usePlayerStore((s) => s.setDuration)
  const seek = usePlayerStore((s) => s.seek)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [officeHtml, setOfficeHtml] = useState<string | null>(null)
  const [subtitleUrl, setSubtitleUrl] = useState<string | null>(null)

  const isDesktop = window.aiPlayer?.isElectron === true
  const fileType = getFileType(mediaName)
  const isMedia = fileType === 'video' || fileType === 'audio'

  const fileUrl =
    isDesktop && videoSrc && !videoSrc.startsWith('http') && !videoSrc.startsWith('blob:')
      ? 'file:///' + videoSrc.replace(/\\/g, '/')
      : videoSrc

  useEffect(() => {
    const el = fileType === 'video' ? videoRef.current : fileType === 'audio' ? audioRef.current : null
    if (!el || !fileUrl) return
    if (isPlaying) el.play().catch(() => {})
    else el.pause()
  }, [isPlaying, fileUrl, fileType])

  useEffect(() => {
    const el = fileType === 'video' ? videoRef.current : fileType === 'audio' ? audioRef.current : null
    if (el) el.volume = volume / 100
  }, [volume, fileType])

  useEffect(() => {
    const el = fileType === 'video' ? videoRef.current : fileType === 'audio' ? audioRef.current : null
    if (el && Math.abs(el.currentTime - currentTime) > 1) el.currentTime = currentTime
  }, [currentTime, fileType])

  const handleMouseMove = () => {
    setControlsVisible(true)
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setControlsVisible(false), 3000)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (!file) return
    const ext = (file.name.split('.').pop() || '').toLowerCase()
    if (['srt', 'ass', 'ssa', 'vtt'].includes(ext)) {
      if (isDesktop) {
        setSubtitleUrl('file:///' + (file as File & { path: string }).path.replace(/\\/g, '/'))
      }
      return
    }
    if (isDesktop) {
      usePlayerStore.getState().setMedia(file.name, (file as File & { path: string }).path)
    } else {
      const oldSrc = usePlayerStore.getState().videoSrc
      if (oldSrc && oldSrc.startsWith('blob:')) URL.revokeObjectURL(oldSrc)
      usePlayerStore.getState().setMedia(file.name, URL.createObjectURL(file))
    }
  }

  useEffect(() => {
    if (fileType === 'office' && videoSrc) {
      const ext = ('.' + (mediaName?.split('.').pop() || '')).toLowerCase()
      if (['.doc', '.docx'].includes(ext)) {
        window.aiPlayer?.docx?.preview(videoSrc).then((r) => setOfficeHtml(r?.success ? r.html || null : null))
      } else if (['.xls', '.xlsx'].includes(ext)) {
        window.aiPlayer?.xlsx?.preview(videoSrc).then((r) => setOfficeHtml(r?.success ? r.html || null : null))
      } else {
        setOfficeHtml(null)
      }
    } else {
      setOfficeHtml(null)
    }
  }, [fileType, videoSrc, mediaName])

  useEffect(() => {
    const handler = () => usePlayerStore.setState({ isFullscreen: !!document.fullscreenElement })
    document.addEventListener('fullscreenchange', handler)
    return () => document.removeEventListener('fullscreenchange', handler)
  }, [])

  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current) }, [])

  return (
    <div
      className="flex-1 relative bg-black flex items-center justify-center"
      onMouseMove={handleMouseMove}
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
      onContextMenu={async (e) => {
        e.preventDefault()
        const p = await window.aiPlayer?.dialog?.openFile()
        if (p) usePlayerStore.getState().setMedia(p.split(/[\\/]/).pop() || p, p)
      }}
      onDoubleClick={() => {
        if (fileType === 'office' || fileType === 'other') return
        const s = usePlayerStore.getState()
        s.toggleFullscreen()
        if (document.fullscreenElement) document.exitFullscreen()
        else document.documentElement.requestFullscreen().catch(() => {})
      }}
    >
      {fileType === 'video' && fileUrl && (
        <video
          ref={videoRef}
          src={fileUrl}
          className="max-w-full max-h-full"
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
          onTimeUpdate={(e) => seek(e.currentTarget.currentTime)}
          onEnded={() => usePlayerStore.setState({ isPlaying: false })}
          playsInline
        >
          {subtitleUrl && <track src={subtitleUrl} kind="subtitles" default />}
        </video>
      )}
      {fileType === 'audio' && fileUrl && (
        <div className="text-center">
          <p className="text-5xl mb-4">🎵</p>
          <p className="text-gray-300 mb-4">{mediaName}</p>
          <audio
            ref={audioRef}
            src={fileUrl}
            className="w-96"
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            onTimeUpdate={(e) => seek(e.currentTarget.currentTime)}
            onEnded={() => usePlayerStore.setState({ isPlaying: false })}
          />
        </div>
      )}
      {fileType === 'image' && fileUrl && (
        <img src={fileUrl} alt={mediaName ?? ''} className="max-w-full max-h-full object-contain" />
      )}
      {fileType === 'pdf' && fileUrl && (
        <iframe src={fileUrl} title="pdf" className="w-full h-full bg-white" />
      )}
      {fileType === 'text' && fileUrl && (
        <iframe src={fileUrl} title="text" className="w-full h-full bg-white" />
      )}
      {fileType === 'office' && (
        officeHtml ? (
          <div className="w-full h-full overflow-auto bg-white text-black p-8" dangerouslySetInnerHTML={{ __html: officeHtml }} />
        ) : (
          <div className="text-gray-400 text-center">
            <p className="text-2xl mb-2">{mediaName}</p>
            <p className="text-sm">此 Office 文件暂不支持预览（Word 可预览，Excel/PPT 待做），请右键用系统程序打开</p>
          </div>
        )
      )}
      {fileType === 'none' && (
        <div className="text-gray-600 text-center">
          <p className="text-2xl mb-2">未选择文件</p>
          <p className="text-sm">右键打开文件，或拖拽文件到此处，或从媒体库选择</p>
        </div>
      )}

      <button
        onClick={onBack}
        className={`absolute top-4 left-4 px-3 py-1 bg-player-surface/80 rounded text-sm hover:bg-player-surface transition-opacity duration-300 ${
          controlsVisible || !isMedia ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        ← 媒体库
      </button>

      {isMedia && <PlayerControls />}
    </div>
  )
}
