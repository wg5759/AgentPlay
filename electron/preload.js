// preload: 暴露桌面端原生 API 给渲染进程
const { contextBridge, ipcRenderer, webUtils } = require('electron')

const openFileSubscribers = new Set()
const pendingOpenFiles = []
const documentOpenSubscribers = new Set()
const pendingDocumentOpens = []
ipcRenderer.on('documents:open-external', (_event, files) => {
  if (documentOpenSubscribers.size === 0) {
    pendingDocumentOpens.push(files)
    return
  }
  for (const subscriber of documentOpenSubscribers) subscriber(files)
})

function subscribeDocumentOpen(callback) {
  documentOpenSubscribers.add(callback)
  while (pendingDocumentOpens.length > 0) callback(pendingDocumentOpens.shift())
  return () => documentOpenSubscribers.delete(callback)
}
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
    chat: (messages, context, requestId, agentOptions) => ipcRenderer.invoke('ai:chat', messages, context, requestId, agentOptions),
    cancel: (requestId) => ipcRenderer.invoke('ai:cancel', requestId),
    onStream: (cb) => {
      const handler = (_event, payload) => cb(payload)
      ipcRenderer.on('ai:stream', handler)
      return () => ipcRenderer.removeListener('ai:stream', handler)
    }
  },
  home: {
    open: () => ipcRenderer.invoke('home:open'),
    openFolder: () => ipcRenderer.invoke('home:open-folder')
  },
  chat: {
    openAny: () => ipcRenderer.invoke('chat:open-any'),
    attachPaths: (filePaths) => ipcRenderer.invoke('chat:attach-paths', filePaths)
  },
  documents: {
    capabilities: () => ipcRenderer.invoke('documents:capabilities'),
    selectFiles: () => ipcRenderer.invoke('documents:select-files'),
    plan: (input) => ipcRenderer.invoke('documents:plan', input),
    attachPaths: (filePaths) => ipcRenderer.invoke('documents:attach-paths', filePaths),
    previewText: (filePath) => ipcRenderer.invoke('documents:preview-text', filePath),
    history: () => ipcRenderer.invoke('documents:history'),
    run: (input) => ipcRenderer.invoke('documents:run', input),
    cancel: (requestId) => ipcRenderer.invoke('documents:cancel', requestId),
    onOpenExternal: (cb) => subscribeDocumentOpen(cb),
    onStatus: (cb) => {
      const handler = (_event, payload) => cb(payload)
      ipcRenderer.on('documents:status', handler)
      return () => ipcRenderer.removeListener('documents:status', handler)
    }
  },
  analysis: {
    detect: (text) => ipcRenderer.invoke('analysis:detect', text),
    run: (input) => ipcRenderer.invoke('analysis:run', input),
    cancel: (requestId) => ipcRenderer.invoke('analysis:cancel', requestId),
    onStatus: (cb) => {
      const handler = (_event, payload) => cb(payload)
      ipcRenderer.on('analysis:status', handler)
      return () => ipcRenderer.removeListener('analysis:status', handler)
    }
  },
  outcomeWorkflow: {
    detect: (input) => ipcRenderer.invoke('outcome:detect', input),
    run: (input) => ipcRenderer.invoke('outcome:run', input),
    cancel: (requestId) => ipcRenderer.invoke('outcome:cancel', requestId),
    onStatus: (cb) => {
      const handler = (_event, payload) => cb(payload)
      ipcRenderer.on('outcome:status', handler)
      return () => ipcRenderer.removeListener('outcome:status', handler)
    }
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    get: (projectId) => ipcRenderer.invoke('projects:get', projectId),
    listTrash: () => ipcRenderer.invoke('projects:list-trash'),
    archive: (input) => ipcRenderer.invoke('projects:archive', input),
    copy: (projectId) => ipcRenderer.invoke('projects:copy', projectId),
    trash: (input) => ipcRenderer.invoke('projects:trash', input),
    restore: (projectId) => ipcRenderer.invoke('projects:restore', projectId)
  },
  linkContent: {
    detect: (text) => ipcRenderer.invoke('links:detect', text),
    handle: (input) => ipcRenderer.invoke('links:handle', input)
  },
  evidence: {
    inspectFile: (filePath) => ipcRenderer.invoke('evidence:inspect-file', filePath)
  },
  crossMaterial: {
    detect: (input) => ipcRenderer.invoke('cross-material:detect', input),
    ask: (input) => ipcRenderer.invoke('cross-material:ask', input),
    cancel: (requestId) => ipcRenderer.invoke('cross-material:cancel', requestId),
    onStatus: (cb) => {
      const handler = (_event, payload) => cb(payload)
      ipcRenderer.on('cross-material:status', handler)
      return () => ipcRenderer.removeListener('cross-material:status', handler)
    }
  },
  localAI: {
    status: () => ipcRenderer.invoke('localai:status'),
    download: () => ipcRenderer.invoke('localai:download'),
    cancel: () => ipcRenderer.invoke('localai:cancel'),
    onProgress: (cb) => {
      const handler = (_event, payload) => cb(payload)
      ipcRenderer.on('localai:progress', handler)
      return () => ipcRenderer.removeListener('localai:progress', handler)
    }
  },
  models: {
    providers: () => ipcRenderer.invoke('models:providers'),
    config: (role = 'chat') => ipcRenderer.invoke('models:config', role),
    routingStatus: () => ipcRenderer.invoke('models:routing-status'),
    routingSettings: (input) => ipcRenderer.invoke('models:routing-settings', input),
    disconnect: (input) => ipcRenderer.invoke('models:disconnect', input),
    save: (config) => ipcRenderer.invoke('models:save', config),
    list: (config) => ipcRenderer.invoke('models:list', config),
    test: (config) => ipcRenderer.invoke('models:test', config),
    discoverLocal: (role = 'chat') => ipcRenderer.invoke('models:discover-local', role),
    autoDetect: (input) => ipcRenderer.invoke('models:auto-detect', input),
    cliStatus: () => ipcRenderer.invoke('models:cli-status'),
    refreshCatalog: () => ipcRenderer.invoke('models:refresh-catalog'),
    bundledStatus: () => ipcRenderer.invoke('models:bundled-status'),
    startBundled: () => ipcRenderer.invoke('models:start-bundled'),
    stopBundled: () => ipcRenderer.invoke('models:stop-bundled'),
    quickSwitch: (input) => ipcRenderer.invoke('models:quick-switch', input)
  },
  mediaBatch: {
    run: (input) => ipcRenderer.invoke('media:batch', input),
    cancel: (requestId) => ipcRenderer.invoke('media:task-cancel', requestId),
    onProgress: (cb) => {
      const handler = (_event, payload) => cb(payload)
      ipcRenderer.on('media:batch-progress', handler)
      return () => ipcRenderer.removeListener('media:batch-progress', handler)
    }
  },
  mediaTools: {
    planEdit: (input) => ipcRenderer.invoke('media:edit-plan', input),
    planHistory: (input) => ipcRenderer.invoke('media:edit-history-plan', input),
    navigateHistory: (input) => ipcRenderer.invoke('media:edit-history', input),
    trim: (input) => ipcRenderer.invoke('media:trim', input),
    compress: (input) => ipcRenderer.invoke('media:compress', input),
    cancel: (requestId) => ipcRenderer.invoke('media:task-cancel', requestId)
  },
  guide: {
    annotate: (question) => ipcRenderer.invoke('guide:annotate', question),
    askFrame: (input) => ipcRenderer.invoke('guide:askFrame', input),
    dismiss: () => ipcRenderer.invoke('guide:dismiss')
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
    readDataUrl: (filePath) => ipcRenderer.invoke('files:readDataUrl', filePath),
    getPathForFile: (file) => webUtils.getPathForFile(file)
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
    cast: (deviceId, filePath) => ipcRenderer.invoke('cast:cast', deviceId, filePath),
    stop: (deviceId) => ipcRenderer.invoke('cast:stop', deviceId),
    pause: (deviceId) => ipcRenderer.invoke('cast:pause', deviceId),
    resume: (deviceId) => ipcRenderer.invoke('cast:resume', deviceId),
    seek: (deviceId, seconds) => ipcRenderer.invoke('cast:seek', deviceId, seconds),
    status: (deviceId) => ipcRenderer.invoke('cast:status', deviceId),
    smartScan: () => ipcRenderer.invoke('cast:smart-scan'),
    ensureFirewall: () => ipcRenderer.invoke('cast:ensure-firewall'),
    allowFirewall: () => ipcRenderer.invoke('cast:allow-firewall')
  },
  tmdb: {
    search: (name) => ipcRenderer.invoke('tmdb:search', name)
  },
  serviceCredentials: {
    status: () => ipcRenderer.invoke('serviceCredentials:status'),
    save: (input) => ipcRenderer.invoke('serviceCredentials:save', input)
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
    refresh: () => ipcRenderer.invoke('plugin:refresh'),
    install: () => ipcRenderer.invoke('plugin:install'),
    setEnabled: (input) => ipcRenderer.invoke('plugin:setEnabled', input),
    remove: (input) => ipcRenderer.invoke('plugin:remove', input),
    openFolder: () => ipcRenderer.invoke('plugin:openFolder')
  },
  media: {
    analyze: (dir) => ipcRenderer.invoke('media:analyze', dir),
    dedup: (input) => ipcRenderer.invoke('media:dedup', input),
    cancel: (requestId) => ipcRenderer.invoke('media:task-cancel', requestId),
    onDedupProgress: (cb) => {
      const handler = (_event, payload) => cb(payload)
      ipcRenderer.on('media:dedup-progress', handler)
      return () => ipcRenderer.removeListener('media:dedup-progress', handler)
    },
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
    generateVideo: (input) => ipcRenderer.invoke('studio:generate-video', input),
    recutShort: (input) => ipcRenderer.invoke('studio:recut-short', input),
    cancelTask: (requestId) => ipcRenderer.invoke('studio:task-cancel', requestId),
    onRecutProgress: (cb) => {
      const handler = (_event, payload) => cb(payload)
      ipcRenderer.on('studio:recut-progress', handler)
      return () => ipcRenderer.removeListener('studio:recut-progress', handler)
    },
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
    search: (name) => ipcRenderer.invoke('subtitle:search', name),
    download: (fileId) => ipcRenderer.invoke('subtitle:download', fileId)
  },
  transcribe: {
    status: () => ipcRenderer.invoke('transcribe:status'),
    download: () => ipcRenderer.invoke('transcribe:download'),
    downloadSmall: () => ipcRenderer.invoke('transcribe:download-small'),
    cancelDownloadSmall: () => ipcRenderer.invoke('transcribe:cancel-download-small'),
    blob: (input) => ipcRenderer.invoke('transcribe:blob', input),
    cancelDownload: () => ipcRenderer.invoke('transcribe:cancel-download'),
    onProgress: (cb) => {
      const handler = (_event, payload) => cb(payload)
      ipcRenderer.on('transcribe:progress', handler)
      return () => ipcRenderer.removeListener('transcribe:progress', handler)
    }
  },
  siteVideo: {
    status: () => ipcRenderer.invoke('media:site-status'),
    downloadComponent: () => ipcRenderer.invoke('media:site-download-component'),
    cancelComponent: () => ipcRenderer.invoke('media:site-cancel-component'),
    download: (input) => ipcRenderer.invoke('media:site-download', input),
    importCookies: () => ipcRenderer.invoke('media:site-import-cookies'),
    cookiesStatus: () => ipcRenderer.invoke('media:site-cookies-status'),
    login: (input) => ipcRenderer.invoke('media:site-login', input),
    onComponentProgress: (cb) => {
      const handler = (_event, payload) => cb(payload)
      ipcRenderer.on('media:site-component-progress', handler)
      return () => ipcRenderer.removeListener('media:site-component-progress', handler)
    }
  },
  mirror: {
    startReceiver: () => ipcRenderer.invoke('mirror:start-receiver'),
    stopReceiver: () => ipcRenderer.invoke('mirror:stop-receiver'),
    scan: () => ipcRenderer.invoke('mirror:scan'),
    startSender: (input) => ipcRenderer.invoke('mirror:start-sender', input),
    stopSender: () => ipcRenderer.invoke('mirror:stop-sender'),
    status: () => ipcRenderer.invoke('mirror:status')
  },
  mediaDownload: {
    detect: (text) => ipcRenderer.invoke('media:download-detect', text),
    download: (input) => ipcRenderer.invoke('media:download', input),
    linkAnalysis: (input) => ipcRenderer.invoke('media:link-analysis', input),
    cancel: (requestId) => ipcRenderer.invoke('media:download-cancel', requestId),
    onStatus: (cb) => {
      const handler = (_event, payload) => cb(payload)
      ipcRenderer.on('media:download-status', handler)
      return () => ipcRenderer.removeListener('media:download-status', handler)
    }
  },
  taskRuntime: {
    list: () => ipcRenderer.invoke('taskRuntime:list'),
    approve: (input) => ipcRenderer.invoke('taskRuntime:approve', input),
    resume: (input) => ipcRenderer.invoke('taskRuntime:resume', input),
    cancel: (id) => ipcRenderer.invoke('taskRuntime:cancel', id),
    onEvent: (cb) => {
      const handler = (_event, payload) => cb(payload)
      ipcRenderer.on('task-runtime:event', handler)
      return () => ipcRenderer.removeListener('task-runtime:event', handler)
    }
  },
  onlineMedia: {
    search: (input) => ipcRenderer.invoke('onlineMedia:search', input),
    files: (input) => ipcRenderer.invoke('onlineMedia:files', input),
    bookFiles: (input) => ipcRenderer.invoke('onlineMedia:bookFiles', input),
    download: (input) => ipcRenderer.invoke('onlineMedia:download', input),
    cancel: (requestId) => ipcRenderer.invoke('onlineMedia:cancel', requestId),
    onProgress: (callback) => {
      const handler = (_event, data) => callback(data)
      ipcRenderer.on('onlineMedia:progress', handler)
      return () => ipcRenderer.removeListener('onlineMedia:progress', handler)
    }
  },
  ebook: {
    open: (input) => ipcRenderer.invoke('ebook:open', input),
    chapter: (input) => ipcRenderer.invoke('ebook:chapter', input),
    translate: (input) => ipcRenderer.invoke('ebook:translate', input),
    onTranslateStatus: (callback) => {
      const handler = (_event, data) => callback(data)
      ipcRenderer.on('ebook:translate-status', handler)
      return () => ipcRenderer.removeListener('ebook:translate-status', handler)
    }
  },
  rapidocrPack: {
    status: () => ipcRenderer.invoke('rapidocrPack:status'),
    download: () => ipcRenderer.invoke('rapidocrPack:download'),
    cancelDownload: () => ipcRenderer.invoke('rapidocrPack:cancel-download'),
    onProgress: (callback) => {
      const handler = (_event, data) => callback(data)
      ipcRenderer.on('rapidocrPack:progress', handler)
      return () => ipcRenderer.removeListener('rapidocrPack:progress', handler)
    }
  },
  unlimitedOcr: {
    status: (input = {}) => ipcRenderer.invoke('unlimitedOcr:status', input),
    save: (input) => ipcRenderer.invoke('unlimitedOcr:save', input)
  },
  translatePack: {
    status: () => ipcRenderer.invoke('translatePack:status'),
    download: () => ipcRenderer.invoke('translatePack:download'),
    cancelDownload: () => ipcRenderer.invoke('translatePack:cancel-download'),
    onProgress: (cb) => {
      const handler = (_event, payload) => cb(payload)
      ipcRenderer.on('translatePack:progress', handler)
      return () => ipcRenderer.removeListener('translatePack:progress', handler)
    }
  },
  subtitleBilingual: {
    generate: (input) => ipcRenderer.invoke('subtitle:bilingual-generate', input),
    cancel: (requestId) => ipcRenderer.invoke('subtitle:bilingual-cancel', requestId),
    onStatus: (cb) => {
      const handler = (_event, payload) => cb(payload)
      ipcRenderer.on('subtitle:bilingual-status', handler)
      return () => ipcRenderer.removeListener('subtitle:bilingual-status', handler)
    }
  },
  detectLanguage: (filePath) => ipcRenderer.invoke('media:detect-language', filePath),
  subtitleLive: {
    start: (input) => ipcRenderer.invoke('subtitle:live-start', input),
    startTranscribe: (input) => ipcRenderer.invoke('subtitle:live-transcribe-start', input),
    seek: (input) => ipcRenderer.invoke('subtitle:live-seek', input),
    stop: (requestId) => ipcRenderer.invoke('subtitle:live-stop', requestId),
    onEvent: (cb) => {
      const handler = (_event, payload) => cb(payload)
      ipcRenderer.on('subtitle:live-event', handler)
      return () => ipcRenderer.removeListener('subtitle:live-event', handler)
    }
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
    openPath: (filePath) => ipcRenderer.invoke('system:openPath', filePath),
    showInFolder: (filePath) => ipcRenderer.invoke('system:showInFolder', filePath),
    verifyPaths: (filePaths) => ipcRenderer.invoke('system:verifyPaths', filePaths)
  },
  print: {
    file: (filePath) => ipcRenderer.invoke('print:file', filePath),
    text: (filePath) => ipcRenderer.invoke('print:text', filePath),
    html: (html) => ipcRenderer.invoke('print:html', html)
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
    setSubtitlePosition: (position) => ipcRenderer.invoke('mpv:subtitle-position', position),
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

console.log('[preload] AgentPlay desktop API 已注入（含 mpv player）')
