const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { MediaEditProjectStore } = require('../electron/media-edit-project-store')

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-edit-project-'))
  const sourcePath = path.join(root, 'source.mp4')
  const outputPath = path.join(root, 'source-trimmed.mp4')
  fs.writeFileSync(sourcePath, Buffer.concat([Buffer.from('source'), Buffer.alloc(2048)]))
  fs.writeFileSync(outputPath, Buffer.concat([Buffer.from('trimmed'), Buffer.alloc(2048)]))
  return { root, sourcePath, outputPath }
}

test('a completed trim becomes a non-destructive project version that can undo to the source', () => {
  const { root, sourcePath, outputPath } = fixture()
  try {
    const store = new MediaEditProjectStore({ rootDir: path.join(root, 'state') })
    const capsule = store.recordTrim({
      taskId: 'trim-1',
      sourcePath,
      outputPath,
      decision: { schemaVersion: 1, kind: 'media.trim', timeline: { startSeconds: 4, endSeconds: 20, durationSeconds: 16 } }
    })

    assert.equal(capsule.currentPath, outputPath)
    assert.equal(capsule.versionCount, 2)
    assert.equal(capsule.canUndo, true)
    assert.equal(capsule.canRedo, false)

    const undone = store.navigate({ currentPath: outputPath, direction: 'undo' })
    assert.equal(undone.success, true)
    assert.equal(undone.currentPath, sourcePath)
    assert.equal(undone.canUndo, false)
    assert.equal(undone.canRedo, true)
    assert.equal(fs.existsSync(sourcePath), true)
    assert.equal(fs.existsSync(outputPath), true, 'undo must not delete the generated version')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('navigate falls back to the most recent project when current file owns no history (subtitle-shift anchor case)', () => {
  const { root, sourcePath, outputPath } = fixture()
  try {
    const store = new MediaEditProjectStore({ rootDir: path.join(root, 'state') })
    store.recordTrim({
      taskId: 'shift-1',
      sourcePath,
      outputPath,
      decision: { schemaVersion: 1, kind: 'media.shift-subtitles', subtitle: { path: sourcePath }, shift: { direction: 'later', offsetSeconds: 2 } }
    })
    // 当前文件（如正在播放的视频）不在任何编辑项目里：撤销落到最近项目的当前游标
    const unrelated = path.join(root, '正在播放的视频.mp4')
    fs.writeFileSync(unrelated, Buffer.alloc(1024))
    const undone = store.navigate({ currentPath: unrelated, direction: 'undo' })
    assert.equal(undone.success, true)
    assert.equal(undone.currentPath, sourcePath, '撤销应回到最近项目的上一版（源字幕）')
    assert.equal(undone.canRedo, true)
    const redone = store.navigate({ currentPath: unrelated, direction: 'redo' })
    assert.equal(redone.success, true)
    assert.equal(redone.currentPath, outputPath)
    // 游标在最早版本时继续撤销：故障关闭且不改动状态
    store.navigate({ currentPath: outputPath, direction: 'undo' })
    const earliest = store.navigate({ currentPath: unrelated, direction: 'undo' })
    assert.equal(earliest.success, false)
    assert.match(earliest.error, /已经是最早版本/)
    // 完全没有任何项目时：保持旧报错
    const empty = new MediaEditProjectStore({ rootDir: path.join(root, 'state-empty') })
    const none = empty.navigate({ currentPath: unrelated, direction: 'undo' })
    assert.equal(none.success, false)
    assert.match(none.error, /还没有可撤销的编辑历史/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('corrupt project history fails closed and is never silently overwritten', () => {
  const { root, sourcePath, outputPath } = fixture()
  try {
    const stateDir = path.join(root, 'state')
    fs.mkdirSync(stateDir, { recursive: true })
    const statePath = path.join(stateDir, 'media-edit-projects-v1.json')
    fs.writeFileSync(statePath, '{ broken history', 'utf8')
    const store = new MediaEditProjectStore({ rootDir: stateDir })

    assert.throws(() => store.recordTrim({
      taskId: 'trim-corrupt', sourcePath, outputPath,
      decision: { schemaVersion: 1, kind: 'media.trim', timeline: { startSeconds: 4, endSeconds: 20, durationSeconds: 16 } }
    }), /编辑项目历史损坏/)
    assert.equal(fs.readFileSync(statePath, 'utf8'), '{ broken history')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a new edit cannot branch from a historical version changed by another program', () => {
  const { root, sourcePath, outputPath } = fixture()
  try {
    const store = new MediaEditProjectStore({ rootDir: path.join(root, 'state') })
    const decision = { schemaVersion: 1, kind: 'media.trim', timeline: { startSeconds: 4, endSeconds: 20, durationSeconds: 16 } }
    store.recordTrim({ taskId: 'trim-1', sourcePath, outputPath, decision })
    store.navigate({ currentPath: outputPath, direction: 'undo' })
    fs.appendFileSync(sourcePath, Buffer.from('changed-outside-agentplay'))
    const nextOutput = path.join(root, 'source-second-trim.mp4')
    fs.writeFileSync(nextOutput, Buffer.concat([Buffer.from('second'), Buffer.alloc(2048)]))

    assert.throws(
      () => store.recordTrim({ taskId: 'trim-2', sourcePath, outputPath: nextOutput, decision }),
      /编辑版本文件已发生变化/
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('redo survives an app restart and an alternate edit replaces the abandoned redo branch', () => {
  const { root, sourcePath, outputPath } = fixture()
  try {
    const stateDir = path.join(root, 'state')
    const decision = { schemaVersion: 1, kind: 'media.trim', timeline: { startSeconds: 4, endSeconds: 20, durationSeconds: 16 } }
    const first = new MediaEditProjectStore({ rootDir: stateDir })
    first.recordTrim({ taskId: 'trim-1', sourcePath, outputPath, decision })
    first.navigate({ currentPath: outputPath, direction: 'undo' })

    const afterRestart = new MediaEditProjectStore({ rootDir: stateDir })
    assert.equal(afterRestart.navigate({ currentPath: sourcePath, direction: 'redo' }).currentPath, outputPath)
    afterRestart.navigate({ currentPath: outputPath, direction: 'undo' })
    const alternatePath = path.join(root, 'source-alternate.mp4')
    fs.writeFileSync(alternatePath, Buffer.concat([Buffer.from('alternate'), Buffer.alloc(2048)]))
    afterRestart.recordTrim({ taskId: 'trim-2', sourcePath, outputPath: alternatePath, decision })
    afterRestart.navigate({ currentPath: alternatePath, direction: 'undo' })

    const redone = afterRestart.navigate({ currentPath: sourcePath, direction: 'redo' })
    assert.equal(redone.currentPath, alternatePath)
    assert.notEqual(redone.currentPath, outputPath)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a removed-segment result enters the same project and remains undoable', () => {
  const { root, sourcePath, outputPath } = fixture()
  try {
    const store = new MediaEditProjectStore({ rootDir: path.join(root, 'state') })
    const capsule = store.recordEdit({
      taskId: 'remove-1',
      sourcePath,
      outputPath,
      decision: { schemaVersion: 1, kind: 'media.remove-segment', timeline: { startSeconds: 4, endSeconds: 20, removedDurationSeconds: 16 } }
    })

    assert.equal(capsule.currentPath, outputPath)
    assert.equal(capsule.versionCount, 2)
    assert.equal(store.navigate({ currentPath: outputPath, direction: 'undo' }).currentPath, sourcePath)
    const persisted = JSON.parse(fs.readFileSync(path.join(root, 'state', 'media-edit-projects-v1.json'), 'utf8'))
    assert.equal(persisted.projects[0].versions[1].kind, 'remove-segment')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a reordered concat result is persisted as its own undoable edit version', () => {
  const { root, sourcePath, outputPath } = fixture()
  try {
    const stateDir = path.join(root, 'state')
    const decision = {
      schemaVersion: 1,
      kind: 'media.concat-segments',
      timeline: {
        segments: [
          { sourceStartSeconds: 8, sourceEndSeconds: 12, durationSeconds: 4, targetStartSeconds: 0, targetEndSeconds: 4 },
          { sourceStartSeconds: 0, sourceEndSeconds: 4, durationSeconds: 4, targetStartSeconds: 4, targetEndSeconds: 8 }
        ],
        durationSeconds: 8
      }
    }
    const store = new MediaEditProjectStore({ rootDir: stateDir })
    const capsule = store.recordEdit({ taskId: 'concat-1', sourcePath, outputPath, decision })

    assert.equal(capsule.versionCount, 2)
    assert.equal(store.navigate({ currentPath: outputPath, direction: 'undo' }).currentPath, sourcePath)
    const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, 'media-edit-projects-v1.json'), 'utf8'))
    assert.equal(persisted.projects[0].versions[1].kind, 'concat-segments')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a repeated task validates its recorded artifact and only an explicit quality repair may refresh it', () => {
  const { root, sourcePath, outputPath } = fixture()
  try {
    const stateDir = path.join(root, 'state')
    const decision = { schemaVersion: 1, kind: 'media.remove-segment', timeline: { startSeconds: 4, endSeconds: 20, removedDurationSeconds: 16 } }
    const store = new MediaEditProjectStore({ rootDir: stateDir })
    const first = store.recordEdit({ taskId: 'remove-repair', sourcePath, outputPath, decision })
    fs.appendFileSync(outputPath, Buffer.from('failed-quality-artifact'))

    assert.throws(
      () => store.recordEdit({ taskId: 'remove-repair', sourcePath, outputPath, decision }),
      /编辑版本文件已发生变化/
    )

    const repaired = store.recordEdit({ taskId: 'remove-repair', sourcePath, outputPath, decision, repairing: true })
    assert.equal(repaired.versionId, first.versionId, 'quality repair must update the same task version instead of duplicating history')
    assert.equal(repaired.versionCount, 2)
    const restarted = new MediaEditProjectStore({ rootDir: stateDir })
    assert.equal(restarted.navigate({ currentPath: outputPath, direction: 'undo' }).currentPath, sourcePath)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
