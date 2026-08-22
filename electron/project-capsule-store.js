const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { fingerprintArtifact } = require('./artifact-fingerprint')

const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value))
const kindForPath = (filePath) => {
  const ext = path.extname(String(filePath || '')).toLowerCase()
  if (['.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v', '.wmv', '.flv', '.ts'].includes(ext)) return 'video'
  if (['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac', '.wma'].includes(ext)) return 'audio'
  if (['.srt', '.vtt', '.ass', '.ssa'].includes(ext)) return 'subtitle'
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'].includes(ext)) return 'image'
  if (ext === '.pdf') return 'pdf'
  if (['.doc', '.docx', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf'].includes(ext)) return 'office'
  return 'document'
}

class ProjectCapsuleStore {
  constructor({ rootDir, now = () => Date.now(), idFactory = () => crypto.randomUUID() } = {}) {
    if (!rootDir) throw new Error('项目胶囊目录不能为空')
    this.rootDir = path.resolve(rootDir)
    this.statePath = path.join(this.rootDir, 'project-capsules-v1.json')
    this.backupPath = `${this.statePath}.bak`
    this.now = now
    this.idFactory = idFactory
    this.loadError = ''
    this.loadMode = 'normal'
    this.recoveryInfo = null
    fs.mkdirSync(this.rootDir, { recursive: true })
    this.state = this.load()
    this.finishLoadRecovery()
  }

  emptyState() { return { schemaVersion: 1, projects: [], trash: [] } }

  normalizeProject(project, status = 'active') {
    return {
      ...project,
      schemaVersion: 1,
      status: ['active', 'archived', 'trashed'].includes(project?.status) ? project.status : status,
      materials: Array.isArray(project?.materials) ? project.materials : [],
      artifacts: Array.isArray(project?.artifacts) ? project.artifacts : [],
      references: Array.isArray(project?.references) ? project.references : [],
      instructions: Array.isArray(project?.instructions) ? project.instructions : [],
      revisions: Array.isArray(project?.revisions) ? project.revisions : [],
      current: project?.current && typeof project.current === 'object' ? project.current : null
    }
  }

  normalizeState(parsed) {
    const projects = parsed.projects.map((project) => this.normalizeProject(project))
    const trash = (Array.isArray(parsed.trash) ? parsed.trash : []).map((project) => this.normalizeProject(project, 'trashed'))
    return { ...parsed, schemaVersion: 1, projects, trash }
  }

  parseState(text, { allowLegacy = false } = {}) {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.projects)) return null
    const projects = [...parsed.projects, ...(Array.isArray(parsed.trash) ? parsed.trash : [])]
    const hasProjectIds = projects.every((project) => project && typeof project === 'object' && !Array.isArray(project) && typeof project.id === 'string' && project.id.trim())
    if (!hasProjectIds) return null
    if (parsed.schemaVersion === 1) {
      const complete = projects.every((project) => ['materials', 'artifacts', 'references', 'instructions', 'revisions'].every((key) => Array.isArray(project[key])))
      if (!complete) return null
      return { state: this.normalizeState(parsed), mode: 'normal' }
    }
    if (allowLegacy && parsed.schemaVersion === 0) return { state: this.normalizeState(parsed), mode: 'migrated-v0' }
    return null
  }

  readState(filePath, options) {
    if (!fs.existsSync(filePath)) return null
    try { return this.parseState(fs.readFileSync(filePath, 'utf8'), options) } catch { return null }
  }

  load() {
    if (!fs.existsSync(this.statePath)) return this.emptyState()
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'))
      if (Number(raw?.schemaVersion) > 1) {
        this.loadError = `项目胶囊版本 ${raw.schemaVersion} 高于当前程序可支持版本，已拒绝降级覆盖`
        return this.emptyState()
      }
    } catch { /* malformed primary may still recover from a verified backup */ }
    const primary = this.readState(this.statePath, { allowLegacy: true })
    if (primary) {
      this.loadMode = primary.mode
      return primary.state
    }
    const backup = this.readState(this.backupPath)
    if (backup) {
      this.loadMode = 'recovered-backup'
      return backup.state
    }
    this.loadError = '项目胶囊历史损坏，已拒绝覆盖；请先备份后修复'
    return this.emptyState()
  }

  snapshotPath(kind) {
    const timestamp = Math.trunc(Number(this.now()) || Date.now())
    let candidate = `${this.statePath}.${kind}-${timestamp}`
    let suffix = 1
    while (fs.existsSync(candidate)) candidate = `${this.statePath}.${kind}-${timestamp}-${suffix++}`
    return candidate
  }

  writeAtomic(filePath, text) {
    const temp = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`
    fs.writeFileSync(temp, text, 'utf8')
    fs.renameSync(temp, filePath)
  }

  serializedState() { return `${JSON.stringify(this.state, null, 2)}\n` }

  finishLoadRecovery() {
    if (this.loadError || this.loadMode === 'normal') return
    const kind = this.loadMode === 'migrated-v0' ? 'legacy-v0' : 'corrupt'
    const snapshotPath = this.snapshotPath(kind)
    fs.copyFileSync(this.statePath, snapshotPath)
    this.persist({ backupExisting: false })
    this.writeAtomic(this.backupPath, this.serializedState())
    this.recoveryInfo = { mode: this.loadMode, snapshotPath, backupPath: this.backupPath }
  }

  assertReady() { if (this.loadError) throw new Error(this.loadError) }
  persist({ backupExisting = true } = {}) {
    this.assertReady()
    if (backupExisting) {
      const current = this.readState(this.statePath)
      if (current) this.writeAtomic(this.backupPath, fs.readFileSync(this.statePath, 'utf8'))
    }
    this.writeAtomic(this.statePath, this.serializedState())
    if (!fs.existsSync(this.backupPath)) this.writeAtomic(this.backupPath, this.serializedState())
  }

  fileReceipt(input) {
    const resolved = fs.realpathSync(path.resolve(String(input?.path || input || '')))
    const stat = fs.statSync(resolved)
    if (!stat.isFile() && !stat.isDirectory()) throw new Error('项目素材不是文件或目录')
    const supplied = input && typeof input === 'object' && /^[a-f0-9]{64}$/i.test(String(input.sha256 || ''))
    const fingerprint = supplied ? { sha256: input.sha256, bytes: Number(input.size ?? input.bytes) || stat.size, kind: stat.isDirectory() ? 'directory' : 'file' } : fingerprintArtifact(resolved)
    return { path: resolved, name: path.basename(resolved), kind: kindForPath(resolved), bytes: fingerprint.bytes, sha256: fingerprint.sha256, mtimeMs: Math.trunc(stat.mtimeMs) }
  }

  validate(receipt) {
    const current = this.fileReceipt(receipt.path)
    if (current.bytes !== Number(receipt.bytes) || current.sha256 !== receipt.sha256) throw new Error(`项目文件已发生变化：${receipt.name || path.basename(receipt.path)}`)
    return current.path
  }

  resolveProjectId(paths = []) {
    this.assertReady()
    const wanted = new Set(paths.map((item) => path.resolve(String(item?.path || item || '')).toLowerCase()))
    const project = [...this.state.projects].reverse().find((item) => (
      item.materials.some((material) => (material.locations || [material.path]).some((location) => wanted.has(path.resolve(location).toLowerCase())))
      || item.artifacts.some((artifact) => wanted.has(path.resolve(artifact.path).toLowerCase()))
    ))
    return project?.id || ''
  }

  newProjectId() { return `project-${this.idFactory()}` }

  recordTask({ projectId, taskId, type, instruction, sources = [], references = [], outputs = [], intermediateOutputs = [], historyId = '', operationKey = '', result = null } = {}) {
    this.assertReady()
    const taskKey = String(taskId || '').trim()
    if (!taskKey) throw new Error('项目任务标识不能为空')
    let project = this.state.projects.find((item) => item.id === projectId)
    if (!project) {
      const now = this.now()
      project = { schemaVersion: 1, id: projectId || this.newProjectId(), name: '', createdAt: now, updatedAt: now, materials: [], artifacts: [], references: [], instructions: [], revisions: [], current: null }
      this.state.projects.push(project)
    }
    const existing = project.revisions.find((item) => item.taskId === taskKey)
    if (existing) {
      for (const artifactId of existing.artifactIds) this.validate(project.artifacts.find((item) => item.id === artifactId))
      return this.capsule(project)
    }
    const sourceIds = []
    for (const source of sources) {
      const receipt = this.fileReceipt(source)
      const sourceArtifact = project.artifacts.find((item) => path.resolve(item.path).toLowerCase() === path.resolve(receipt.path).toLowerCase() && item.sha256 === receipt.sha256)
      if (sourceArtifact) {
        if (!sourceIds.includes(sourceArtifact.id)) sourceIds.push(sourceArtifact.id)
        continue
      }
      let material = project.materials.find((item) => item.sha256 === receipt.sha256 && item.bytes === receipt.bytes)
      if (!material) {
        const samePathRevisions = project.materials.filter((item) => (item.locations || []).some((location) => path.resolve(location).toLowerCase() === path.resolve(receipt.path).toLowerCase())).length
        material = { id: `material-${this.idFactory()}`, kind: receipt.kind, name: receipt.name, bytes: receipt.bytes, sha256: receipt.sha256, locations: [receipt.path], version: samePathRevisions + 1, addedAt: this.now() }
        project.materials.push(material)
      } else if (!material.locations.includes(receipt.path)) material.locations.push(receipt.path)
      if (!sourceIds.includes(material.id)) sourceIds.push(material.id)
    }
    for (const reference of references) {
      const uri = String(reference?.uri || reference || '').trim()
      if (uri && !project.references.some((item) => item.uri === uri)) project.references.push({ id: `reference-${this.idFactory()}`, kind: String(reference?.kind || 'web'), uri, addedAt: this.now() })
    }
    const instructionRecord = { id: `instruction-${this.idFactory()}`, text: String(instruction || ''), taskId: taskKey, createdAt: this.now() }
    project.instructions.push(instructionRecord)
    const artifactIds = []
    const allOutputs = [...intermediateOutputs.map((item) => ({ path: item, role: 'intermediate' })), ...outputs.map((item) => ({ path: item, role: 'deliverable' }))]
    for (const output of allOutputs) {
      const receipt = this.fileReceipt(output.path)
      let artifact = project.artifacts.find((item) => item.sha256 === receipt.sha256 && item.bytes === receipt.bytes)
      if (!artifact) {
        artifact = { id: `artifact-${this.idFactory()}`, role: output.role, kind: receipt.kind, path: receipt.path, name: receipt.name, bytes: receipt.bytes, sha256: receipt.sha256, derivedFrom: [...sourceIds], createdAt: this.now() }
        project.artifacts.push(artifact)
      }
      artifactIds.push(artifact.id)
    }
    const revision = { id: `revision-${this.idFactory()}`, number: project.revisions.length + 1, taskId: taskKey, type: String(type || ''), instructionId: instructionRecord.id, sourceIds, artifactIds, historyId: String(historyId || ''), operationKey: String(operationKey || ''), result: result ? clone(result) : null, createdAt: this.now() }
    project.revisions.push(revision)
    if (artifactIds.length > 0 || !project.current) project.current = { revisionId: revision.id, revision: revision.number, artifactIds: [...artifactIds], primaryArtifactId: artifactIds.at(-1) || '' }
    project.name ||= project.materials[0]?.name || project.artifacts[0]?.name || 'AgentPlay 项目'
    project.updatedAt = this.now()
    project.materials = project.materials.slice(-500); project.artifacts = project.artifacts.slice(-500); project.instructions = project.instructions.slice(-200); project.revisions = project.revisions.slice(-300)
    this.state.projects = this.state.projects.slice(-200)
    this.persist()
    return this.capsule(project)
  }

  findReusable(projectId, operationKey) {
    this.assertReady()
    const project = this.state.projects.find((item) => item.id === projectId)
    const revision = project?.revisions.findLast((item) => item.operationKey && item.operationKey === operationKey)
    if (!project || !revision) return null
    const artifacts = revision.artifactIds.map((id) => project.artifacts.find((item) => item.id === id)).filter((item) => item?.role === 'deliverable')
    if (!artifacts.length) return null
    for (const sourceId of revision.sourceIds) {
      const material = project.materials.find((item) => item.id === sourceId)
      const sourceArtifact = project.artifacts.find((item) => item.id === sourceId)
      if (sourceArtifact) this.validate(sourceArtifact)
      else {
        if (!material?.locations?.[0]) throw new Error('项目素材清单不完整')
        this.validate({ ...material, path: material.locations[0] })
      }
    }
    for (const artifact of artifacts) this.validate(artifact)
    return { ...(revision.result || {}), projectCapsule: this.capsule(project), outputs: artifacts.map((item) => item.path), historyId: revision.historyId, reused: true }
  }

  get(projectId) { this.assertReady(); const project = this.state.projects.find((item) => item.id === projectId); return project ? clone(project) : null }
  list() { this.assertReady(); return [...this.state.projects].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100).map((item) => this.capsule(item)) }
  listTrash() { this.assertReady(); return [...this.state.trash].sort((a, b) => Number(b.trashedAt || 0) - Number(a.trashedAt || 0)).map((item) => this.capsule(item)) }
  archive(projectId, archived = true) {
    this.assertReady(); const project = this.state.projects.find((item) => item.id === projectId); if (!project) throw new Error('项目不存在')
    project.status = archived ? 'archived' : 'active'; project.archivedAt = archived ? this.now() : null; project.updatedAt = this.now(); this.persist(); return this.capsule(project)
  }
  copy(projectId) {
    this.assertReady(); const source = this.state.projects.find((item) => item.id === projectId); if (!source) throw new Error('项目不存在')
    const project = clone(source); project.id = this.newProjectId(); project.name = `${source.name} 副本`; project.status = 'active'; project.archivedAt = null; project.createdAt = this.now(); project.updatedAt = this.now()
    const materialIds = new Map(project.materials.map((item) => { const old = item.id; item.id = `material-${this.idFactory()}`; return [old, item.id] }))
    const artifactIds = new Map(project.artifacts.map((item) => { const old = item.id; item.id = `artifact-${this.idFactory()}`; return [old, item.id] }))
    const instructionIds = new Map(project.instructions.map((item) => { const old = item.id; item.id = `instruction-${this.idFactory()}`; item.taskId = ''; return [old, item.id] }))
    for (const artifact of project.artifacts) artifact.derivedFrom = artifact.derivedFrom.map((id) => materialIds.get(id) || artifactIds.get(id) || id)
    const revisionIds = new Map(project.revisions.map((item) => { const old = item.id; item.id = `revision-${this.idFactory()}`; item.taskId = ''; item.operationKey = ''; item.sourceIds = item.sourceIds.map((id) => materialIds.get(id) || artifactIds.get(id) || id); item.artifactIds = item.artifactIds.map((id) => artifactIds.get(id) || id); item.instructionId = instructionIds.get(item.instructionId) || item.instructionId; return [old, item.id] }))
    if (project.current) { project.current.revisionId = revisionIds.get(project.current.revisionId) || project.current.revisionId; project.current.artifactIds = project.current.artifactIds.map((id) => artifactIds.get(id) || id); project.current.primaryArtifactId = artifactIds.get(project.current.primaryArtifactId) || project.current.primaryArtifactId }
    this.state.projects.push(project); this.persist(); return this.capsule(project)
  }
  trash(projectId) {
    this.assertReady(); const index = this.state.projects.findIndex((item) => item.id === projectId); if (index < 0) throw new Error('项目不存在')
    const [project] = this.state.projects.splice(index, 1); project.status = 'trashed'; project.trashedAt = this.now(); project.updatedAt = this.now(); this.state.trash.push(project); this.persist(); return this.capsule(project)
  }
  restore(projectId) {
    this.assertReady(); const index = this.state.trash.findIndex((item) => item.id === projectId); if (index < 0) throw new Error('回收区项目不存在')
    const [project] = this.state.trash.splice(index, 1); project.status = 'active'; project.trashedAt = null; project.updatedAt = this.now(); this.state.projects.push(project); this.persist(); return this.capsule(project)
  }
  capsule(project) {
    const current = project.current || { revision: 0, artifactIds: [], primaryArtifactId: '' }
    const artifact = project.artifacts.find((item) => item.id === current.primaryArtifactId)
    return { schemaVersion: 1, projectId: project.id, name: project.name, status: project.status || 'active', revision: current.revision || 0, materialCount: project.materials.length, artifactCount: project.artifacts.length, currentPath: artifact?.path || '', currentArtifactId: artifact?.id || '', updatedAt: project.updatedAt }
  }
}

module.exports = { ProjectCapsuleStore, kindForPath }
