import { useEffect, useRef } from 'react'
import PlayerControls from './PlayerControls'
import { usePlayerStore } from '../stores/playerStore'

interface Props {
  onBack: () => void
}

export default function PlayerView({ onBack }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const mpvTimeRef = useRef(0) // mpv 最后报告的位置（区分用户拖拽与事件更新）
  const playerAreaRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<() => void>(() => {})
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

  const isDesktop = window.aiPlayer?.isElectron === true
  const player = window.aiPlayer?.player

  // 桌面端：mpv 加载文件
  useEffect(() => {
    if (!isDesktop || !player || !videoSrc) return
    player.showContainer()
    player.loadFile(videoSrc)
    if (isPlaying) player.play()
  }, [videoSrc])

  // 桌面端：离开播放器视图时隐藏 mpv 容器
  useEffect(() => {
    if (!isDesktop || !player) return
    return () => player.hideContainer()
  }, [isDesktop, player])

  // 桌面端：播放/暂停
  useEffect(() => {
    if (!isDesktop || !player) return
    if (isPlaying) player.play()
    else player.pause()
  }, [isPlaying])

  // 桌面端：音量
  useEffect(() => {
    if (!isDesktop || !player) return
    player.setVolume(volume)
  }, [volume])

  // 桌面端：用户拖进度条 -> mpv seek（与 mpvTimeRef 差异>1s 才跳，避免事件循环）
  useEffect(() => {
    if (!isDesktop || !player) return
    if (Math.abs(currentTime - mpvTimeRef.current) > 1) {
      player.seek(currentTime)
      mpvTimeRef.current = currentTime
    }
  }, [currentTime])

  // 桌面端：监听 mpv 事件
  useEffect(() => {
    if (!isDesktop || !player) return
    const off = player.onEvent((evt) => {
      if (evt.event !== 'property' || !evt.data) return
      const { name, data } = evt.data
      if (name === 'time-pos' && typeof data === 'number') {
        mpvTimeRef.current = data
        seek(data)
      } else if (name === 'duration' && typeof data === 'number') {
        setDuration(data)
      } else if (name === 'eof-reached' && data === true) {
        usePlayerStore.setState({ isPlaying: false })
      }
    })
    return off
  }, [])

  // Web 端：HTML5 video 播放/暂停
  useEffect(() => {
    if (isDesktop) return
    const v = videoRef.current
    if (!v) return
    if (isPlaying) v.play().catch(() => {})
    else v.pause()
  }, [isPlaying, videoSrc])

  // Web 端：音量
  useEffect(() => {
    if (isDesktop) return
    if (videoRef.current) videoRef.current.volume = volume / 100
  }, [volume])

  // Web 端：拖进度条跳转
  useEffect(() => {
    if (isDesktop) return
    const v = videoRef.current
    if (v && Math.abs(v.currentTime - currentTime) > 1) v.currentTime = currentTime
  }, [currentTime])

  // 桌面端：测量播放区上报；控制条/返回钮可见时容器上下留白避免被 mpv 盖住
  useEffect(() => {
    if (!isDesktop || !player) return
    const el = playerAreaRef.current
    if (!el) return
    const TOP_UI = 44
    const BOTTOM_UI = 80
    const measure = () => {
      const r = el.getBoundingClientRect()
      const visible = usePlayerStore.getState().controlsVisible
      if (visible) {
        player.setPlayerArea({
          x: r.left,
          y: r.top + TOP_UI,
          width: r.width,
          height: Math.max(1, r.height - TOP_UI - BOTTOM_UI)
        })
      } else {
        player.setPlayerArea({ x: r.left, y: r.top, width: r.width, height: r.height })
      }
    }
    measureRef.current = measure
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    const off = player.onRemeasure(() => measure())
    return () => {
      ro.disconnect()
      off()
      measureRef.current = () => {}
    }
  }, [isDesktop, player])

  // 控制条显隐时重测，mpv 容器上下留白随之伸缩
  useEffect(() => {
    measureRef.current?.()
  }, [controlsVisible])

  // 桌面端：键盘快捷键（mpv 已 --input-vo-keyboard=no 不抢键盘）
  useEffect(() => {
    if (!isDesktop) return
    const onKey = (e: KeyboardEvent) => {
      const s = usePlayerStore.getState()
      if (e.key === ' ') {
        e.preventDefault()
        s.togglePlay()
      } else if (e.key === 'ArrowLeft') {
        s.seek(Math.max(0, s.currentTime - 5))
      } else if (e.key === 'ArrowRight') {
        s.seek(Math.min(s.duration, s.currentTime + 5))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        s.setVolume(Math.min(100, s.volume + 5))
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        s.setVolume(Math.max(0, s.volume - 5))
      } else if (e.key === 'f' || e.key === 'F') {
        s.toggleFullscreen()
        if (document.fullscreenElement) document.exitFullscreen()
        else document.documentElement.requestFullscreen().catch(() => {})
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isDesktop])

  const handleMouseMove = () => {
    setControlsVisible(true)
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setControlsVisible(false), 3000)
  }

  // 拖拽文件：字幕->加载字幕，视频->播放
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (!file) return
    const ext = (file.name.split('.').pop() || '').toLowerCase()
    if (['srt', 'ass', 'ssa', 'vtt'].includes(ext) && isDesktop && player) {
      const filePath = (file as File & { path: string }).path
      player.loadSubtitle(filePath)
      return
    }
    if (isDesktop) {
      const filePath = (file as File & { path: string }).path
      usePlayerStore.getState().setMedia(file.name, filePath)
    } else if (file.type.startsWith('video')) {
      const oldSrc = usePlayerStore.getState().videoSrc
      if (oldSrc && oldSrc.startsWith('blob:')) URL.revokeObjectURL(oldSrc)
      usePlayerStore.getState().setMedia(file.name, URL.createObjectURL(file))
    }
  }

  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current) }, [])

  return (
    <div
      ref={playerAreaRef}
      className="flex-1 relative bg-black flex items-center justify-center"
      onMouseMove={handleMouseMove}
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      {isDesktop ? (
        <div className="text-gray-500 text-center">
          <p className="text-2xl mb-2">{mediaName ?? '未选择媒体'}</p>
          <p className="text-sm">
            {videoSrc ? 'mpv 嵌入播放中' : '从媒体库选择或拖拽文件'}
          </p>
        </div>
      ) : videoSrc ? (
        // Web 端：HTML5 video
        <video
          ref={videoRef}
          src={videoSrc}
          className="max-w-full max-h-full"
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
          onTimeUpdate={(e) => seek(e.currentTarget.currentTime)}
          onEnded={() => usePlayerStore.setState({ isPlaying: false })}
          playsInline
        />
      ) : (
        <div className="text-gray-600 text-center">
          <p className="text-2xl mb-2">{mediaName ?? '未选择媒体'}</p>
          <p className="text-sm">拖拽视频文件到此处，或从媒体库选择</p>
        </div>
      )}

      <button
        onClick={onBack}
        className={`absolute top-4 left-4 px-3 py-1 bg-player-surface/80 rounded text-sm hover:bg-player-surface transition-opacity duration-300 ${
          controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        ← 媒体库
      </button>

      <PlayerControls />
    </div>
  )
}
