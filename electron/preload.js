// preload: 暴露桌面端原生 API 给渲染进程
const { contextBridge, ipcRenderer } = require('electron')

const openFileSubscribers = new Set()
const pendingOpenFiles = []
ipcRenderer.on('menu:openFile', (_event, filePath) => {
  if (openFileSubscribers.size === 0) {
    pendingOpenFiles.push(filePath)
    return
  }
  for (const subscriber of openFileSubscribers) subscriber(filePath)
})

function subscribeOpenFile(callback) {
  openFileSubscribers.add(callback)
  while (pendingOpenFiles.length > 0) callback(pendingOpenFiles.shift())
  return () => openFileSubscribers.delete(callback)
}

contextBridge.exposeInMainWorld('aiPlayer', {
  platform: 'desktop',
  isElectron: true,
  version: ipcRenderer.sendSync('app:version'),
  ai: {
    chat: (messages, context, requestId) => ipcRenderer.invoke('ai:chat', messages, context, requestId),
    cancel: (requestId) => ipcRenderer.invoke('ai:cancel', requestId),
    onStream: (cb) => {
      const handler = (_event, payload) => cb(payload)
      ipcRenderer.on('ai:stream', handler)
      return () => ipcRenderer.removeListener('ai:stream', handler)
    }
  },
  models: {
    providers: () => ipcRenderer.invoke('models:providers'),
    config: (role = 'chat') => ipcRenderer.invoke('models:config', role),
    save: (config) => ipcRenderer.invoke('models:save', config),
    list: (config) => ipcRenderer.invoke('models:list', config),
    test: (config) => ipcRenderer.invoke('models:test', config),
    discoverLocal: (role = 'chat') => ipcRenderer.invoke('models:discover-local', role),
    bundledStatus: () => ipcRenderer.invoke('models:bundled-status'),
    startBundled: () => ipcRenderer.invoke('models:start-bundled'),
    stopBundled: () => ipcRenderer.invoke('models:stop-bundled')
  },
  computerUse: {
    suggest: (task, requestId) => ipcRenderer.invoke('computerUse:suggest', task, requestId),
    cancel: (requestId) => ipcRenderer.invoke('computerUse:cancel', requestId),
    onStatus: (cb) => {
      const handler = (_event, payload) => cb(payload)
      ipcRenderer.on('computerUse:status', handler)
      return () => ipcRenderer.removeListener('computerUse:status', handler)
    }
  },
  files: {
    scan: (dir) => ipcRenderer.invoke('files:scan', dir),
    defaultDir: () => ipcRenderer.invoke('files:defaultDir'),
    readText: (filePath) => ipcRenderer.invoke('files:readText', filePath),
    readDataUrl: (filePath) => ipcRenderer.invoke('files:readDataUrl', filePath)
  },
  sync: {
    url: () => ipcRenderer.invoke('sync:url'),
    stop: () => ipcRenderer.invoke('sync:stop'),
    setPeer: (url) => ipcRenderer.invoke('sync:setPeer', url),
    upload: () => ipcRenderer.invoke('sync:upload'),
    download: () => ipcRenderer.invoke('sync:download'),
    getProgress: (key) => ipcRenderer.invoke('sync:getProgress', key),
    setProgress: (key, position, preferences) => ipcRenderer.invoke('sync:setProgress', key, position, preferences)
  },
  cast: {
    scan: () => ipcRenderer.invoke('cast:scan'),
    cast: (deviceId, filePath) => ipcRenderer.invoke('cast:cast', deviceId, filePath)
  },
  tmdb: {
    search: (name, apiKey) => ipcRenderer.invoke('tmdb:search', name, apiKey)
  },
  wifi: {
    url: () => ipcRenderer.invoke('wifi:url'),
    pin: () => ipcRenderer.invoke('wifi:pin'),
    stop: () => ipcRenderer.invoke('wifi:stop')
  },
  dlna: {
    serverUrl: () => ipcRenderer.invoke('dlna:serverUrl'),
    stopServer: () => ipcRenderer.invoke('dlna:serverStop')
  },
  plugin: {
    list: () => ipcRenderer.invoke('plugin:list'),
    openFolder: () => ipcRenderer.invoke('plugin:openFolder')
  },
  media: {
    analyze: (dir) => ipcRenderer.invoke('media:analyze', dir),
    dedup: (dir) => ipcRenderer.invoke('media:dedup', dir),
    suggest: (dir) => ipcRenderer.invoke('media:suggest', dir)
  },
  studio: {
    capabilities: () => ipcRenderer.invoke('studio:capabilities'),
    context: (mediaPath) => ipcRenderer.invoke('studio:context', mediaPath),
    offlineAnalysis: (input) => ipcRenderer.invoke('studio:offline-analysis', input),
    exportProject: (project) => ipcRenderer.invoke('studio:export-project', project),
    render: (input) => ipcRenderer.invoke('studio:render', input),
    creativePlan: (input) => ipcRenderer.invoke('studio:creative-plan', input),
    generateImage: (input) => ipcRenderer.invoke('studio:generate-image', input),
    generateVoice: (input) => ipcRenderer.invoke('studio:generate-voice', input),
    selectAsset: (kind) => ipcRenderer.invoke('studio:select-asset', kind),
    renderCreative: (input) => ipcRenderer.invoke('studio:render-creative', input),
    cancelRender: () => ipcRenderer.invoke('studio:cancel-render')
  },
  receiver: {
    start: () => ipcRenderer.invoke('receiver:start'),
    stop: () => ipcRenderer.invoke('receiver:stop'),
    onPlay: (cb) => {
      const h = (_e, url) => cb(url)
      ipcRenderer.on('receiver:play', h)
      return () => ipcRenderer.removeListener('receiver:play', h)
    }
  },
  menu: {
    onAction: (cb) => {
      const h = (_e, action) => cb(action)
      ipcRenderer.on('menu:action', h)
      return () => ipcRenderer.removeListener('menu:action', h)
    },
    onOpenFile: (cb) => {
      return subscribeOpenFile(cb)
    },
    confirmOpenFile: (filePath) => ipcRenderer.send('external-media:accepted', filePath),
    onOpenFolder: (cb) => {
      const h = (_e, dirPath) => cb(dirPath)
      ipcRenderer.on('menu:openFolder', h)
      return () => ipcRenderer.removeListener('menu:openFolder', h)
    },
    onAgent: (cb) => {
      const h = () => cb()
      ipcRenderer.on('menu:agent', h)
      return () => ipcRenderer.removeListener('menu:agent', h)
    }
  },
  contextMenu: {
    show: (state) => ipcRenderer.send('context:show', state)
  },
  windowControls: {
    setPreset: (preset, mediaSize) => ipcRenderer.invoke('window:setPreset', preset, mediaSize),
    setPlaybackChromeVisible: (visible) => ipcRenderer.invoke('window:setPlaybackChromeVisible', visible),
    isPlaybackChromeVisible: () => ipcRenderer.invoke('window:isPlaybackChromeVisible'),
    onFullscreenChanged: (cb) => {
      const h = (_e, fullscreen) => cb(fullscreen)
      ipcRenderer.on('window:fullscreen-changed', h)
      return () => ipcRenderer.removeListener('window:fullscreen-changed', h)
    }
  },
  screenshot: {
    save: (dataUrl, suggestedName) => ipcRenderer.invoke('screenshot:save', dataUrl, suggestedName)
  },
  subtitle: {
    search: (name, apiKey) => ipcRenderer.invoke('subtitle:search', name, apiKey),
    download: (fileId, apiKey) => ipcRenderer.invoke('subtitle:download', fileId, apiKey)
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
  system: {
    openPath: (filePath) => ipcRenderer.invoke('system:openPath', filePath)
  },
  print: {
    file: (filePath) => ipcRenderer.invoke('print:file', filePath),
    text: (filePath) => ipcRenderer.invoke('print:text', filePath)
  },
  player: {
    info: () => ipcRenderer.invoke('mpv:info'),
    loadFile: (p) => ipcRenderer.invoke('mpv:load', p),
    play: () => ipcRenderer.invoke('mpv:play'),
    pause: () => ipcRenderer.invoke('mpv:pause'),
    seek: (s) => ipcRenderer.invoke('mpv:seek', s),
    setVolume: (v) => ipcRenderer.invoke('mpv:volume', v),
    setSpeed: (v) => ipcRenderer.invoke('mpv:speed', v),
    setPictureMode: (mode) => ipcRenderer.invoke('mpv:picture-mode', mode),
    loadSubtitle: (p) => ipcRenderer.invoke('mpv:subtitle', p),
    setSubtitleVisible: (v) => ipcRenderer.invoke('mpv:subtitle-visible', v),
    stop: () => ipcRenderer.invoke('mpv:stop'),
    screenshot: (suggestedName) => ipcRenderer.invoke('mpv:screenshot', suggestedName),
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
