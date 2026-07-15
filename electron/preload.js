// preload: 暴露桌面端原生 API 给渲染进程
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('aiPlayer', {
  platform: 'desktop',
  isElectron: true,
  version: '0.1.0',
  ai: {
    chat: (messages) => ipcRenderer.invoke('ai:chat', messages)
  },
  files: {
    scan: (dir) => ipcRenderer.invoke('files:scan', dir),
    defaultDir: () => ipcRenderer.invoke('files:defaultDir')
  },
  sync: {
    url: () => ipcRenderer.invoke('sync:url'),
    setPeer: (url) => ipcRenderer.invoke('sync:setPeer', url),
    upload: () => ipcRenderer.invoke('sync:upload'),
    download: () => ipcRenderer.invoke('sync:download')
  },
  cast: {
    scan: () => ipcRenderer.invoke('cast:scan'),
    cast: (deviceId, filePath) => ipcRenderer.invoke('cast:cast', deviceId, filePath)
  },
  tmdb: {
    search: (name) => ipcRenderer.invoke('tmdb:search', name)
  },
  wifi: {
    url: () => ipcRenderer.invoke('wifi:url')
  },
  subtitle: {
    search: (name) => ipcRenderer.invoke('subtitle:search', name)
  },
  xlsx: {
    preview: (filePath) => ipcRenderer.invoke('xlsx:preview', filePath)
  },
  docx: {
    preview: (filePath) => ipcRenderer.invoke('docx:preview', filePath)
  },
  dialog: {
    openFile: () => ipcRenderer.invoke('dialog:openFile'),
    openFolder: () => ipcRenderer.invoke('dialog:openFolder')
  },
  print: {
    file: (filePath) => ipcRenderer.invoke('print:file', filePath)
  },
  player: {
    loadFile: (p) => ipcRenderer.invoke('mpv:load', p),
    play: () => ipcRenderer.invoke('mpv:play'),
    pause: () => ipcRenderer.invoke('mpv:pause'),
    seek: (s) => ipcRenderer.invoke('mpv:seek', s),
    setVolume: (v) => ipcRenderer.invoke('mpv:volume', v),
    loadSubtitle: (p) => ipcRenderer.invoke('mpv:subtitle', p),
    setSubtitleVisible: (v) => ipcRenderer.invoke('mpv:subtitle-visible', v),
    setPlayerArea: (rect) => ipcRenderer.send('mpv:playerArea', rect),
    showContainer: () => ipcRenderer.send('mpv:showContainer'),
    hideContainer: () => ipcRenderer.send('mpv:hideContainer'),
    onEvent: (cb) => {
      const handler = (_e, data) => cb(data)
      ipcRenderer.on('mpv:event', handler)
      return () => ipcRenderer.removeListener('mpv:event', handler)
    },
    onRemeasure: (cb) => {
      const handler = () => cb()
      ipcRenderer.on('mpv:remeasure', handler)
      return () => ipcRenderer.removeListener('mpv:remeasure', handler)
    }
  }
})

console.log('[preload] AI播放器 desktop API 已注入（含 mpv player）')
