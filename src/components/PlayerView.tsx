import { useCallback, useEffect, useRef, useState } from 'react'
import PlayerControls from './PlayerControls'
import { usePlayerStore } from '../stores/playerStore'
import { useAgentStore } from '../stores/agentStore'
import { PLAYER_CHROME_HIDE_DELAY_MS, isRealMouseActivity, shouldAutoHideControls } from '../player-ui-policy.mjs'
import { subtitleCueSettings, subtitleLinePercent } from '../subtitle-display-policy.mjs'

interface Props {
  onBack: () => void
}

const VIDEO_EXTS = ['.mp4', '.mkv', '.avi', '.mov', '.flv', '.webm', '.ts', '.m4v', '.wmv']
const AUDIO_EXTS = ['.mp3', '.flac', '.wav', '.aac', '.m4a', '.ogg', '.wma']
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.svg', '.ico', '.tif', '.tiff']
const TEXT_EXTS = ['.txt', '.md', '.json', '.csv', '.xml', '.html', '.htm', '.css', '.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.cpp', '.h', '.sh', '.yml', '.yaml', '.ini', '.conf', '.log', '.bat', '.ps1', '.sql', '.toml', '.env']
const OFFICE_EXTS = ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf']
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

function applyVttPosition(content: string, position: 'high' | 'middle' | 'low') {
  const settings = subtitleCueSettings(position)
  return content.replace(/^(\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3})(?:\s+.*)?$/gm, `$1 ${settings}`)
}

function subtitleToVtt(content: string, ext: string, position: 'high' | 'middle' | 'low') {
  const format = ext.trim().replace(/^\./, '').toLowerCase()
  if (format === 'vtt') return applyVttPosition(content.startsWith('WEBVTT') ? content : `WEBVTT\n\n${content}`, position)
  if (format === 'srt') {
    const timestamps = content.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    return applyVttPosition(`WEBVTT\n\n${timestamps}`, position)
  }
  const cues = content
    .split(/\r?\n/)
    .filter((line) => /^Dialogue:/i.test(line))
    .map((line, index) => {
      const parts = line.replace(/^Dialogue:\s*/i, '').split(',')
      if (parts.length < 10) return ''
      const start = parts[1].padStart(10, '0') + '0'
      const end = parts[2].padStart(10, '0') + '0'
      const text = parts.slice(9).join(',').replace(/\{[^}]*\}/g, '').replace(/\\N/g, '\n')
      return `${index + 1}\n${start} --> ${end} ${subtitleCueSettings(position)}\n${text}\n`
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
  const subtitlePosition = usePlayerStore((s) => s.subtitlePosition)
  const playbackRate = usePlayerStore((s) => s.playbackRate)
  const pictureMode = usePlayerStore((s) => s.pictureMode)
  const setPictureMode = usePlayerStore((s) => s.setPictureMode)
  const isFullscreen = usePlayerStore((s) => s.isFullscreen)
  const theater = usePlayerStore((s) => s.theater)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [officeHtml, setOfficeHtml] = useState<string | null>(null)
  const [officeText, setOfficeText] = useState<string | null>(null)
  const [subtitleUrl, setSubtitleUrl] = useState<string | null>(null)
  const [subtitleTrackLang, setSubtitleTrackLang] = useState<'zh' | 'en'>('zh')
  const [textContent, setTextContent] = useState<string | null>(null)
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [mpvEmbedded, setMpvEmbedded] = useState(false)
  const [mpvReady, setMpvReady] = useState(false)
  const [playbackNotice, setPlaybackNotice] = useState('')
  const [subtitleResults, setSubtitleResults] = useState<Array<{ fileId: number; fileName: string; language: string; release: string }>>([])
  const [subtitleStatus, setSubtitleStatus] = useState('')
  const [subtitleRecovery, setSubtitleRecovery] = useState<SubtitleRecovery | null>(null)
  const [subtitleRecoveryBusy, setSubtitleRecoveryBusy] = useState(false)
  const [subtitleRecoveryProgress, setSubtitleRecoveryProgress] = useState<LocalAiDownloadProgress | null>(null)
  const [subtitleRecoveryError, setSubtitleRecoveryError] = useState('')
  const [bilingualBusy, setBilingualBusy] = useState(false)
  const bilingualInFlightRef = useRef(false)
  const bilingualSourceRef = useRef(videoSrc)
  const [subtitlePanelOpen, setSubtitlePanelOpen] = useState(false)
  const [liveSub, setLiveSub] = useState<{ requestId: string; targetLang?: string; cues: Array<{ index: number; start: number; end: number; text: string }> } | null>(null)
  const [liveTranslations, setLiveTranslations] = useState(new Map<number, string>())
  const liveSeekSentRef = useRef(0)
  const subtitleFileRef = useRef('')
  const [langPrompt, setLangPrompt] = useState<{ lang: string; targetLang: '中文' | '英文' } | null>(null)
  const [detectedLang, setDetectedLang] = useState<'zh' | 'en' | null>(null)
  const langPromptOffRef = useRef(false)

  const isDesktop = window.aiPlayer?.isElectron === true
  const fileType = getFileType(mediaName)
  const isMedia = fileType === 'video' || fileType === 'audio'
  const useMpv = isDesktop && isMedia && mpvEmbedded

  const fileUrl =
    isDesktop && videoSrc && !videoSrc.startsWith('http') && !videoSrc.startsWith('blob:')
      ? 'file:///' + encodeURI(videoSrc.replace(/\\/g, '/')).replace(/#/g, '%23')
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

  // 每个新媒体先以“完整显示”打开。裁切铺满仍可由用户显式选择，但不会被上个视频或旧持久化状态继承。
  useEffect(() => {
    if (videoSrc) setPictureMode('fit')
  }, [setPictureMode, videoSrc])

  useEffect(() => {
    if (useMpv) {
      void window.aiPlayer?.player?.setSubtitlePosition(subtitlePosition)
      return
    }
    const trackElement = trackRef.current
    if (!trackElement) return
    const applyPosition = () => {
      const cues = trackElement.track?.cues
      if (!cues) return
      for (let index = 0; index < cues.length; index += 1) {
        const cue = cues[index] as VTTCue
        cue.snapToLines = false
        cue.line = subtitleLinePercent(subtitlePosition)
        cue.position = 50
        cue.size = 72
        cue.align = 'center'
      }
    }
    applyPosition()
    trackElement.addEventListener('load', applyPosition)
    return () => trackElement.removeEventListener('load', applyPosition)
  }, [subtitlePosition, subtitleUrl, useMpv])

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
      // mpv keeps process-level properties between files. Reassert the new
      // media's fit policy even when Zustand was already `fit` and no effect
      // transition was emitted.
      void player.setPictureMode(usePlayerStore.getState().pictureMode)
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
    if (subtitlePanelOpen) player.hideContainer()
    else player.showContainer()
  }, [subtitlePanelOpen, useMpv])

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
    if (!isUsingChrome) setControlsVisible(false)
  }, [setControlsVisible])

  // 只武装隐藏计时，不强制显示：控制栏消失瞬间元素在光标下触发 pointerleave/blur，
  // 若离开时又重新显示，就会形成 显示→3秒隐藏→再显示 的循环（窗口随菜单栏显隐抖动）。
  const scheduleAutoHide = useCallback(() => {
    clearHideTimer()
    if (shouldAutoHideControls({ hasMedia: isMedia, playing: isPlaying, immersive: theater || isFullscreen, blocked: subtitlePanelOpen })) {
      hideTimer.current = setTimeout(hideControlsIfIdle, PLAYER_CHROME_HIDE_DELAY_MS)
    }
  }, [clearHideTimer, hideControlsIfIdle, isFullscreen, isMedia, isPlaying, subtitlePanelOpen, theater])

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
    // AI-native 工作区默认隐藏旧菜单栏；Alt、快捷键与右键仍可访问对应功能。
    void window.aiPlayer?.windowControls?.setPlaybackChromeVisible(false)
  }, [isMedia])

  useEffect(() => () => {
    void window.aiPlayer?.windowControls?.setPlaybackChromeVisible(false)
  }, [])

  const handlePrint = async () => {
    if (!videoSrc) return
    const result = fileType === 'text'
      ? await window.aiPlayer?.print?.text(videoSrc)
      : fileType === 'office' && officeHtml
        ? await window.aiPlayer?.print?.html(buildSecureOfficeDocument(officeHtml))
        : await window.aiPlayer?.print?.file(videoSrc)
    if (result && result.success === false) setPlaybackNotice(result.error || '打印失败')
    else setPlaybackNotice('')
  }

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

  // 影院模式与原生全屏使用同一个明确目标值，避免异步事件把 toggle 状态翻反。
  const toggleTheaterMode = () => {
    const state = usePlayerStore.getState()
    const next = !(state.theater || state.isFullscreen)
    state.setTheater(next)
    if (isDesktop) void window.aiPlayer?.windowControls?.setFullscreen(next)
  }

  // 问这帧：抓取当前视频画面发给视觉模型，回答回到中栏对话
  const askFrame = async () => {
    const agent = useAgentStore.getState()
    const question = agent.inputText.trim() || '这个画面里是什么？用中文简要描述'
    agent.setInputText('')
    agent.openPanel()
    agent.addMessage('user', `💬 ${question}`)
    agent.addMessage('agent', '正在看这一帧…')
    let dataUrl = ''
    if (!useMpv && videoRef.current && videoRef.current.videoWidth > 0) {
      const canvas = document.createElement('canvas')
      canvas.width = videoRef.current.videoWidth
      canvas.height = videoRef.current.videoHeight
      canvas.getContext('2d')?.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height)
      dataUrl = canvas.toDataURL('image/jpeg', 0.85)
    }
    const result = await window.aiPlayer?.guide?.askFrame({ question, dataUrl })
    agent.addMessage('agent', result?.success ? result.answer || '（模型没有回答）' : `[错误] ${result?.error || '画面问答不可用'}`)
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
    } else if (action === 'live-transcribe-subtitle') {
      void toggleLiveTranscribe()
    } else if (action.startsWith('window-')) {
      applyWindowPreset(action.slice(7) as 'original' | 'half' | 'fill' | 'fullscreen')
    }
  }

  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__playerActionMounted = true
    const menuHandler = (event: Event) => runPlayerAction((event as CustomEvent<string>).detail)
    const keyboardHandler = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof Element && target.matches('input, textarea, select, [contenteditable="true"]')) return
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
      delete (window as unknown as Record<string, unknown>).__playerActionMounted
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

  const generateBilingual = async (preferredTarget?: '中文' | '英文') => {
    const api = window.aiPlayer?.subtitleBilingual
    if (!api || bilingualInFlightRef.current) return
    if (!videoSrc || videoSrc.startsWith('blob:') || /^https?:/i.test(videoSrc)) {
      setSubtitlePanelOpen(true)
      setSubtitleStatus('字幕翻译只支持本地文件；请先打开本地视频或音频。')
      return
    }
    const targetLang = preferredTarget || (detectedLang === 'zh' ? '英文' : '中文')
    const requestId = `bilingual-${Date.now()}`
    bilingualInFlightRef.current = true
    setBilingualBusy(true)
    setSubtitlePanelOpen(false)
    setSubtitleRecovery(null)
    setSubtitleRecoveryError('')
    setSubtitleRecoveryProgress(null)
    setSubtitleStatus(`正在准备${targetLang}字幕…`)
    try {
      bilingualRequestId.current = requestId
      const result = await api.generate({ path: videoSrc, requestId, engine: 'auto', targetLang, durationSeconds: usePlayerStore.getState().duration })
      if (bilingualRequestId.current !== requestId) return
      if (!result.success) {
        if (result.recovery) {
          setSubtitleRecovery(result.recovery)
          setSubtitleStatus('')
        } else {
          setSubtitleStatus(result.cancelled ? '字幕翻译已停止' : result.error || '生成失败')
        }
        return
      }
      setSubtitleRecovery(null)
      await applySubtitle(result.srtPath!, '.srt', result.targetLang === '英文' ? 'en' : 'zh')
      const displayedLanguage = result.targetLang || targetLang
      setSubtitleStatus(result.cached
        ? `${displayedLanguage}字幕已显示（使用上次生成结果）`
        : `${displayedLanguage}字幕已显示（${result.count} 条${result.engine ? ` · ${result.engine}` : ''}${result.failed ? ` · ${result.failed} 段未译` : ''}）`)
      setSubtitlePanelOpen(false)
    } catch (error) {
      if (bilingualRequestId.current === requestId) setSubtitleStatus(error instanceof Error ? error.message : String(error))
    } finally {
      if (bilingualRequestId.current === requestId) {
        bilingualRequestId.current = ''
        bilingualInFlightRef.current = false
        setBilingualBusy(false)
      }
    }
  }

  const runSubtitleRecovery = async () => {
    const recovery = subtitleRecovery
    if (!recovery || subtitleRecoveryBusy) return
    if (recovery.kind === 'configure-cloud') {
      window.dispatchEvent(new CustomEvent('ai-player-open-model-center', {
        detail: {
          providerId: recovery.providerId || 'agnes',
          model: recovery.model || 'agnes-2.5-flash',
          reason: '为字幕翻译接入 Agnes；字幕翻译只发送字幕原文，不上传视频。'
        }
      }))
      return
    }

    setSubtitleRecoveryBusy(true)
    setSubtitleRecoveryError('')
    setSubtitleRecoveryProgress(null)
    let unsubscribe: (() => void) | undefined
    try {
      const api = recovery.kind === 'install-whisper' ? window.aiPlayer?.transcribe : window.aiPlayer?.translatePack
      if (!api) throw new Error('组件下载接口不可用，请重启 AgentPlay 后重试')
      unsubscribe = api.onProgress?.((progress) => setSubtitleRecoveryProgress(progress))
      const result = await api.download()
      if (!result?.success) throw new Error(result?.error || '组件下载失败')
      setSubtitleRecovery(null)
      setSubtitleRecoveryProgress(null)
      setSubtitleStatus('组件已安装，正在自动继续字幕任务…')
      void generateBilingual(recovery.targetLang)
    } catch (error) {
      setSubtitleRecoveryError(error instanceof Error ? error.message : String(error))
    } finally {
      unsubscribe?.()
      setSubtitleRecoveryBusy(false)
    }
  }

  const cancelSubtitleRecoveryDownload = async () => {
    const recovery = subtitleRecovery
    if (!recovery || !subtitleRecoveryBusy) return
    if (recovery.kind === 'install-whisper') await window.aiPlayer?.transcribe?.cancelDownload()
    if (recovery.kind === 'install-translate') await window.aiPlayer?.translatePack?.cancelDownload()
    setSubtitleRecoveryError('组件下载已停止，可以稍后继续')
  }

  useEffect(() => {
    const handleModelsChanged = () => {
      const recovery = subtitleRecovery
      if (recovery?.kind !== 'configure-cloud') return
      void window.aiPlayer?.models?.config('chat').then((config) => {
        if (!config?.configured || config.localOnly) return
        setSubtitleRecovery(null)
        setSubtitleStatus('云端模型已接入，正在自动继续字幕任务…')
        void generateBilingual(recovery.targetLang)
      })
    }
    window.addEventListener('ai-player-models-changed', handleModelsChanged)
    return () => window.removeEventListener('ai-player-models-changed', handleModelsChanged)
  }, [subtitleRecovery, videoSrc, detectedLang])

  const cancelBilingual = async () => {
    const requestId = bilingualRequestId.current
    const api = window.aiPlayer?.subtitleBilingual
    if (!requestId || !api?.cancel) return
    setSubtitleStatus('正在停止字幕翻译…')
    const handled = await api.cancel(requestId)
    if (!handled && bilingualRequestId.current === requestId) {
      bilingualRequestId.current = ''
      bilingualInFlightRef.current = false
      setBilingualBusy(false)
      setSubtitleStatus('字幕任务已经结束')
    }
  }

  useEffect(() => {
    if (bilingualSourceRef.current === videoSrc) return
    bilingualSourceRef.current = videoSrc
    const requestId = bilingualRequestId.current
    if (requestId) void window.aiPlayer?.subtitleBilingual?.cancel?.(requestId)
    bilingualRequestId.current = ''
    bilingualInFlightRef.current = false
    setBilingualBusy(false)
    setSubtitleStatus('')
    setSubtitleRecovery(null)
    setSubtitleRecoveryError('')
    setSubtitleRecoveryProgress(null)
  }, [videoSrc])

  useEffect(() => {
    if (bilingualBusy || !/(字幕已显示|字幕翻译已停止|字幕任务已经结束)/.test(subtitleStatus)) return
    const timer = window.setTimeout(() => {
      setSubtitleStatus((current) => current === subtitleStatus ? '' : current)
    }, 5000)
    return () => window.clearTimeout(timer)
  }, [bilingualBusy, subtitleStatus])

  const liveRequestIdRef = useRef('')
  useEffect(() => {
    const off = window.aiPlayer?.subtitleLive?.onEvent((event) => {
      if (event.requestId !== liveRequestIdRef.current) return
      if (event.type === 'transcribe-cues' && event.cues) {
        // 实时识别：识别一句到一句，直接追加进字幕轨
        setLiveSub((current) => current
          ? { ...current, cues: [...current.cues, ...(event.cues || []).map((cue) => ({ index: cue.index, start: cue.start, end: cue.end, text: cue.text }))] }
          : current)
        setSubtitleStatus('实时识别中（边播边转写）')
      } else if (event.type === 'progress' && event.batch) {
        setLiveTranslations((current) => {
          const next = new Map(current)
          for (const item of event.batch || []) next.set(item.index, item.text)
          return next
        })
        setSubtitleStatus(`实时翻译中 ${event.done}/${event.total}${event.failed ? `（${event.failed} 句未译）` : ''}`)
      } else if (event.type === 'finish') {
        setSubtitleStatus(event.cancelled ? '实时翻译已停止' : `实时翻译完成（${event.done}/${event.total} 句${event.failed ? `，${event.failed} 句未译` : ''}）`)
        if (useMpv) {
          if (event.srtPath) void applySubtitle(event.srtPath, 'srt', event.targetLang === '英文' ? 'en' : 'zh')
          setLiveSub(null)
          liveRequestIdRef.current = ''
        }
      } else if (event.type === 'refining') {
        setSubtitleStatus('初稿字幕完成，正在用精修模型后台精修（不占播放）…')
      } else if (event.type === 'refined' && event.srtPath) {
        setSubtitleStatus(`字幕已精修（${event.cueCount} 句，small 模型）`)
        void applySubtitle(event.srtPath, 'srt')
        setLiveSub(null)
        liveRequestIdRef.current = ''
      } else if (event.type === 'refine-failed') {
        setSubtitleStatus(`精修未完成（保留初稿字幕）：${event.error || ''}`)
      } else if (event.type === 'error') {
        setSubtitleStatus(event.error || '实时翻译出错')
        setLiveSub(null)
        liveRequestIdRef.current = ''
      }
    })
    return off
  }, [useMpv])

  // 语言探测：中文内容翻成英文、英文内容翻成中文；主字幕只显示目标语言。
  useEffect(() => {
    setLangPrompt(null)
    setDetectedLang(null)
    if (!isDesktop || fileType !== 'video' || !videoSrc || /^(https?|blob):/i.test(videoSrc)) return
    if (langPromptOffRef.current || liveSub) return
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const result = await window.aiPlayer?.detectLanguage?.(videoSrc)
        if (cancelled || !result || (result.lang !== 'en' && result.lang !== 'zh')) return
        const targetLang = result.lang === 'zh' ? '英文' : '中文'
        setDetectedLang(result.lang)
        setLangPrompt({ lang: result.lang, targetLang })
      } catch { /* 探测失败静默 */ }
    }, 1800)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [videoSrc, isDesktop, fileType])

  const toggleLiveTranslate = async (targetLang?: string) => {
    const api = window.aiPlayer?.subtitleLive
    if (!api) return
    if (liveSub) {
      await api.stop(liveSub.requestId)
      liveRequestIdRef.current = ''
      setLiveSub(null)
      setLiveTranslations(new Map())
      setSubtitleStatus('实时翻译已关闭')
      return
    }
    if (!videoSrc || videoSrc.startsWith('blob:') || /^https?:/i.test(videoSrc)) {
      setSubtitlePanelOpen(true)
      setSubtitleStatus('实时翻译只支持本地文件；请先打开本地视频。')
      return
    }
    const requestId = `live-sub-${Date.now()}`
    const resolvedTarget = targetLang || (detectedLang === 'zh' ? '英文' : '中文')
    liveRequestIdRef.current = requestId
    setLiveTranslations(new Map())
    setSubtitlePanelOpen(true)
    setSubtitleStatus('正在准备实时翻译…')
    const result = await api.start({ mediaPath: videoSrc, subtitlePath: subtitleFileRef.current, currentTime: usePlayerStore.getState().currentTime, targetLang: resolvedTarget, requestId })
    if (!result.success || !result.cues) {
      liveRequestIdRef.current = ''
      setSubtitleStatus(result.error || '实时翻译启动失败')
      return
    }
    setLiveSub({ requestId: result.requestId || requestId, targetLang: result.targetLang || resolvedTarget, cues: result.cues })
    setSubtitleStatus(`实时翻译已开启（只显示${result.targetLang || resolvedTarget}，${result.total} 段）`)
    setSubtitlePanelOpen(false)
  }

  // 实时识别：无字幕视频边播边转写（whisper 离线组件）
  const toggleLiveTranscribe = async () => {
    const api = window.aiPlayer?.subtitleLive
    if (!api?.startTranscribe) return
    if (liveSub) {
      await api.stop(liveSub.requestId)
      liveRequestIdRef.current = ''
      setLiveSub(null)
      setLiveTranslations(new Map())
      setSubtitleStatus('实时识别已关闭')
      return
    }
    if (!videoSrc || videoSrc.startsWith('blob:') || /^https?:/i.test(videoSrc)) {
      setSubtitlePanelOpen(true)
      setSubtitleStatus('实时识别只支持本地文件；请先打开本地视频。')
      return
    }
    const requestId = `live-tr-${Date.now()}`
    liveRequestIdRef.current = requestId
    setLiveTranslations(new Map())
    setSubtitleStatus('正在启动实时识别（首次需加载转写组件）…')
    const result = await api.startTranscribe({
      mediaPath: videoSrc,
      currentTime: usePlayerStore.getState().currentTime,
      duration: usePlayerStore.getState().duration,
      requestId
    })
    if (!result.success) {
      liveRequestIdRef.current = ''
      setSubtitlePanelOpen(true)
      setSubtitleStatus(result.error || '实时识别启动失败')
      return
    }
    setLiveSub({ requestId: result.requestId || requestId, cues: [] })
    setSubtitlePanelOpen(false)
    setSubtitleStatus('实时识别已开启（边播边转写，识别一句显示一句）')
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

  const applySubtitle = async (subtitlePath: string, ext: string, language?: 'zh' | 'en') => {
    subtitleFileRef.current = subtitlePath
    if (language) setSubtitleTrackLang(language)
    if (useMpv) {
      const loaded = await window.aiPlayer?.player?.loadSubtitle(subtitlePath)
      if (!loaded) throw new Error('mpv 未能加载字幕')
    } else {
      const result = await window.aiPlayer?.files?.readText(subtitlePath)
      if (!result?.success || result.content === undefined) throw new Error(result?.error || '字幕读取失败')
      const nextUrl = URL.createObjectURL(new Blob([subtitleToVtt(result.content, ext, subtitlePosition)], { type: 'text/vtt' }))
      setSubtitleUrl((current) => {
        if (current?.startsWith('blob:')) URL.revokeObjectURL(current)
        return nextUrl
      })
    }
    usePlayerStore.setState({ subtitleVisible: true })
    void window.aiPlayer?.player?.setSubtitleVisible(true)
  }

  const searchOnlineSubtitle = async () => {
    if (!mediaName || !window.aiPlayer?.subtitle) return
    setSubtitlePanelOpen(true)
    setSubtitleResults([])
    const credentials = await window.aiPlayer.serviceCredentials?.status()
    if (credentials && !credentials.services.opensubtitles.hasKey) {
      setSubtitleStatus('在线字幕库需要 OpenSubtitles API Key（不是 AI 模型）。可到“运行与隐私”填写，或直接使用自动翻译字幕。')
      return
    }
    setSubtitleStatus('正在搜索字幕…')
    const query = mediaName.replace(/\.[^.]+$/, '')
    const result = await window.aiPlayer.subtitle.search(query)
    if (!result.success) {
      setSubtitleStatus(result.error || '字幕搜索失败')
      return
    }
    setSubtitleResults(result.data || [])
    setSubtitleStatus(result.data?.length ? '' : '没有找到匹配字幕')
  }

  const downloadOnlineSubtitle = async (item: { fileId: number; fileName: string; language?: string }) => {
    setSubtitleStatus('正在下载字幕…')
    const result = await window.aiPlayer?.subtitle?.download(item.fileId)
    if (!result?.success || !result.path) {
      setSubtitleStatus(result?.error || '字幕下载失败')
      return
    }
    try {
      await applySubtitle(result.path, (result.fileName || item.fileName).split('.').pop()?.toLowerCase() || 'srt', /^en/i.test(item.language || '') ? 'en' : 'zh')
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
      const filePath = window.aiPlayer?.files?.getPathForFile?.(file) || (file as File & { path?: string }).path || ''
      if (!filePath) {
        setPlaybackNotice('没有读取到文件路径，请重新从资源管理器拖入')
        return
      }
      usePlayerStore.getState().setMedia(file.name, filePath)
    } else {
      const oldSrc = usePlayerStore.getState().videoSrc
      if (oldSrc && oldSrc.startsWith('blob:')) URL.revokeObjectURL(oldSrc)
      usePlayerStore.getState().setMedia(file.name, URL.createObjectURL(file))
    }
  }

  useEffect(() => {
    if (fileType === 'office' && videoSrc) {
      const ext = ('.' + (mediaName?.split('.').pop() || '')).toLowerCase()
      setOfficeHtml(null)
      setOfficeText(null)
      if (['.docx', '.doc'].includes(ext)) {
        window.aiPlayer?.docx?.preview(videoSrc).then((r) => setOfficeHtml(r?.success ? r.html || null : null))
      } else if (['.xls', '.xlsx'].includes(ext)) {
        window.aiPlayer?.xlsx?.preview(videoSrc).then((r) => setOfficeHtml(r?.success ? r.html || null : null))
      } else if (['.pptx', '.odt', '.ods', '.odp', '.rtf'].includes(ext)) {
        setOfficeText('正在安全提取内容…')
        window.aiPlayer?.documents?.previewText(videoSrc).then((r) => {
          setOfficeText(r?.success ? r.content || '（没有可显示的文字内容）' : null)
        })
      } else {
        setOfficeHtml(null)
      }
    } else {
      setOfficeHtml(null)
      setOfficeText(null)
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
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable="true"]')) return
      const state = usePlayerStore.getState()
      if (!state.theater) return
      state.setTheater(false)
      if (isDesktop) void window.aiPlayer?.windowControls?.setFullscreen(false)
      else if (document.fullscreenElement) void document.exitFullscreen()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isDesktop])

  useEffect(() => {
    const handler = () => {
      const fullscreen = !!document.fullscreenElement
      usePlayerStore.setState({ isFullscreen: fullscreen, controlsVisible: true })
    }
    document.addEventListener('fullscreenchange', handler)
    const offNative = window.aiPlayer?.windowControls?.onFullscreenChanged((fullscreen) => {
      usePlayerStore.setState((state) => ({
        isFullscreen: fullscreen,
        controlsVisible: true,
        // Windows can consume Escape before the renderer sees keydown. The
        // native leave-full-screen event is the authoritative recovery edge.
        theater: fullscreen ? state.theater : false
      }))
    })
    return () => {
      document.removeEventListener('fullscreenchange', handler)
      offNative?.()
    }
  }, [])

  return (
    <div
      ref={playerRootRef}
      className={`w-full h-full min-w-0 min-h-0 flex-1 relative overflow-hidden bg-black flex items-center justify-center ${isMedia && !controlsVisible ? 'cursor-none' : ''}`}
      onMouseMove={handleMouseMove}
      onPointerEnter={handleUserActivity}
      onClickCapture={releaseChromeFocus}
      onPointerUpCapture={releaseChromeFocus}
      onPointerDown={handleUserActivity}
      onKeyDownCapture={handleUserActivity}
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
      onContextMenu={(e) => {
        // 输入框/可编辑区域右键走系统编辑菜单（复制/粘贴/剪切），不弹播放器菜单
        if (e.target instanceof HTMLElement && e.target.closest('input, textarea, [contenteditable="true"]')) return
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
        toggleTheaterMode()
      }}
    >
      {fileType === 'video' && fileUrl && !useMpv && (
        <video
          ref={videoRef}
          data-ai-player-video="true"
          data-picture-mode={pictureMode}
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
          {subtitleUrl && <track ref={trackRef} src={subtitleUrl} kind="subtitles" srcLang={subtitleTrackLang} label={subtitleTrackLang === 'en' ? 'English' : '中文字幕'} default onError={() => setSubtitleStatus('翻译字幕轨加载失败，请重试')} />}
        </video>
      )}
      {langPrompt && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 rounded-lg bg-player-surface/95 border border-white/15 px-3 py-2 text-xs shadow-lg" data-player-chrome="true" onPointerEnter={holdControlsVisible} onPointerLeave={scheduleAutoHide}>
          <span className="text-gray-200">检测到{langPrompt.lang === 'en' ? '英语' : '中文'}内容，是否显示{langPrompt.targetLang}字幕？</span>
          <button onClick={() => { const target = langPrompt.targetLang; setLangPrompt(null); void generateBilingual(target) }} className="rounded bg-player-accent px-2.5 py-1 text-white hover:opacity-90">显示{langPrompt.targetLang}字幕</button>
          <button onClick={() => setLangPrompt(null)} className="px-2 py-1 text-gray-400 hover:text-white">暂不</button>
          <button onClick={() => { langPromptOffRef.current = true; setLangPrompt(null) }} className="px-1 py-1 text-gray-500 hover:text-white" title="本会话不再提示">✕</button>
        </div>
      )}

      {subtitleRecovery && !subtitlePanelOpen && (
        <div
          data-subtitle-recovery="true"
          data-recovery-kind={subtitleRecovery.kind}
          className="absolute top-16 left-1/2 z-30 w-[min(92%,520px)] -translate-x-1/2 overflow-hidden rounded-2xl border border-cyan-300/20 bg-[#101722]/95 shadow-2xl backdrop-blur-xl"
          data-player-chrome="true"
          onPointerEnter={holdControlsVisible}
          onPointerLeave={scheduleAutoHide}
        >
          <div className="flex items-start gap-3 px-4 py-3.5">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-cyan-300/10 text-cyan-200">✦</div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-white">{subtitleRecovery.title}</div>
              <div className="mt-1 text-xs leading-5 text-gray-300">{subtitleRecovery.detail}</div>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-400">
                <span>{subtitleRecovery.timeLabel}</span>
                <span>{subtitleRecovery.costLabel}</span>
              </div>
              {subtitleRecoveryBusy && subtitleRecoveryProgress && (() => {
                const total = Math.max(1, subtitleRecoveryProgress.totalBytes || subtitleRecovery.downloadBytes || 1)
                const percent = Math.min(100, Math.round(((subtitleRecoveryProgress.receivedBytes || 0) / total) * 100))
                return <div className="mt-3">
                  <div className="mb-1 flex justify-between text-[11px] text-cyan-100"><span>正在安装组件</span><span>{percent}%</span></div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-cyan-300 transition-all" style={{ width: `${percent}%` }} /></div>
                </div>
              })()}
              {subtitleRecoveryError && <div className="mt-2 text-xs text-rose-300">{subtitleRecoveryError}</div>}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button disabled={subtitleRecoveryBusy} onClick={() => void runSubtitleRecovery()} className="rounded-xl bg-player-accent px-3.5 py-2 text-xs font-medium text-white hover:opacity-90 disabled:cursor-wait disabled:opacity-50">
                  {subtitleRecoveryBusy ? '正在安装…' : subtitleRecovery.actionLabel}
                </button>
                {subtitleRecoveryBusy && <button onClick={() => void cancelSubtitleRecoveryDownload()} className="rounded-xl bg-white/10 px-3 py-2 text-xs text-gray-200 hover:bg-white/15">停止下载</button>}
                {!subtitleRecoveryBusy && <button onClick={() => setSubtitleRecovery(null)} className="px-2 py-2 text-xs text-gray-400 hover:text-white">稍后处理</button>}
              </div>
            </div>
            {!subtitleRecoveryBusy && <button onClick={() => setSubtitleRecovery(null)} className="shrink-0 text-gray-500 hover:text-white" aria-label="关闭字幕修复建议">✕</button>}
          </div>
        </div>
      )}

      {subtitleStatus && !subtitleRecovery && !subtitlePanelOpen && (
        <div data-subtitle-progress="true" className="absolute top-16 left-1/2 z-30 flex max-w-[80%] -translate-x-1/2 items-center gap-2 rounded-full border border-white/15 bg-black/80 px-4 py-2 text-xs text-gray-100 shadow-xl" data-player-chrome="true">
          {bilingualBusy && <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-cyan-300" />}
          <span className="truncate">{subtitleStatus}</span>
          {bilingualBusy && <button data-cancel-subtitle-translation="true" onClick={() => void cancelBilingual()} className="shrink-0 rounded-full bg-white/10 px-2.5 py-1 text-white hover:bg-white/20">停止</button>}
          {!bilingualBusy && <button onClick={() => setSubtitleStatus('')} className="shrink-0 text-gray-400 hover:text-white" aria-label="关闭字幕状态">✕</button>}
        </div>
      )}
      {playbackNotice && !useMpv && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 rounded bg-black/80 px-4 py-2 text-sm text-amber-300">
          {playbackNotice}
        </div>
      )}
      {liveSub && !useMpv && (() => {
        const cue = liveSub.cues.find((item) => currentTime >= item.start && currentTime <= item.end)
        if (!cue) return null
        const translated = liveTranslations.get(cue.index)
        if (!translated) return null
        return (
          <div className="absolute bottom-[12%] left-1/2 z-20 w-[86%] -translate-x-1/2 text-center pointer-events-none" aria-live="polite">
            <span data-live-translated-caption="true" className="inline-block max-w-full whitespace-pre-line rounded-xl bg-black/75 px-4 py-2 text-[clamp(16px,2.1vw,28px)] font-medium leading-[1.38] text-white shadow-2xl" style={{ textShadow: '0 2px 5px #000' }}>{translated}</span>
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
        ) : officeText !== null ? (
          <pre className="w-full h-full overflow-auto bg-white px-8 py-7 text-[15px] leading-7 text-gray-900 whitespace-pre-wrap break-words">{officeText}</pre>
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
      {isDesktop && videoSrc && ['image', 'pdf', 'text', 'office'].includes(fileType) && (fileType !== 'office' || officeHtml || officeText !== null) && (
        <button
          onClick={() => void handlePrint()}
          title="打印当前文件"
          data-player-chrome="true"
          className="absolute top-4 right-4 z-30 w-9 h-9 rounded-lg bg-player-surface/80 hover:bg-player-surface flex items-center justify-center text-base"
        >
          🖨️
        </button>
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
        ✕ 关闭
      </button>

      {isMedia && isDesktop && fileType === 'video' && (
        <button
          onClick={() => void askFrame()}
          title="把当前画面发给 AI 问答（输入框里的文字作为问题）"
          data-player-chrome="true"
          onPointerEnter={holdControlsVisible}
          onPointerLeave={scheduleAutoHide}
          className={`absolute top-4 right-24 px-3 py-1 bg-player-surface/80 rounded text-sm hover:bg-player-surface transition-opacity duration-300 ${
            controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        >
          💬 问这帧
        </button>
      )}

      {isMedia && isDesktop && (
        <button
          onClick={() => void generateBilingual()}
          disabled={bilingualBusy}
          data-smart-translate-subtitle="true"
          data-player-chrome="true"
          onPointerEnter={holdControlsVisible}
          onPointerLeave={scheduleAutoHide}
          className={`absolute top-4 right-4 px-3 py-1 bg-player-surface/80 rounded text-sm hover:bg-player-surface disabled:cursor-wait disabled:opacity-70 transition-opacity duration-300 ${
            controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        >
          {bilingualBusy ? '正在处理字幕…' : '翻译字幕'}
        </button>
      )}

      {subtitlePanelOpen && (
        <div className="absolute inset-0 z-40 bg-black/75 flex items-center justify-center" onClick={() => setSubtitlePanelOpen(false)}>
          <div className="w-full max-w-lg max-h-[70vh] overflow-auto bg-player-surface rounded-xl p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm">更多字幕来源</p>
              <button onClick={() => setSubtitlePanelOpen(false)}>✕</button>
            </div>
            {subtitleStatus && <p className="text-sm text-gray-400 mb-2">{bilingualBusy && <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-blue-400" />}{subtitleStatus}</p>}
            {subtitleStatus.includes('OpenSubtitles API Key') && <div className="mb-3 flex flex-wrap gap-2">
              <button onClick={() => { setSubtitlePanelOpen(false); window.dispatchEvent(new CustomEvent('ai-player-open-backstage')) }} className="rounded-lg bg-white/10 px-3 py-2 text-xs text-gray-200 hover:bg-white/15">填写字幕库 Key</button>
              <button onClick={() => void generateBilingual()} className="rounded-lg bg-player-accent px-3 py-2 text-xs text-white hover:opacity-90">自动翻译字幕</button>
            </div>}
            {/模型接入中心|云端模型|转写组件/.test(subtitleStatus) && <button onClick={() => { setSubtitlePanelOpen(false); window.dispatchEvent(new CustomEvent('ai-player-action', { detail: 'model-center' })) }} className="mb-3 rounded-lg bg-player-accent px-3 py-2 text-xs text-white hover:opacity-90">打开模型与字幕组件</button>}
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
