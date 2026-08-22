const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { agentPanelSource } = require('./helpers/agent-panel-source')
const { Readable } = require('node:stream')

const { analyzeDirAsync, findDuplicates, hashFile } = require('../electron/media-service')

const root = path.join(__dirname, '..')
const source = (file) => fs.readFileSync(path.join(root, file), 'utf8')

test('creative polling delay aborts immediately instead of waiting for the next poll', async () => {
  const { abortableDelay } = require('../electron/creative-studio-service')
  const controller = new AbortController()
  const started = Date.now()
  const pending = abortableDelay(60_000, controller.signal)
  controller.abort()
  await assert.rejects(pending, /已取消/)
  assert.ok(Date.now() - started < 1000, '取消不应等待轮询间隔结束')
})

test('compress and batch jobs use persistent cancellation and atomic output files', () => {
  const main = source('electron/main.js')
  assert.match(main, /register\('media\.batch'/)
  assert.match(main, /register\('media\.compress'/)
  assert.match(main, /ipcMain\.handle\('media:task-cancel'/)
  assert.match(main, /persistentTaskRuntime\.cancel\(String\(requestId \|\| ''\)\)/)
  assert.match(main, /compressOne\([\s\S]{0,300}\{ signal, outputPath \}/)
  assert.match(main, /transcriptionService\.transcribe\(\{[\s\S]{0,300}signal \}/)
  assert.match(main, /videoFrames\.run\(args, \{ timeoutMs: 30 \* 60 \* 1000, signal \}\)/)
  assert.match(main, /fs\.renameSync\(tempPath, outputPath\)/)
  assert.match(main, /if \(fs\.existsSync\(tempPath\)\) fs\.rmSync\(tempPath, \{ force: true \}\)/)
})

test('duplicate hash abort destroys the active read stream instead of finishing the file', async () => {
  const controller = new AbortController()
  let chunks = 0
  let destroyed = false
  const stream = new Readable({
    read() {
      setTimeout(() => {
        if (this.destroyed) return
        chunks += 1
        this.push(chunks <= 100 ? Buffer.alloc(256 * 1024, chunks) : null)
      }, 5)
    },
    destroy(error, callback) {
      destroyed = true
      callback(error)
    }
  })
  const pending = hashFile('slow-fixture.bin', {
    signal: controller.signal,
    createReadStream: () => stream,
    onProgress: ({ bytesRead }) => {
      if (bytesRead >= 512 * 1024) controller.abort()
    }
  })
  await assert.rejects(pending, /已取消/)
  assert.equal(destroyed, true)
  assert.ok(chunks < 100, `aborted hash still consumed ${chunks} chunks`)
})

test('duplicate directory enumeration and candidate hashing stop at the abort boundary', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-dedup-cancel-'))
  try {
    for (let index = 0; index < 30; index += 1) fs.writeFileSync(path.join(dir, `clip-${index}.mp4`), 'same-size')
    const scanController = new AbortController()
    let scanned = 0
    await assert.rejects(analyzeDirAsync(dir, {
      signal: scanController.signal,
      onProgress: (progress) => {
        scanned = progress.filesScanned
        if (scanned === 5) scanController.abort()
      }
    }), /已取消/)
    assert.equal(scanned, 5)

    const hashController = new AbortController()
    let hashCalls = 0
    await assert.rejects(findDuplicates(
      Array.from({ length: 20 }, (_, index) => ({ path: `clip-${index}.mp4`, name: `clip-${index}.mp4`, size: 1024 })),
      {
        signal: hashController.signal,
        hashFileImpl: async () => `hash-${hashCalls++}`,
        onProgress: (progress) => {
          if (progress.processedFiles === 2) hashController.abort()
        }
      }
    ), /已取消/)
    assert.equal(hashCalls, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('duplicate hashing resumes from cache only when size and mtime still match', async () => {
  const files = [
    { path: 'a.mp4', name: 'a.mp4', size: 10, mtimeMs: 100 },
    { path: 'b.mp4', name: 'b.mp4', size: 10, mtimeMs: 100 }
  ]
  let calls = 0
  const checkpointed = []
  const duplicates = await findDuplicates(files, {
    hashCache: { 'a.mp4': { hash: 'same', size: 10, mtimeMs: 100 } },
    hashFileImpl: async () => { calls += 1; return 'same' },
    onFileHashed: (file, hash) => checkpointed.push({ file: file.path, hash })
  })
  assert.equal(calls, 1)
  assert.deepEqual(checkpointed, [{ file: 'b.mp4', hash: 'same' }])
  assert.equal(duplicates.length, 1)
})

test('AI video and recut jobs share request-scoped creative cancellation', () => {
  const main = source('electron/main.js')
  const service = source('electron/creative-studio-service.js')
  assert.match(main, /ipcMain\.handle\('studio:task-cancel'/)
  assert.match(main, /persistentTaskRuntime\.cancel\(String\(requestId \|\| ''\)\)/)
  assert.match(main, /generateVideoWithReceipt\(config, \{[\s\S]{0,320}signal/)
  assert.match(main, /generateVideoWithReceipt = async[\s\S]{0,260}generateVideoAsset\(config, input\)/)
  assert.match(main, /videoFrames\.run\([^;]+\{ timeoutMs: 300000, signal \}/)
  assert.match(service, /input\.signal\.addEventListener\('abort', onOuterAbort/)
  assert.match(service, /await abortableDelay\(13000, controller\.signal\)/)
})

test('preload, renderer and types bind cancellation to the active task id', () => {
  const preload = source('electron/preload.js')
  const panel = agentPanelSource()
  const dispatcher = source('src/components/agent-panel/taskCommandDispatcher.ts')
  const types = source('src/types/global.d.ts')
  assert.match(preload, /mediaBatch:[\s\S]{0,260}cancel: \(requestId\) => ipcRenderer\.invoke\('media:task-cancel', requestId\)/)
  assert.match(preload, /mediaTools:[\s\S]{0,600}cancel: \(requestId\) => ipcRenderer\.invoke\('media:task-cancel', requestId\)/)
  assert.match(preload, /cancelTask: \(requestId\) => ipcRenderer\.invoke\('studio:task-cancel', requestId\)/)
  for (const kind of ['batch', 'compress', 'trim', 'video-gen', 'recut']) {
    assert.ok(panel.includes(`pendingTaskRef.current = '${kind}'`), `${kind} 必须登记取消路由`)
  }
  assert.ok((panel.match(/bindCancelableRequest\(requestId\)/g) || []).length >= 8)
  assert.match(dispatcher, /case 'batch':[\s\S]{0,160}mediaBatch\?\.cancel\(requestId\)/)
  assert.match(dispatcher, /case 'compress':[\s\S]{0,160}mediaTools\?\.cancel\(requestId\)/)
  assert.match(dispatcher, /case 'video-gen':[\s\S]{0,80}case 'recut':[\s\S]{0,160}studio\?\.cancelTask\(requestId\)/)
  assert.match(types, /compress: \(input: \{ sourcePath: string;[\s\S]{0,160}requestId: string/)
  assert.match(types, /cancelTask: \(requestId: string\) => Promise<boolean>/)
})

test('media and creative failures retry their own saved inputs instead of falling through to documents', () => {
  const panel = agentPanelSource()
  const taskHook = source('src/components/agent-panel/useMediaCreativeTasks.ts')
  for (const kind of ['batch', 'compress', 'video-gen', 'dedup', 'recut']) {
    assert.match(taskHook, new RegExp(`case '${kind}':`), `${kind} 必须拥有显式活动重试分支`)
  }
  assert.match(panel, /retryActiveMediaCreative\(\)/)
  assert.match(panel, /retryActiveDocumentAnalysis\(\)/)
})

test('duplicate scan uses persistent cancellation and reports progress', () => {
  const main = source('electron/main.js')
  const preload = source('electron/preload.js')
  const panel = agentPanelSource()
  const dispatcher = source('src/components/agent-panel/taskCommandDispatcher.ts')
  const types = source('src/types/global.d.ts')
  assert.match(main, /register\('media\.dedup'/)
  assert.match(main, /normalizeRequestId\(request\.requestId, 'media-dedup'\)/)
  assert.match(main, /analyzeDirAsync\(root, \{ signal/)
  assert.match(main, /findDuplicates\(files, \{[\s\S]{0,260}signal/)
  assert.match(main, /media:dedup-progress/)
  assert.match(preload, /media:[\s\S]{0,420}cancel: \(requestId\) => ipcRenderer\.invoke\('media:task-cancel', requestId\)/)
  assert.match(preload, /media:dedup-progress/)
  assert.ok(panel.includes("pendingTaskRef.current = 'dedup'"))
  assert.match(dispatcher, /case 'dedup':[\s\S]{0,160}media\?\.cancel\(requestId\)/)
  assert.match(panel, /media\?\.onDedupProgress/)
  assert.match(types, /dedup: \(input: \{ requestId: string;/)
})

test('quit cleanup aborts every media and creative controller', () => {
  const main = source('electron/main.js')
  const quit = main.slice(main.indexOf("app.on('before-quit'"), main.indexOf("app.on('before-quit'") + 1800)
  assert.match(quit, /activeMediaTasks\.values\(\)\) controller\.abort/)
  assert.match(quit, /activeCreativeTasks\.values\(\)\) controller\.abort/)
})
