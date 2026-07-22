import { useCallback, useEffect, useRef, useState } from 'react'
import PlayerControls from './PlayerControls'
import { usePlayerStore } from '../stores/playerStore'
import { useAgentStore } from '../stores/agentStore'
import { PLAYER_CHROME_HIDE_DELAY_MS, isRealMouseActivity, shouldAutoHideControls } from '../player-ui-policy.mjs'

interface Props {
  onBack: () => void
}

const VIDEO_EXTS = ['.mp4', '.mkv', '.avi', '.mov', '.flv', '.webm', '.ts', '.m4v', '.wmv']
const AUDIO_EXTS = ['.mp3', '.flac', '.wav', '.aac', '.m4a', '.ogg', '.wma']
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.svg', '.ico', '.tif', '.tiff']
const TEXT_EXTS = ['.txt', '.md', '.json', '.csv', '.xml', '.html', '.htm', '.css', '.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.cpp', '.h', '.sh', '.yml', '.yaml', '.ini', '.conf', '.log', '.bat', '.ps1', '.sql', '.toml', '.env']
const OFFICE_EXTS = ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx']
const SUBTITLE_EXTS = ['.srt', '.ass', '.ssa', '.vtt']

function buildSecureOfficeDocument(html: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"><meta name="referrer" content="no-referrer"><style>body{font-family:system-ui,sans-serif;margin:0;padding:24px;color:#111;background:#fff}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #bbb;padding:6px;vertical-align:top}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`
}

function getFileType(name?: string | null): string {
  if (!name) return 'none'
  const ext = ('.' + (name.split('.').pop() || '')).toLowerCase()
  if (VIDEO_EXTS.includes(ext)) return 'video'
  if (AUDIO_EXTS.includes(ext)) return 'audio'
  if (IMAGE_EXTS.includes(ext)) return 'image'
  if (ext === '.pdf') return 'pdf'
  if (TEXT_EXTS.includes(ext)) return 'text'
  if (OFFICE_EXTS.includes(ext)) return 'office'
  if (SUBTITLE_EXTS.includes(ext)) return 'text'
  return 'other'
}

function subtitleToVtt(content: string, ext: string) {
  if (ext === 'vtt') return content.startsWith('WEBVTT') ? content : `WEBVTT\n\n${content}`
  if (ext === 'srt') return `WEBVTT\n\n${content.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')}`
  const cues = content
    .split(/\r?\n/)
    .filter((line) => /^Dialogue:/i.test(line))
    .map((line, index) => {
      const parts = line.replace(/^Dialogue:\s*/i, '').split(',')
      if (parts.length < 10) return ''
      const start = parts[1].padStart(10, '0') + '0'
      const end = parts[2].padStart(10, '0') + '0'
      const text = parts.slice(9).join(',').replace(/\{[^}]*\}/g, '').replace(/\\N/g, '\n')
      return `${index + 1}\n${start} --> ${end}\n${text}\n`
    })
    .filter(Boolean)
  return `WEBVTT\n\n${cues.join('\n')}`
}

export default function PlayerView({ onBack }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const trackRef = useRef<HTMLTrackElement>(null)
  const playerRootRef = useRef<HTMLDivElement>(null)
  const mediaName = usePlayerStore((s) => s.mediaName)
  const videoSrc = usePlayerStore((s) => s.videoSrc)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const volume = usePlayerStore((s) => s.volume)
  const currentTime = usePlayerStore((s) => s.currentTime)
  const setControlsVisible = usePlayerStore((s) => s.setControlsVisible)
  const controlsVisible = usePlayerStore((s) => s.controlsVisible)
  const setDuration = usePlayerStore((s) => s.setDuration)
  const updateTime = usePlayerStore((s) => s.updateTime)
  const rememberPosition = usePlayerStore((s) => s.rememberPosition)
  const subtitleVisible = usePlayerStore((s) => s.subtitleVisible)
  const playbackRate = usePlayerStore((s) => s.playbackRate)
  const pictureMode = usePlayerStore((s) => s.pictureMode)
  const agentOpen = useAgentStore((s) => s.open)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [officeHtml, setOfficeHtml] = useState<string | null>(null)
  const [subtitleUrl, setSubtitleUrl] = useState<string | null>(null)
  const [textContent, setTextContent] = useState<string | null>(null)
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [mpvEmbedded, setMpvEmbedded] = useState(false)
  const [mpvReady, setMpvReady] = useState(false)
  const [playbackNotice, setPlaybackNotice] = useState('')
  const [subtitleResults, setSubtitleResults] = useState<Array<{ fileId: number; fileName: string; language: string; release: string }>>([])
  const [subtitleStatus, setSubtitleStatus] = useState('')
  const [bilingualBusy, setBilingualBusy] = useState(false)
  const [subtitlePanelOpen, setSubtitlePanelOpen] = useState(false)
  const [liveSub, setLiveSub] = useState<{ requestId: string; cues: Array<{ index: number; start: number; end: number; text: string }> } | null>(null)
  const liveTranslationsRef = useRef(new Map<number, string>())
  const liveSeekSentRef = useRef(0)
  const subtitleFileRef = useRef('')

  const isDesktop = window.aiPlayer?.isElectron === true
  const fileType = getFileType(mediaName)
  const isMedia = fileType === 'video' || fileType === 'audio'
  const useMpv = isDesktop && isMedia && mpvEmbedded

  const fileUrl =
    isDesktop && videoSrc && !videoSrc.startsWith('http') && !videoSrc.startsWith('blob:')
      ? 'file:///' + videoSrc.replace(/\\/g, '/')
      : videoSrc

  useEffect(() => {
    if (useMpv) return
    const el = fileType === 'video' ? videoRef.current : fileType === 'audio' ? audioRef.current : null
    if (!el || !fileUrl) return
    if (isPlaying) el.play().catch(() => {})
    else el.pause()
  }, [isPlaying, fileUrl, fileType, useMpv])

  useEffect(() => {
    if (useMpv) return
    const el = fileType === 'video' ? videoRef.current : fileType === 'audio' ? audioRef.current : null
    if (el) el.volume = volume / 100
  }, [volume, fileType, useMpv])

  useEffect(() => {
    if (useMpv) {
      void window.aiPlayer?.player?.setSpeed(playbackRate)
      return
    }
    const el = fileType === 'video' ? videoRef.current : fileType === 'audio' ? audioRef.current : null
    if (el) el.playbackRate = playbackRate
  }, [fileType, playbackRate, useMpv])

  useEffect(() => {
    if (useMpv) void window.aiPlayer?.player?.setPictureMode(pictureMode)
  }, [pictureMode, useMpv])

  useEffect(() => {
    if (useMpv) return
    const el = fileType === 'video' ? videoRef.current : fileType === 'audio' ? audioRef.current : null
    if (el && Math.abs(el.currentTime - currentTime) > 1) el.currentTime = currentTime
  }, [currentTime, fileType, useMpv])

  useEffect(() => {
    if (!isDesktop || !window.aiPlayer?.player) return
    let active = true
    window.aiPlayer.player.info().then((info) => {
      if (active) {
        setMpvReady(info.ready)
        setMpvEmbedded(info.ready && info.embedded)
      }
    })
    return () => { active = false }
  }, [isDesktop])

  useEffect(() => {
    if (!isDesktop || mpvEmbedded || !window.aiPlayer?.player) return
    setPlaybackNotice('')
    void window.aiPlayer.player.stop()
    return () => { void window.aiPlayer?.player?.stop() }
  }, [isDesktop, mpvEmbedded, videoSrc])

  useEffect(() => {
    if (!useMpv || !videoSrc) return
    const player = window.aiPlayer?.player
    if (!player) return
    void player.loadFile(videoSrc).then((loaded) => {
      if (!loaded) return
      void player.setVolume(volume)
      if (currentTime > 0) void player.seek(currentTime)
      if (isPlaying) void player.play()
    })
    player.showContainer()
    return () => player.hideContainer()
  }, [useMpv, videoSrc])

  useEffect(() => {
    if (!useMpv) return
    const player = window.aiPlayer?.player
    if (!player) return
    if (agentOpen || subtitlePanelOpen) player.hideContainer()
    else player.showContainer()
  }, [agentOpen, subtitlePanelOpen, useMpv])

  useEffect(() => {
    if (!useMpv || !window.aiPlayer?.player) return
    return window.aiPlayer.player.onEvent(({ event, data }) => {
      if (event !== 'property') return
      if (data.name === 'time-pos' && typeof data.data === 'number') updateTime(data.data)
      else if (data.name === 'duration' && typeof data.data === 'number') setDuration(data.data)
      else if (data.name === 'pause' && typeof data.data === 'boolean') usePlayerStore.setState({ isPlaying: !data.data })
      else if (data.name === 'volume' && typeof data.data === 'number') usePlayerStore.setState({ volume: data.data })
      else if (data.name === 'eof-reached' && data.data === true) usePlayerStore.setState({ isPlaying: false })
    })
  }, [setDuration, updateTime, useMpv])

  useEffect(() => {
    if (!useMpv || !playerRootRef.current || !window.aiPlayer?.player) return
    const reportBounds = () => {
      const rect = playerRootRef.current?.getBoundingClientRect()
      if (!rect) return
      window.aiPlayer?.player?.setPlayerArea({
        x: Math.round(rect.left),
        y: Math.round(rect.top + 56),
        width: Math.round(rect.width),
        height: Math.max(1, Math.round(rect.height - 144))
      })
    }
    reportBounds()
    const observer = new ResizeObserver(reportBounds)
    observer.observe(playerRootRef.current)
    const off = window.aiPlayer.player.onRemeasure(reportBounds)
    window.addEventListener('resize', reportBounds)
    return () => {
      observer.disconnect()
      off()
      window.removeEventListener('resize', reportBounds)
    }
  }, [useMpv])

  useEffect(() => {
    if (!isMedia) return
    const persistProgress = () => {
      rememberPosition()
      const state = usePlayerStore.getState()
      if (isDesktop && mediaName && window.aiPlayer?.sync) {
        void window.aiPlayer.sync.setProgress(mediaName, state.currentTime, {
          volume: state.volume,
          subtitleVisible: state.subtitleVisible
        })
      }
    }
    const timer = setInterval(persistProgress, 5000)
    return () => {
      clearInterval(timer)
      persistProgress()
    }
  }, [isDesktop, isMedia, mediaName, rememberPosition, videoSrc])

  useEffect(() => {
    if (!isDesktop || !isMedia || !mediaName || !window.aiPlayer?.sync) return
    let active = true
    window.aiPlayer.sync.getProgress(mediaName).then((progress) => {
      if (!active || !progress || progress.position <= 0) return
      const state = usePlayerStore.getState()
      if (state.currentTime <= 0.5) {
        state.seek(progress.position)
        void window.aiPlayer?.player?.seek(progress.position)
      }
    })
    return () => { active = false }
  }, [isDesktop, isMedia, mediaName])

  const clearHideTimer = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = null
  }, [])

  const holdControlsVisible = useCallback(() => {
    setControlsVisible(true)
    clearHideTimer()
  }, [clearHideTimer, setControlsVisible])

  const hideControlsIfIdle = useCallback(() => {
    // 点击控制按钮后焦点可能残留在按钮上：到点先释放按钮焦点（触发 onBlurCapture 重新武装一轮无妨），
    // 再判定隐藏；滑杆/下拉等持续型控件保持"正在使用"判定，不强行隐藏。
    const active = document.activeElement
    if (active instanceof HTMLButtonElement && active.closest('[data-player-chrome="true"]')) active.blur()
    const isUsingChrome = document.activeElement instanceof HTMLElement && Boolean(document.activeElement.closest('[data-player-chrome="true"]'))
    if (!isUsingChrome && !useAgentStore.getState().open) setControlsVisible(false)
  }, [setControlsVisible])

  // 只武装隐藏计时，不强制显示：控制栏消失瞬间元素在光标下触发 pointerleave/blur，
  // 若离开时又重新显示，就会形成 显示→3秒隐藏→再显示 的循环（窗口随菜单栏显隐抖动）。
  const scheduleAutoHide = useCallback(() => {
    clearHideTimer()
    if (shouldAutoHideControls({ hasMedia: isMedia, playing: isPlaying, blocked: subtitlePanelOpen || agentOpen })) {
      hideTimer.current = setTimeout(hideControlsIfIdle, PLAYER_CHROME_HIDE_DELAY_MS)
    }
  }, [agentOpen, clearHideTimer, hideControlsIfIdle, isMedia, isPlaying, subtitlePanelOpen])

  const handleUserActivity = useCallback(() => {
    holdControlsVisible()
    scheduleAutoHide()
  }, [holdControlsVisible, scheduleAutoHide])

  // 鼠标/触摸点完控制按钮就把焦点还回去（click/pointerup 后按钮已完成使命）；
  // 否则焦点残留在按钮上，隐藏计时到点看到"焦点在控制区"会永久放弃隐藏。
  // 键盘 Tab 操作不走 pointer 事件，焦点保留不受影响。
  const releaseChromeFocus = useCallback((event: React.SyntheticEvent) => {
    const target = event.target as HTMLElement
    const control = target.closest?.('[data-player-chrome="true"] button, [data-player-chrome="true"] input, [data-player-chrome="true"] select')
    if (control instanceof HTMLElement) window.setTimeout(() => control.blur(), 0)
  }, [])

  // 光学/高轮询率鼠标静止时会持续发出 ±1~2px 的抖动事件，若每次都当用户活动，
  // 控制栏会被反复唤醒（永不隐藏），原生菜单栏跟着显隐导致整个窗口“抖动”。
  // 只有位移超过阈值才视为真实鼠标活动。
  const lastMousePos = useRef<{ x: number; y: number } | null>(null)
  const handleMouseMove = useCallback((event: React.MouseEvent) => {
    const last = lastMousePos.current
    const next = { x: event.clientX, y: event.clientY }
    lastMousePos.current = next
    if (!isRealMouseActivity(last, next)) return
    handleUserActivity()
  }, [handleUserActivity])

  useEffect(() => {
    handleUserActivity()
    return clearHideTimer
  }, [clearHideTimer, handleUserActivity])

  useEffect(() => {
    // 播放期间菜单栏全程隐藏（Alt 唤出），不随控制栏显隐：避免客户区高度变化把按钮挪到静止光标下
    void window.aiPlayer?.windowControls?.setPlaybackChromeVisible(!isMedia)
  }, [isMedia])

  useEffect(() => () => {
    void window.aiPlayer?.windowControls?.setPlaybackChromeVisible(true)
  }, [])

  const takeScreenshot = async () => {
    const fileBase = (mediaName || '视频').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_')
    if (useMpv) {
      await window.aiPlayer?.player?.screenshot(`${fileBase}-${Date.now()}.png`)
      return
    }
    const video = videoRef.current
    if (!video || !video.videoWidth || !video.videoHeight) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height)
    await window.aiPlayer?.screenshot?.save(canvas.toDataURL('image/png'), `${fileBase}-${Date.now()}.png`)
  }

  const applyWindowPreset = (preset: 'original' | 'half' | 'fill' | 'fullscreen') => {
    const video = videoRef.current
    void window.aiPlayer?.windowControls?.setPreset(preset, video?.videoWidth && video?.videoHeight
      ? { width: video.videoWidth, height: video.videoHeight }
      : undefined)
  }

  const runPlayerAction = (action: string) => {
    const state = usePlayerStore.getState()
    if (action === 'play-toggle') {
      const next = !state.isPlaying
      state.togglePlay()
      void (next ? window.aiPlayer?.player?.play() : window.aiPlayer?.player?.pause())
    } else if (action === 'seek-backward' || action === 'seek-forward') {
      const target = Math.max(0, Math.min(state.duration || Infinity, state.currentTime + (action === 'seek-forward' ? 10 : -10)))
      state.seek(target)
      void window.aiPlayer?.player?.seek(target)
    } else if (action === 'volume-up' || action === 'volume-down') {
      const value = Math.max(0, Math.min(100, state.volume + (action === 'volume-up' ? 5 : -5)))
      state.setVolume(value)
      void window.aiPlayer?.player?.setVolume(value)
    } else if (action === 'mute-toggle') {
      state.toggleMute()
      void window.aiPlayer?.player?.setVolume(usePlayerStore.getState().volume)
    } else if (action === 'subtitle-toggle') {
      state.toggleSubtitle()
      void window.aiPlayer?.player?.setSubtitleVisible(usePlayerStore.getState().subtitleVisible)
    } else if (action === 'screenshot') {
      void takeScreenshot()
    } else if (action === 'online-subtitle') {
      void searchOnlineSubtitle()
    } else if (action.startsWith('speed-')) {
      const rate = Number(action.slice(6))
      state.setPlaybackRate(rate)
      void window.aiPlayer?.player?.setSpeed(rate)
    } else if (action.startsWith('picture-')) {
      const mode = action.slice(8) as 'original' | 'fit' | 'fill' | 'stretch'
      state.setPictureMode(mode)
      void window.aiPlayer?.player?.setPictureMode(mode)
      if (mode === 'fill') setPlaybackNotice('裁剪铺满会隐藏上下或左右边缘；选择“完整显示”可看到全部画面')
      else setPlaybackNotice('')
    } else if (action === 'bilingual-subtitle') {
      void generateBilingual()
    } else if (action === 'live-translate-subtitle') {
      void toggleLiveTranslate()
    } else if (action.startsWith('window-')) {
      applyWindowPreset(action.slice(7) as 'original' | 'half' | 'fill' | 'fullscreen')
    }
  }

  useEffect(() => {
    const menuHandler = (event: Event) => runPlayerAction((event as CustomEvent<string>).detail)
    const keyboardHandler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return
      const keys: Record<string, string> = {
        ' ': 'play-toggle', ArrowLeft: 'seek-backward', ArrowRight: 'seek-forward',
        ArrowUp: 'volume-up', ArrowDown: 'volume-down', m: 'mute-toggle', M: 'mute-toggle',
        f: 'window-fullscreen', F: 'window-fullscreen'
      }
      const action = keys[event.key]
      if (!action) return
      event.preventDefault()
      runPlayerAction(action)
    }
    window.addEventListener('ai-player-action', menuHandler)
    window.addEventListener('keydown', keyboardHandler)
    return () => {
      window.removeEventListener('ai-player-action', menuHandler)
      window.removeEventListener('keydown', keyboardHandler)
    }
  })

  const bilingualRequestId = useRef('')
  useEffect(() => {
    const off = window.aiPlayer?.subtitleBilingual?.onStatus((event) => {
      if (event.requestId === bilingualRequestId.current) setSubtitleStatus(event.status)
    })
    return off
  }, [])

  const generateBilingual = async () => {
    const api = window.aiPlayer?.subtitleBilingual
    if (!api) return
    if (!videoSrc || videoSrc.startsWith('blob:') || /^https?:/i.test(videoSrc)) {
      setSubtitlePanelOpen(true)
      setSubtitleStatus('双语字幕只支持本地文件；请先打开本地视频或音频。')
      return
    }
    setBilingualBusy(true)
    setSubtitlePanelOpen(true)
    setSubtitleStatus('正在准备双语字幕…')
    try {
      const requestId = `bilingual-${Date.now()}`
      bilingualRequestId.current = requestId
      const result = await api.generate({ path: videoSrc, requestId })
      if (!result.success) {
        setSubtitleStatus(result.needDownload ? `${result.error}（模型接入中心可一键下载）` : result.error || '生成失败')
        return
      }
      await applySubtitle(result.srtPath!, '.srt')
      setSubtitleStatus(`双语字幕已生成（${result.count} 句${result.failed ? `，${result.failed} 句未译` : ''}）：${result.srtPath}`)
      setSubtitlePanelOpen(false)
    } catch (error) {
      setSubtitleStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBilingualBusy(false)
    }
  }

  const liveRequestIdRef = useRef('')
  useEffect(() => {
    const off = window.aiPlayer?.subtitleLive?.onEvent((event) => {
      if (event.requestId !== liveRequestIdRef.current) return
      if (event.type === 'progress' && event.batch) {
        for (const item of event.batch) liveTranslationsRef.current.set(item.index, item.text)
        setSubtitleStatus(`实时翻译中 ${event.done}/${event.total}${event.failed ? `（${event.failed} 句未译）` : ''}`)
      } else if (event.type === 'finish') {
        setSubtitleStatus(event.cancelled ? '实时翻译已停止' : `实时翻译完成（${event.done}/${event.total} 句${event.failed ? `，${event.failed} 句未译` : ''}）`)
        if (useMpv) {
          if (event.srtPath) void applySubtitle(event.srtPath, 'srt')
          setLiveSub(null)
          liveRequestIdRef.current = ''
        }
      } else if (event.type === 'error') {
        setSubtitleStatus(event.error || '实时翻译出错')
        setLiveSub(null)
        liveRequestIdRef.current = ''
      }
    })
    return off
  }, [useMpv])

  const toggleLiveTranslate = async () => {
    const api = window.aiPlayer?.subtitleLive
    if (!api) return
    if (liveSub) {
      await api.stop(liveSub.requestId)
      liveRequestIdRef.current = ''
      setLiveSub(null)
      liveTranslationsRef.current = new Map()
      setSubtitleStatus('实时翻译已关闭')
      return
    }
    if (!videoSrc || videoSrc.startsWith('blob:') || /^https?:/i.test(videoSrc)) {
      setSubtitlePanelOpen(true)
      setSubtitleStatus('实时翻译只支持本地文件；请先打开本地视频。')
      return
    }
    const requestId = `live-sub-${Date.now()}`
    liveRequestIdRef.current = requestId
    liveTranslationsRef.current = new Map()
    setSubtitlePanelOpen(true)
    setSubtitleStatus('正在准备实时翻译…')
    const result = await api.start({ mediaPath: videoSrc, subtitlePath: subtitleFileRef.current, currentTime: usePlayerStore.getState().currentTime, requestId })
    if (!result.success || !result.cues) {
      liveRequestIdRef.current = ''
      setSubtitleStatus(result.error || '实时翻译启动失败')
      return
    }
    setLiveSub({ requestId: result.requestId || requestId, cues: result.cues })
    setSubtitleStatus(`实时翻译已开启（${result.total} 句，从当前位置向前翻译）`)
    setSubtitlePanelOpen(false)
  }

  useEffect(() => {
    if (!liveSub) return
    const api = window.aiPlayer?.subtitleLive
    if (!api) return
    if (Math.abs(currentTime - liveSeekSentRef.current) < 4) return
    liveSeekSentRef.current = currentTime
    void api.seek({ requestId: liveSub.requestId, currentTime })
  }, [currentTime, liveSub])

  useEffect(() => () => {
    if (liveRequestIdRef.current) {
      void window.aiPlayer?.subtitleLive?.stop(liveRequestIdRef.current)
      liveRequestIdRef.current = ''
      setLiveSub(null)
    }
  }, [videoSrc])

  const applySubtitle = async (subtitlePath: string, ext: string) => {    subtitleFileRef.current = subtitlePath
    if (useMpv) {
      const loaded = await window.aiPlayer?.player?.loadSubtitle(subtitlePath)
      if (!loaded) throw new Error('mpv 未能加载字幕')
    } else {
      const result = await window.aiPlayer?.files?.readText(subtitlePath)
      if (!result?.success || result.content === undefined) throw new Error(result?.error || '字幕读取失败')
      if (subtitleUrl?.startsWith('blob:')) URL.revokeObjectURL(subtitleUrl)
      setSubtitleUrl(URL.createObjectURL(new Blob([subtitleToVtt(result.content, ext)], { type: 'text/vtt' })))
    }
    usePlayerStore.setState({ subtitleVisible: true })
    void window.aiPlayer?.player?.setSubtitleVisible(true)
  }

  const searchOnlineSubtitle = async () => {
    if (!mediaName || !window.aiPlayer?.subtitle) return
    const apiKey = localStorage.getItem('aiplayer_subtitle_key') || undefined
    setSubtitlePanelOpen(true)
    setSubtitleStatus('正在搜索字幕…')
    setSubtitleResults([])
    const query = mediaName.replace(/\.[^.]+$/, '')
    const result = await window.aiPlayer.subtitle.search(query, apiKey)
    if (!result.success) {
      setSubtitleStatus(result.error || '字幕搜索失败')
      return
    }
    setSubtitleResults(result.data || [])
    setSubtitleStatus(result.data?.length ? '' : '没有找到匹配字幕')
  }

  const downloadOnlineSubtitle = async (item: { fileId: number; fileName: string }) => {
    const apiKey = localStorage.getItem('aiplayer_subtitle_key') || undefined
    setSubtitleStatus('正在下载字幕…')
    const result = await window.aiPlayer?.subtitle?.download(item.fileId, apiKey)
    if (!result?.success || !result.path) {
      setSubtitleStatus(result?.error || '字幕下载失败')
      return
    }
    try {
      await applySubtitle(result.path, (result.fileName || item.fileName).split('.').pop()?.toLowerCase() || 'srt')
      setSubtitleStatus('字幕已加载')
      setSubtitlePanelOpen(false)
    } catch (e) {
      setSubtitleStatus(e instanceof Error ? e.message : String(e))
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (!file) return
    const ext = (file.name.split('.').pop() || '').toLowerCase()
    if (['srt', 'ass', 'ssa', 'vtt'].includes(ext)) {
      if (isDesktop) {
        const subtitlePath = (file as File & { path: string }).path
        void applySubtitle(subtitlePath, ext).catch((error) => setSubtitleStatus(String(error)))
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
      if (['.docx', '.doc'].includes(ext)) {
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
    if (fileType === 'text' && videoSrc && isDesktop) {
      setTextContent('加载中...')
      window.aiPlayer?.files?.readText(videoSrc).then((r) => {
        setTextContent(r?.success ? r.content || '（空文件）' : '读取失败: ' + (r.error || ''))
      })
    } else {
      setTextContent(null)
    }
  }, [fileType, videoSrc, isDesktop])

  useEffect(() => {
    if (trackRef.current?.track) {
      trackRef.current.track.mode = usePlayerStore.getState().subtitleVisible && !liveSub ? 'showing' : 'hidden'
    }
  }, [subtitleUrl, subtitleVisible, liveSub])

  useEffect(() => () => {
    if (subtitleUrl?.startsWith('blob:')) URL.revokeObjectURL(subtitleUrl)
  }, [subtitleUrl])

  useEffect(() => {
    if ((fileType === 'image' || fileType === 'pdf') && videoSrc && isDesktop) {
      setDataUrl(null)
      window.aiPlayer?.files?.readDataUrl(videoSrc).then((r) => {
        setDataUrl(r?.success ? r.dataUrl || null : null)
      })
    } else {
      setDataUrl(null)
    }
  }, [fileType, videoSrc, isDesktop])

  useEffect(() => {
    const handler = () => {
      const fullscreen = !!document.fullscreenElement
      usePlayerStore.setState({ isFullscreen: fullscreen, controlsVisible: true })
    }
    document.addEventListener('fullscreenchange', handler)
    const offNative = window.aiPlayer?.windowControls?.onFullscreenChanged((fullscreen) => {
      usePlayerStore.setState({ isFullscreen: fullscreen, controlsVisible: true })
    })
    return () => {
      document.removeEventListener('fullscreenchange', handler)
      offNative?.()
    }
  }, [])

  return (
    <div
      ref={playerRootRef}
      className={`flex-1 min-h-0 relative overflow-hidden bg-black flex items-center justify-center ${isMedia && !controlsVisible ? 'cursor-none' : ''}`}
      onMouseMove={handleMouseMove}
      onClickCapture={releaseChromeFocus}
      onPointerUpCapture={releaseChromeFocus}
      onPointerDown={handleUserActivity}
      onKeyDownCapture={handleUserActivity}
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
      onContextMenu={(e) => {
        e.preventDefault()
        window.aiPlayer?.contextMenu?.show({
          hasMedia: isMedia,
          isPlaying,
          subtitleVisible,
          pictureMode,
          playbackRate,
          liveTranslate: !!liveSub
        })
      }}
      onDoubleClick={() => {
        if (fileType === 'office' || fileType === 'other') return
        applyWindowPreset('fullscreen')
      }}
    >
      {fileType === 'video' && fileUrl && !useMpv && (
        <video
          ref={videoRef}
          data-ai-player-video="true"
          src={fileUrl}
          className={pictureMode === 'fill'
            ? 'w-full h-full object-cover'
            : pictureMode === 'stretch'
              ? 'w-full h-full object-fill'
              : pictureMode === 'original'
                ? 'w-full h-full object-contain'
                : 'w-full h-full object-contain'}
          onLoadedMetadata={(e) => {
            setDuration(e.currentTarget.duration)
            e.currentTarget.playbackRate = playbackRate
          }}
          onTimeUpdate={(e) => updateTime(e.currentTarget.currentTime)}
          onEnded={() => usePlayerStore.setState({ isPlaying: false })}
          onError={async () => {
            if (!isDesktop || !mpvReady || !videoSrc || !window.aiPlayer?.player) {
              setPlaybackNotice('当前视频编码无法播放')
              return
            }
            const loaded = await window.aiPlayer.player.loadFile(videoSrc)
            if (loaded) {
              await window.aiPlayer.player.setVolume(volume)
              await window.aiPlayer.player.play()
              setPlaybackNotice('当前编码已切换到独立 mpv 兼容窗口')
            } else {
              setPlaybackNotice('当前视频编码无法播放')
            }
          }}
          playsInline
        >
          {subtitleUrl && <track ref={trackRef} src={subtitleUrl} kind="subtitles" default />}
        </video>
      )}
      {playbackNotice && !useMpv && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 rounded bg-black/80 px-4 py-2 text-sm text-amber-300">
          {playbackNotice}
        </div>
      )}
      {liveSub && !useMpv && (() => {
        const cue = liveSub.cues.find((item) => currentTime >= item.start && currentTime <= item.end)
        if (!cue) return null
        const translated = liveTranslationsRef.current.get(cue.index)
        return (
          <div className="absolute bottom-28 left-1/2 -translate-x-1/2 max-w-3xl text-center pointer-events-none">
            <span className="inline-block rounded bg-black/70 px-3 py-1 text-lg text-white" style={{ textShadow: '0 1px 3px #000' }}>{cue.text}</span>
            {translated && <span className="mt-1 inline-block rounded bg-black/70 px-3 py-1 text-base text-cyan-200" style={{ textShadow: '0 1px 3px #000' }}>{translated}</span>}
          </div>
        )
      })()}
      {useMpv && <div className="text-gray-600 text-sm">mpv 播放内核已连接</div>}
      {fileType === 'audio' && fileUrl && !useMpv && (
        <div className="text-center">
          <p className="text-5xl mb-4">🎵</p>
          <p className="text-gray-300 mb-4">{mediaName}</p>
          <audio
            ref={audioRef}
            src={fileUrl}
            className="w-96"
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            onTimeUpdate={(e) => updateTime(e.currentTarget.currentTime)}
            onEnded={() => usePlayerStore.setState({ isPlaying: false })}
          />
        </div>
      )}
      {fileType === 'image' && (
        dataUrl ? (
          <img src={dataUrl} alt={mediaName ?? ''} className="max-w-full max-h-full object-contain" />
        ) : (
          <div className="text-gray-500">图片加载中...</div>
        )
      )}
      {fileType === 'pdf' && (
        dataUrl ? (
          <iframe src={dataUrl} title="pdf" className="w-full h-full bg-white" />
        ) : (
          <div className="text-gray-500">PDF 加载中...</div>
        )
      )}
      {fileType === 'text' && (
        textContent !== null ? (
          <pre className="w-full h-full overflow-auto bg-white text-black p-6 text-sm font-mono whitespace-pre-wrap break-all">{textContent}</pre>
        ) : (
          <div className="text-gray-500">加载中...</div>
        )
      )}
      {fileType === 'office' && (
        officeHtml ? (
          <iframe
            title="隔离的 Office 预览"
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={buildSecureOfficeDocument(officeHtml)}
            className="w-full h-full border-0 bg-white"
          />
        ) : (
          <div className="text-gray-400 text-center">
            <p className="text-2xl mb-2">{mediaName}</p>
            <p className="text-sm mb-4">当前文件无法在播放器内安全预览，可交给系统 Office 程序打开</p>
            <button
              onClick={() => videoSrc && void window.aiPlayer?.system?.openPath(videoSrc)}
              className="px-4 py-2 bg-player-accent rounded text-white text-sm"
            >
              用系统程序打开
            </button>
          </div>
        )
      )}
      {fileType === 'none' && (
        <div className="text-gray-600 text-center">
          <p className="text-2xl mb-4">未选择文件</p>
          <button
            onClick={async () => {
              const p = await window.aiPlayer?.dialog?.openFile()
              if (p) usePlayerStore.getState().setMedia(p.split(/[\\/]/).pop() || p, p)
            }}
            className="px-6 py-3 bg-player-accent rounded-lg text-white text-base hover:bg-blue-600"
          >
            📂 打开文件
          </button>
          <p className="text-sm mt-4">或拖拽文件到此处，或从媒体库选择</p>
        </div>
      )}

      <button
        onClick={onBack}
        data-player-chrome="true"
        onPointerEnter={holdControlsVisible}
        onPointerLeave={scheduleAutoHide}
        className={`absolute top-4 left-4 px-3 py-1 bg-player-surface/80 rounded text-sm hover:bg-player-surface transition-opacity duration-300 ${
          controlsVisible || !isMedia ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        ← 媒体库
      </button>

      {isMedia && isDesktop && (
        <button
          onClick={searchOnlineSubtitle}
          data-player-chrome="true"
          onPointerEnter={holdControlsVisible}
          onPointerLeave={scheduleAutoHide}
          className={`absolute top-4 right-4 px-3 py-1 bg-player-surface/80 rounded text-sm hover:bg-player-surface transition-opacity duration-300 ${
            controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        >
          在线字幕
        </button>
      )}

      {subtitlePanelOpen && (
        <div className="absolute inset-0 z-40 bg-black/75 flex items-center justify-center" onClick={() => setSubtitlePanelOpen(false)}>
          <div className="w-full max-w-lg max-h-[70vh] overflow-auto bg-player-surface rounded-xl p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm">选择在线字幕</p>
              <button onClick={() => setSubtitlePanelOpen(false)}>✕</button>
            </div>
            {subtitleStatus && <p className="text-sm text-gray-400 mb-2">{bilingualBusy && <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-blue-400" />}{subtitleStatus}</p>}
            {subtitleResults.map((item) => (
              <button
                key={item.fileId}
                onClick={() => void downloadOnlineSubtitle(item)}
                className="block w-full text-left px-3 py-2 rounded hover:bg-white/10 text-sm"
              >
                [{item.language}] {item.fileName || item.release}
              </button>
            ))}
          </div>
        </div>
      )}

      {isMedia && <PlayerControls onInteractionStart={holdControlsVisible} onInteractionEnd={scheduleAutoHide} />}
    </div>
  )
}
