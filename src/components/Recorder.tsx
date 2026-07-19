import { useEffect, useState, useRef } from 'react'

interface Props {
  trigger?: number
  hidden?: boolean
}

export default function Recorder({ trigger = 0, hidden = false }: Props) {
  const [recording, setRecording] = useState(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      const recorder = new MediaRecorder(stream)
      chunksRef.current = []
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'video/webm' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'AI播放器-录制-' + Date.now() + '.webm'
        a.click()
        URL.revokeObjectURL(url)
        stream.getTracks().forEach((t) => t.stop())
      }
      recorder.start(10000)
      recorderRef.current = recorder
      setRecording(true)
    } catch (e) {
      console.error('录制启动失败:', e)
    }
  }

  const stop = () => {
    recorderRef.current?.stop()
    setRecording(false)
  }

  useEffect(() => {
    if (!trigger) return
    if (recorderRef.current?.state === 'recording') stop()
    else void start()
  }, [trigger])

  if (hidden && !recording) return null

  return (
    <button
      onClick={recording ? stop : start}
      className={`${hidden ? 'fixed z-[65] right-5 top-5 shadow-xl' : ''} px-3 py-2 rounded-lg text-sm ${
        recording ? 'bg-red-500 animate-pulse' : 'bg-player-surface hover:ring-1 ring-player-accent'
      }`}
    >
      {recording ? '⏹ 正在录制 · 点击停止' : '⏺ 录制'}
    </button>
  )
}
