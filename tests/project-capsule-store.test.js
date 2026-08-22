const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { ProjectCapsuleStore } = require('../electron/project-capsule-store')

test('mixed materials, instructions and derived artifacts survive restart without duplicate content', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-project-capsule-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const video = path.join(root, 'video.mp4'); const subtitle = path.join(root, 'video.srt'); const report = path.join(root, 'report.docx')
  fs.writeFileSync(video, Buffer.alloc(2048, 1)); fs.writeFileSync(subtitle, '字幕'); fs.writeFileSync(report, Buffer.concat([Buffer.from('PK'), Buffer.alloc(2048)]))
  let ids = 0
  const store = new ProjectCapsuleStore({ rootDir: path.join(root, 'state'), idFactory: () => String(++ids), now: () => 1000 + ids })
  const capsule = store.recordTask({ projectId: 'project-1', taskId: 'task-1', type: 'outcome.workflow', instruction: '做成报告', sources: [video, subtitle, video], references: [{ kind: 'web', uri: 'https://example.com/source' }, { kind: 'web', uri: 'https://example.com/source' }], outputs: [report], operationKey: 'op-1' })
  assert.equal(capsule.materialCount, 2, '相同视频内容不得重复登记')
  assert.equal(capsule.artifactCount, 1)
  assert.equal(capsule.revision, 1)
  const restarted = new ProjectCapsuleStore({ rootDir: path.join(root, 'state') })
  assert.equal(restarted.get('project-1').instructions[0].text, '做成报告')
  assert.equal(restarted.get('project-1').references.length, 1, '相同网页来源不得重复登记')
  assert.deepEqual(restarted.get('project-1').artifacts[0].derivedFrom.length, 2)
  assert.equal(restarted.findReusable('project-1', 'op-1').outputs[0], report)
})

test('continuing from a prior artifact stays in the same project and advances the current revision', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-project-continue-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'source.txt'); const first = path.join(root, 'first.docx'); const second = path.join(root, 'second.pdf')
  fs.writeFileSync(source, 'source'); fs.writeFileSync(first, Buffer.concat([Buffer.from('PK'), Buffer.alloc(100)])); fs.writeFileSync(second, '%PDF-1.4\n%%EOF')
  const store = new ProjectCapsuleStore({ rootDir: path.join(root, 'state') })
  const one = store.recordTask({ projectId: 'project-x', taskId: 'one', instruction: '先做Word', sources: [source], outputs: [first] })
  assert.equal(store.resolveProjectId([first]), one.projectId)
  const two = store.recordTask({ projectId: store.resolveProjectId([first]), taskId: 'two', instruction: '继续改成PDF', sources: [first], outputs: [second] })
  assert.equal(two.projectId, one.projectId)
  assert.equal(two.revision, 2)
  assert.equal(two.currentPath, second)
  assert.equal(store.get(one.projectId).instructions.at(-1).text, '继续改成PDF')
  const project = store.get(one.projectId)
  assert.equal(project.materials.length, 1, '上一轮成果作为输入时不得重复登记成原始素材')
  assert.equal(project.artifacts[1].derivedFrom[0], project.artifacts[0].id, '第二版成果必须指向上一版成果')
  const asked = store.recordTask({ projectId: one.projectId, taskId: 'three', type: 'project.evidence-qa', instruction: '两份结果有什么差异？', sources: [source, second], outputs: [], result: { success: true, chatOnly: true } })
  assert.equal(asked.currentPath, second, '只读证据问答不得清空当前成果')
  assert.equal(store.get(one.projectId).revisions.length, 3)
})

test('changed derived files invalidate reuse and corrupt history fails closed', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-project-invalid-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'source.txt'); const output = path.join(root, 'output.txt')
  fs.writeFileSync(source, 'source'); fs.writeFileSync(output, 'result')
  const stateDir = path.join(root, 'state')
  const store = new ProjectCapsuleStore({ rootDir: stateDir })
  store.recordTask({ projectId: 'project-z', taskId: 'one', sources: [source], outputs: [output], operationKey: 'same' })
  fs.appendFileSync(output, 'changed')
  assert.throws(() => store.findReusable('project-z', 'same'), /项目文件已发生变化/)
  const corruptDir = path.join(root, 'corrupt'); fs.mkdirSync(corruptDir); fs.writeFileSync(path.join(corruptDir, 'project-capsules-v1.json'), '{broken')
  const corrupt = new ProjectCapsuleStore({ rootDir: corruptDir })
  assert.throws(() => corrupt.list(), /项目胶囊历史损坏/)
  assert.equal(fs.readFileSync(path.join(corruptDir, 'project-capsules-v1.json'), 'utf8'), '{broken')
})

test('legacy v0 state migrates once and preserves the original snapshot', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-project-migrate-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const stateDir = path.join(root, 'state'); fs.mkdirSync(stateDir)
  const statePath = path.join(stateDir, 'project-capsules-v1.json')
  fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 0, projects: [{ id: 'legacy-project', name: 'legacy', createdAt: 1, updatedAt: 2 }] }))
  const store = new ProjectCapsuleStore({ rootDir: stateDir, now: () => 1234 })
  assert.equal(store.loadError, '')
  assert.equal(store.recoveryInfo.mode, 'migrated-v0')
  assert.equal(store.get('legacy-project').status, 'active')
  assert.deepEqual(store.get('legacy-project').materials, [])
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).schemaVersion, 1)
  assert.equal(JSON.parse(fs.readFileSync(`${statePath}.bak`, 'utf8')).schemaVersion, 1)
  const snapshot = `${statePath}.legacy-v0-1234`
  assert.equal(JSON.parse(fs.readFileSync(snapshot, 'utf8')).schemaVersion, 0)
  const restarted = new ProjectCapsuleStore({ rootDir: stateDir })
  assert.equal(restarted.recoveryInfo, null, 'migration must not repeat after the first successful rewrite')
})

test('corrupt primary recovers only from a valid backup and preserves forensic evidence', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-project-recover-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'source.txt'); const output = path.join(root, 'output.txt')
  fs.writeFileSync(source, 'source'); fs.writeFileSync(output, 'output')
  const stateDir = path.join(root, 'state')
  const store = new ProjectCapsuleStore({ rootDir: stateDir })
  store.recordTask({ projectId: 'recover-me', taskId: 'one', sources: [source], outputs: [output] })
  store.archive('recover-me') // the previous valid primary is now the backup
  const statePath = path.join(stateDir, 'project-capsules-v1.json')
  assert.equal(JSON.parse(fs.readFileSync(`${statePath}.bak`, 'utf8')).projects[0].id, 'recover-me')
  fs.writeFileSync(statePath, '{broken-primary')
  const recovered = new ProjectCapsuleStore({ rootDir: stateDir, now: () => 5678 })
  assert.equal(recovered.loadError, '')
  assert.equal(recovered.recoveryInfo.mode, 'recovered-backup')
  assert.equal(recovered.get('recover-me').current.revision, 1)
  assert.equal(fs.readFileSync(`${statePath}.corrupt-5678`, 'utf8'), '{broken-primary')
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).projects[0].id, 'recover-me')
})

test('a future schema never downgrades through an older backup', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-project-future-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const stateDir = path.join(root, 'state'); fs.mkdirSync(stateDir)
  const statePath = path.join(stateDir, 'project-capsules-v1.json')
  fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 2, projects: [] }))
  fs.writeFileSync(`${statePath}.bak`, JSON.stringify({ schemaVersion: 1, projects: [], trash: [] }))
  const store = new ProjectCapsuleStore({ rootDir: stateDir })
  assert.throws(() => store.list(), /高于当前程序可支持版本/)
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).schemaVersion, 2)
})

test('large mixed project state has a bounded cold-start and list surface', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-project-pressure-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const stateDir = path.join(root, 'state'); fs.mkdirSync(stateDir)
  const projects = Array.from({ length: 200 }, (_, projectIndex) => ({
    schemaVersion: 1,
    id: `mixed-${projectIndex}`,
    name: `混合项目 ${projectIndex}`,
    status: projectIndex % 5 === 0 ? 'archived' : 'active',
    createdAt: projectIndex,
    updatedAt: projectIndex,
    materials: ['video', 'audio', 'subtitle', 'image', 'pdf', 'office', 'document'].flatMap((kind, kindIndex) => Array.from({ length: 8 }, (_, version) => ({ id: `m-${projectIndex}-${kindIndex}-${version}`, kind, name: `${kind}-${version}`, bytes: 10, sha256: 'a'.repeat(64), locations: [`C:\\fixtures\\${projectIndex}\\${kind}-${version}`], version: 1, addedAt: 1 }))),
    artifacts: Array.from({ length: 24 }, (_, index) => ({ id: `a-${projectIndex}-${index}`, role: index % 3 ? 'deliverable' : 'intermediate', kind: 'document', path: `C:\\outputs\\${projectIndex}-${index}.txt`, name: `${index}.txt`, bytes: 10, sha256: 'b'.repeat(64), derivedFrom: [`m-${projectIndex}-0-0`], createdAt: index })),
    references: [{ id: `ref-${projectIndex}`, kind: 'web', uri: `https://example.com/${projectIndex}`, addedAt: 1 }],
    instructions: Array.from({ length: 20 }, (_, index) => ({ id: `i-${projectIndex}-${index}`, text: `修改 ${index}`, taskId: `t-${projectIndex}-${index}`, createdAt: index })),
    revisions: Array.from({ length: 20 }, (_, index) => ({ id: `r-${projectIndex}-${index}`, number: index + 1, taskId: `t-${projectIndex}-${index}`, instructionId: `i-${projectIndex}-${index}`, sourceIds: [`m-${projectIndex}-0-0`], artifactIds: [`a-${projectIndex}-${index}`], createdAt: index })),
    current: { revisionId: `r-${projectIndex}-19`, revision: 20, artifactIds: [`a-${projectIndex}-19`], primaryArtifactId: `a-${projectIndex}-19` }
  }))
  fs.writeFileSync(path.join(stateDir, 'project-capsules-v1.json'), JSON.stringify({ schemaVersion: 1, projects, trash: [] }))
  const startedAt = performance.now()
  const store = new ProjectCapsuleStore({ rootDir: stateDir })
  const elapsedMs = performance.now() - startedAt
  assert.equal(store.get('mixed-199').materials.length, 56)
  assert.equal(store.list().length, 100, 'project list surface must remain bounded')
  assert.equal(store.list()[0].projectId, 'mixed-199')
  assert.ok(elapsedMs < 5000, `cold start took ${elapsedMs.toFixed(0)}ms`)
})

test('main and preload expose read-only project capsule inspection', () => {
  const root = path.join(__dirname, '..')
  const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8')
  const preload = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8')
  assert.match(main, /ipcMain\.handle\('projects:list'/)
  assert.match(main, /ipcMain\.handle\('projects:get'/)
  assert.match(preload, /projects: \{/)
  assert.match(preload, /ipcRenderer\.invoke\('projects:list'\)/)
  assert.match(main, /register\('project\.trash'/)
  assert.match(main, /action: 'delete'/)
  assert.match(preload, /ipcRenderer\.invoke\('projects:restore'/)
})

test('archive, metadata-only copy, recoverable trash and restore never delete user files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-project-lifecycle-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'source.txt'); const output = path.join(root, 'result.txt'); fs.writeFileSync(source, 'source'); fs.writeFileSync(output, 'result')
  const store = new ProjectCapsuleStore({ rootDir: path.join(root, 'state') })
  store.recordTask({ projectId: 'project-life', taskId: 'one', sources: [source], outputs: [output], instruction: '处理' })
  assert.equal(store.archive('project-life').status, 'archived')
  assert.equal(store.archive('project-life', false).status, 'active')
  const copied = store.copy('project-life'); assert.notEqual(copied.projectId, 'project-life'); assert.match(copied.name, /副本/)
  assert.equal(store.get(copied.projectId).materials[0].locations[0], source, '复制项目不得复制大型素材文件')
  const trashed = store.trash('project-life'); assert.equal(trashed.status, 'trashed'); assert.equal(store.get('project-life'), null); assert.equal(store.listTrash()[0].projectId, 'project-life')
  assert.equal(fs.existsSync(source), true); assert.equal(fs.existsSync(output), true)
  const restored = store.restore('project-life'); assert.equal(restored.status, 'active'); assert.equal(restored.revision, 1); assert.equal(store.listTrash().length, 0)
})
