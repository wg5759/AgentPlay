const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

test('AgentPanel is a workflow container with bounded size and extracted surfaces', () => {
  const panel = read('src/components/AgentPanel.tsx')
  assert.ok(panel.split(/\r?\n/).length <= 580, '新任务族接入后 AgentPanel 仍应保持为轻量容器')
  for (const moduleName of ['AgentComposer', 'AgentHome', 'RuntimeSettings', 'useVoiceInput', 'useIncomingFiles', 'useLinkMediaTasks', 'useDocumentAnalysisTasks', 'useCrossMaterialQaTasks', 'useMediaCreativeTasks', 'useContinueTask']) {
    assert.match(panel, new RegExp(`import ${moduleName} from './agent-panel/${moduleName}'`))
  }
  assert.match(panel, /import \{ createIntentRouter \} from '.\/agent-panel\/intentRouter'/)
  assert.match(panel, /import \{ createTaskCommandDispatcher \} from '.\/agent-panel\/taskCommandDispatcher'/)
  assert.doesNotMatch(panel, /localStorage\.getItem\('aiplayer_tmdb_key'\)/)
  assert.doesNotMatch(panel, /new MediaRecorder\(/)
})

test('intent router owns deterministic priority and graceful detector fallback', () => {
  const panel = read('src/components/AgentPanel.tsx')
  const router = read('src/components/agent-panel/intentRouter.ts')
  assert.doesNotMatch(panel, /mediaDownload\.detect|analysis\.detect|libraryIntents/)
  const orderedMarkers = [
    'BATCH_SCOPE_INTENT.test(text)',
    'await runCrossMaterialQuestion(text)',
    'await runDocumentTask()',
    'isVideoGenerationIntent(text)',
    'window.aiPlayer?.mediaTools',
    "DEDUP_INTENT.test(text)",
    'LIBRARY_INTENTS.find',
    'window.aiPlayer.mediaDownload.detect(text)',
    'window.aiPlayer.analysis.detect(text)',
    'void send()'
  ]
  let previous = -1
  for (const marker of orderedMarkers) {
    const current = router.indexOf(marker)
    assert.ok(current > previous, `路由顺序缺失或错位：${marker}`)
    previous = current
  }
  assert.match(router, /catch \{ \/\* 链接检测失败时继续当前视频分析 \*\/ \}/)
  assert.match(router, /catch \{ \/\* 视频检测失败时退回普通对话 \*\/ \}/)
  assert.match(router, /setLinkChoice\(buildLinkChoice\(detection, text\)\)/)
  assert.doesNotMatch(panel, /if \(attachments\.length > 0\) \{[\s\S]{0,100}runDocTask\(\)/)
})

test('task command dispatcher owns stored retry, foreground retry and confirmed cancellation', () => {
  const panel = read('src/components/AgentPanel.tsx')
  const dispatcher = read('src/components/agent-panel/taskCommandDispatcher.ts')
  assert.doesNotMatch(panel, /mediaDownload\?\.cancel|analysis\?\.cancel|mediaBatch\?\.cancel|mediaTools\?\.cancel|studio\?\.cancelTask/)
  assert.doesNotMatch(panel, /retry\.kind === 'download'|retryStoredMediaCreative\(retry\)/)
  for (const kind of ['download', 'link-analysis', 'analysis', 'outcome', 'cross-qa', 'dedup', 'batch', 'compress', 'video-gen', 'recut', 'doc']) {
    assert.match(dispatcher, new RegExp(`case '${kind}':`), `${kind} 必须有显式取消或重试路由`)
  }
  assert.match(dispatcher, /if \(!cancelled\) throw new Error\('后台没有确认取消，任务状态保持不变'\)/)
  assert.match(dispatcher, /updateTask\(taskId, \{ phase: 'cancelled'/)
  assert.match(dispatcher, /retryActiveLinkTask\(\)/)
  assert.match(dispatcher, /retryActiveDocumentAnalysis\(\)/)
  assert.match(dispatcher, /retryActiveMediaCreative\(\)/)
  assert.match(dispatcher, /retryStoredAnalysisTask\(retry\)/)
  assert.match(dispatcher, /retryStoredMediaCreative\(retry\)/)
})

test('media and creative task family owns execution, progress and retry-safe inputs', () => {
  const panel = read('src/components/AgentPanel.tsx')
  const mediaCreativeTasks = read('src/components/agent-panel/useMediaCreativeTasks.ts')
  for (const implementation of [
    /studio\?\.recutShort/,
    /studio\?\.generateVideo/,
    /mediaBatch\?\.run/,
    /mediaTools\?\.compress/,
    /media\?\.dedup/,
    /media\?\.onDedupProgress/
  ]) assert.doesNotMatch(panel, implementation)
  for (const kind of ['recut', 'video-gen', 'batch', 'compress', 'dedup']) {
    assert.match(mediaCreativeTasks, new RegExp(`pendingTaskRef\\.current = '${kind}'`))
  }
  assert.match(mediaCreativeTasks, /const recutInputRef = useRef/)
  assert.match(mediaCreativeTasks, /const batchInputRef = useRef/)
  assert.match(mediaCreativeTasks, /const compressInputRef = useRef/)
  assert.match(mediaCreativeTasks, /const videoGenInstructionRef = useRef/)
  assert.match(mediaCreativeTasks, /const dedupInstructionRef = useRef/)
  assert.match(mediaCreativeTasks, /media\?\.onDedupProgress/)
  assert.match(mediaCreativeTasks, /bindCancelableRequest\(requestId\)/)
  assert.match(mediaCreativeTasks, /retryActiveTask/)
  assert.match(mediaCreativeTasks, /runRecutShort\(recutInputRef\.current, true\)/)
  assert.match(mediaCreativeTasks, /runBatchTask\(batchInputRef\.current\.instruction, batchInputRef\.current\.targets\)/)
  assert.match(mediaCreativeTasks, /runCompressTask\(compressInputRef\.current\.instruction, compressInputRef\.current\)/)
  assert.match(panel, /retryActiveMediaCreative/)
})

test('document and local-video analysis family owns approval-safe instruction state', () => {
  const panel = read('src/components/AgentPanel.tsx')
  const workspaceTasks = read('src/components/agent-panel/useDocumentAnalysisTasks.ts')
  assert.doesNotMatch(panel, /docInstructionRef|analysisInstructionRef|analysisFormatRef/)
  assert.doesNotMatch(panel, /documents\?\.onStatus|analysis\?\.onStatus/)
  assert.doesNotMatch(panel, /api\.run\(\{ tokens, instruction, outputFormat/)
  assert.match(workspaceTasks, /const docInstructionRef = useRef\(''\)/)
  assert.match(workspaceTasks, /const analysisInstructionRef = useRef\(''\)/)
  assert.match(workspaceTasks, /const analysisFormatRef = useRef\('docx'\)/)
  assert.match(workspaceTasks, /pendingTaskRef\.current = 'doc'/)
  assert.match(workspaceTasks, /pendingTaskRef\.current = 'analysis'/)
  assert.match(workspaceTasks, /bindCancelableRequest\(requestId\)/)
  assert.match(workspaceTasks, /phase: 'waiting', status: '等待允许云端处理'/)
  assert.match(workspaceTasks, /runAnalysisTask\(false, analysisInstructionRef\.current\)/)
  assert.match(workspaceTasks, /runDocumentTask\(false, docInstructionRef\.current\)/)
  assert.match(workspaceTasks, /runAnalysisTask\(true\)/)
  assert.match(workspaceTasks, /runDocumentTask\(true\)/)
  assert.match(workspaceTasks, /completeExecutionTask\(/)
  assert.match(workspaceTasks, /failExecutionTask\(/)
})

test('link media task family owns download, approval resume and site login state', () => {
  const panel = read('src/components/AgentPanel.tsx')
  const linkTasks = read('src/components/agent-panel/useLinkMediaTasks.ts')
  assert.doesNotMatch(panel, /siteVideo\?\.download|linkAnalysisVideoRef|downloadDirectRef/)
  assert.match(linkTasks, /pendingTaskRef\.current = 'download'/)
  assert.match(linkTasks, /pendingTaskRef\.current = 'link-analysis'/)
  assert.match(linkTasks, /bindCancelableRequest\(requestId\)/)
  assert.match(linkTasks, /videoPath: forceApprove \? linkAnalysisVideoRef\.current : undefined/)
  assert.match(linkTasks, /if \(!forceApprove\) linkAnalysisVideoRef\.current = ''/)
  assert.match(linkTasks, /linkAnalysisVideoRef\.current = result\.videoPath \|\| ''/)
  assert.match(linkTasks, /const analyzedVideoPath = result\.videoPath \|\| linkAnalysisVideoRef\.current/)
  assert.match(linkTasks, /pendingTaskRef\.current === 'link-analysis' \? linkAnalysisUrlRef\.current : downloadUrlRef\.current/)
  assert.match(linkTasks, /completeExecutionTask\(/)
  assert.match(linkTasks, /failExecutionTask\(/)
})

test('runtime credentials and voice capture keep their safety boundaries after extraction', () => {
  const settings = read('src/components/agent-panel/RuntimeSettings.tsx')
  const voice = read('src/components/agent-panel/useVoiceInput.ts')
  assert.match(settings, /serviceCredentials\?\.status\(\)/)
  assert.match(settings, /localStorage\.removeItem\('aiplayer_tmdb_key'\)/)
  assert.match(settings, /localStorage\.removeItem\('aiplayer_subtitle_key'\)/)
  assert.match(settings, /更改 AI 使用方式/)
  assert.doesNotMatch(settings, /models\?\.quickSwitch/)
  assert.match(voice, /new MediaRecorder\(stream\)/)
  assert.match(voice, /transcribe\?\.blob/)
  assert.match(voice, /if \(cancelled\) return/)
  assert.match(voice, /25 \* 1024 \* 1024/)
})

test('extracted presentation modules do not own workflow execution', () => {
  const presentation = [
    read('src/components/agent-panel/AgentComposer.tsx'),
    read('src/components/agent-panel/AgentHome.tsx'),
    read('src/components/agent-panel/suggestions.ts')
  ].join('\n')
  assert.doesNotMatch(presentation, /startTask\(|mediaDownload\?\.|documents\?\.(?:run|plan)/)
})
