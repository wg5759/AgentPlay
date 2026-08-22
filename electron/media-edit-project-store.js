const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

function quickFingerprint(filePath, stat = fs.statSync(filePath), fsImpl = fs) {
  const sampleSize = Math.min(128 * 1024, stat.size)
  const first = Buffer.alloc(sampleSize)
  const last = Buffer.alloc(sampleSize)
  const handle = fsImpl.openSync(filePath, 'r')
  try {
    fsImpl.readSync(handle, first, 0, sampleSize, 0)
    fsImpl.readSync(handle, last, 0, sampleSize, Math.max(0, stat.size - sampleSize))
  } finally {
    fsImpl.closeSync(handle)
  }
  return crypto.createHash('sha256').update(first).update(last).update(String(stat.size)).digest('hex')
}

function editVersionKind(decision) {
  if (decision?.kind === 'media.remove-segment') return 'remove-segment'
  if (decision?.kind === 'media.concat-segments') return 'concat-segments'
  if (decision?.kind === 'media.add-music') return 'add-music'
  if (decision?.kind === 'media.concat-sources') return 'concat-sources'
  if (decision?.kind === 'media.burn-subtitles') return 'burn-subtitles'
  if (decision?.kind === 'media.mux-subtitles') return 'mux-subtitles'
  if (decision?.kind === 'media.translate-subtitles') return 'translate-subtitles'
  if (decision?.kind === 'media.edit-subtitle-cues') return 'edit-subtitle-cues'
  if (decision?.kind === 'media.shift-subtitles') return 'shift-subtitles'
  return 'trim'
}

class MediaEditProjectStore {
  constructor({ rootDir, fsImpl = fs, now = () => Date.now(), idFactory = () => crypto.randomUUID() } = {}) {
    if (!rootDir) throw new Error('编辑项目目录不能为空')
    this.rootDir = path.resolve(rootDir)
    this.statePath = path.join(this.rootDir, 'media-edit-projects-v1.json')
    this.fs = fsImpl
    this.now = now
    this.idFactory = idFactory
    this.loadError = ''
    this.fs.mkdirSync(this.rootDir, { recursive: true })
    this.state = this.load()
  }

  load() {
    if (!this.fs.existsSync(this.statePath)) return { schemaVersion: 1, projects: [] }
    try {
      const parsed = JSON.parse(this.fs.readFileSync(this.statePath, 'utf8'))
      if (parsed?.schemaVersion === 1 && Array.isArray(parsed.projects)) return parsed
    } catch { /* handled below */ }
    this.loadError = '编辑项目历史损坏，已拒绝覆盖；请先备份历史文件后修复'
    return { schemaVersion: 1, projects: [] }
  }

  assertReady() {
    if (this.loadError) throw new Error(this.loadError)
  }

  persist() {
    const tempPath = `${this.statePath}.${process.pid}.tmp`
    this.fs.writeFileSync(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
    this.fs.renameSync(tempPath, this.statePath)
  }

  snapshot(filePath) {
    const resolved = this.fs.realpathSync(path.resolve(String(filePath || '')))
    const stat = this.fs.statSync(resolved)
    if (!stat.isFile()) throw new Error('编辑版本不是文件')
    return {
      path: resolved,
      size: stat.size,
      mtimeMs: Math.trunc(stat.mtimeMs),
      fingerprint: quickFingerprint(resolved, stat, this.fs)
    }
  }

  validate(snapshot) {
    let resolved
    try { resolved = this.fs.realpathSync(path.resolve(String(snapshot?.path || ''))) } catch { throw new Error('编辑版本文件已不存在') }
    const stat = this.fs.statSync(resolved)
    const unchanged = stat.isFile()
      && stat.size === Number(snapshot.size)
      && Math.trunc(stat.mtimeMs) === Number(snapshot.mtimeMs)
      && quickFingerprint(resolved, stat, this.fs) === snapshot.fingerprint
    if (!unchanged) throw new Error(`编辑版本文件已发生变化：${path.basename(resolved)}`)
    return resolved
  }

  capsule(project) {
    const cursor = Math.max(0, Math.min(project.versions.length - 1, Number(project.cursor) || 0))
    const version = project.versions[cursor]
    return {
      schemaVersion: 1,
      projectId: project.id,
      versionId: version.id,
      currentPath: version.artifact.path,
      cursor,
      versionCount: project.versions.length,
      canUndo: cursor > 0,
      canRedo: cursor < project.versions.length - 1
    }
  }

  recordEdit({ taskId, sourcePath, outputPath, decision, repairing = false } = {}) {
    this.assertReady()
    const taskKey = String(taskId || '').trim()
    if (!taskKey) throw new Error('剪辑任务标识不能为空')
    const existingTask = this.state.projects.find((project) => project.versions.some((version) => version.taskId === taskKey))
    if (existingTask) {
      const versionIndex = existingTask.versions.findIndex((version) => version.taskId === taskKey)
      const version = existingTask.versions[versionIndex]
      const source = this.snapshot(sourcePath)
      const previousVersion = existingTask.versions[versionIndex - 1]
      if (!previousVersion || path.resolve(previousVersion.artifact.path) !== path.resolve(source.path)) throw new Error('同一剪辑任务的源版本发生冲突')
      this.validate(previousVersion.artifact)
      const output = this.snapshot(outputPath)
      if (path.resolve(version.artifact.path) !== path.resolve(output.path)) throw new Error('同一剪辑任务的输出位置发生冲突')
      if (JSON.stringify(version.decision) !== JSON.stringify(decision || null)) throw new Error('同一剪辑任务的冻结决策发生冲突')
      if (!repairing) this.validate(version.artifact)
      else {
        version.artifact = output
        version.kind = editVersionKind(decision)
        version.decision = JSON.parse(JSON.stringify(decision || null))
      }
      existingTask.cursor = versionIndex
      existingTask.updatedAt = this.now()
      this.persist()
      return this.capsule(existingTask)
    }

    const source = this.snapshot(sourcePath)
    const output = this.snapshot(outputPath)
    let project = this.state.projects.find((item) => item.versions.some((version) => path.resolve(version.artifact.path) === path.resolve(source.path)))
    const now = this.now()
    if (!project) {
      project = {
        schemaVersion: 1,
        id: `edit-${this.idFactory()}`,
        cursor: 0,
        createdAt: now,
        updatedAt: now,
        versions: [{ id: `version-${this.idFactory()}`, taskId: '', kind: 'source', artifact: source, decision: null, createdAt: now }]
      }
      this.state.projects.push(project)
    }
    const sourceIndex = project.versions.findIndex((version) => path.resolve(version.artifact.path) === path.resolve(source.path))
    if (sourceIndex < 0) throw new Error('剪辑源不属于当前编辑项目')
    this.validate(project.versions[sourceIndex].artifact)
    project.versions = project.versions.slice(0, sourceIndex + 1)
    project.versions.push({
      id: `version-${this.idFactory()}`,
      taskId: taskKey,
      kind: editVersionKind(decision),
      artifact: output,
      decision: JSON.parse(JSON.stringify(decision || null)),
      createdAt: now
    })
    project.cursor = project.versions.length - 1
    project.updatedAt = now
    this.state.projects = this.state.projects.slice(-100)
    this.persist()
    return this.capsule(project)
  }

  recordTrim(input = {}) {
    return this.recordEdit(input)
  }

  navigate({ currentPath, direction } = {}) {
    this.assertReady()
    const resolved = path.resolve(String(currentPath || ''))
    let project = this.state.projects.find((item) => item.versions.some((version) => path.resolve(version.artifact.path) === resolved))
    let currentIndex = project ? project.versions.findIndex((version) => path.resolve(version.artifact.path) === resolved) : -1
    if (!project) {
      // 当前文件不在任何编辑项目里（典型：字幕调时的项目锚在字幕文件而不是当前视频）——
      // “撤销刚才的剪辑”退到最近更新的项目，从其当前版本游标继续
      project = [...this.state.projects].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0]
      if (!project) return { success: false, error: '当前视频还没有可撤销的编辑历史' }
      currentIndex = Math.max(0, Math.min(project.versions.length - 1, Number(project.cursor) || 0))
    }
    const delta = direction === 'redo' ? 1 : direction === 'undo' ? -1 : 0
    if (!delta) return { success: false, error: '编辑历史动作无效' }
    const targetIndex = currentIndex + delta
    if (targetIndex < 0) return { success: false, error: '已经是最早版本，不能再撤销' }
    if (targetIndex >= project.versions.length) return { success: false, error: '没有可以重做的版本' }
    this.validate(project.versions[targetIndex].artifact)
    project.cursor = targetIndex
    project.updatedAt = this.now()
    this.persist()
    return { success: true, action: direction, ...this.capsule(project) }
  }
}

module.exports = { MediaEditProjectStore, quickFingerprint }
