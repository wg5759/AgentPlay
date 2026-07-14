import { create } from 'zustand'

interface PlayerState {
  isPlaying: boolean
  volume: number
  currentTime: number
  duration: number
  isFullscreen: boolean
  subtitleVisible: boolean
  mediaName: string | null
  videoSrc: string | null
  controlsVisible: boolean
  togglePlay: () => void
  setVolume: (v: number) => void
  seek: (t: number) => void
  setDuration: (d: number) => void
  toggleFullscreen: () => void
  toggleSubtitle: () => void
  setMedia: (name: string, src: string) => void
  setControlsVisible: (v: boolean) => void
}

export const usePlayerStore = create<PlayerState>((set) => ({
  isPlaying: false,
  volume: 80,
  currentTime: 0,
  duration: 0,
  isFullscreen: false,
  subtitleVisible: true,
  mediaName: null,
  videoSrc: null,
  controlsVisible: true,
  togglePlay: () => set((s) => ({ isPlaying: !s.isPlaying })),
  setVolume: (v) => set({ volume: v }),
  seek: (t) => set({ currentTime: t }),
  setDuration: (d) => set({ duration: d }),
  toggleFullscreen: () => set((s) => ({ isFullscreen: !s.isFullscreen })),
  toggleSubtitle: () => set((s) => ({ subtitleVisible: !s.subtitleVisible })),
  setMedia: (name, src) => set({ mediaName: name, videoSrc: src, isPlaying: true, currentTime: 0 }),
  setControlsVisible: (v) => set({ controlsVisible: v })
}))
