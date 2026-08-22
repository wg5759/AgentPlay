export type WorkspaceTaskKind = 'doc' | 'analysis' | 'download' | 'link-analysis' | 'media' | 'creative' | 'utility'
export type WorkspaceTaskPhase = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export type WorkspaceTaskStepPhase = 'pending' | 'running' | 'completed' | 'failed' | 'blocked'
export type WorkspaceEvidenceKind = 'file' | 'tool-result' | 'state' | 'receipt'

export interface WorkspaceTaskStep {
  id: string
  label: string
  phase: WorkspaceTaskStepPhase
  detail: string
  evidence: string
  startedAt: number | null
  completedAt: number | null
}

export interface WorkspaceTaskEvidence {
  id: string
  kind: WorkspaceEvidenceKind
  label: string
  value: string
  verified: boolean
  createdAt: number
  bytes?: number
}

export interface WorkspaceTaskBudget {
  turns: number
  maxTurns: number
  toolCalls: number
  maxToolCalls: number
  elapsedMs: number
  maxElapsedMs: number
}

export interface WorkspaceTaskQualityReason {
  code: string
  message: string
  repairable: boolean
  detail?: string
}

export interface WorkspaceTaskQuality {
  version: number
  profile: string
  score: number
  threshold: number
  passed: boolean
  level: 'pass' | 'warning' | 'fail'
  reasons: WorkspaceTaskQualityReason[]
  checks: Array<{ id: string; label: string; passed: boolean; weight: number; score: number; detail?: string }>
}

export interface WorkspaceTaskRepairReceipt {
  attempt: number
  action: string
  fromScore: number
  toScore: number
  passed: boolean
  reasons: string[]
  completedAt: number
}

export interface WorkspaceTaskFailure {
  code: string
  message: string
  retryable: boolean
}

export interface WorkspaceTaskRetry {
  kind: 'doc' | 'analysis' | 'outcome' | 'cross-qa' | 'download' | 'link-analysis' | 'compress' | 'trim' | 'video-gen' | 'batch' | 'dedup' | 'recut'
  instruction?: string
  url?: string
  sourcePath?: string
  outputFormat?: string
  direct?: boolean
  targetMb?: number
  mode?: 'compress' | 'remux'
  directoryPath?: string
}

export interface WorkspaceTask {
  id: string
  kind: WorkspaceTaskKind
  label: string
  phase: WorkspaceTaskPhase
  running: boolean
  status: string
  progress: number | null
  outputs: string[]
  summary: string
  error: string
  instruction: string
  source: string
  retry: WorkspaceTaskRetry | null
  steps: WorkspaceTaskStep[]
  evidence: WorkspaceTaskEvidence[]
  budget: WorkspaceTaskBudget | null
  quality: WorkspaceTaskQuality | null
  repairHistory: WorkspaceTaskRepairReceipt[]
  failure: WorkspaceTaskFailure | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export type WorkspaceTaskInput = Partial<Omit<WorkspaceTask, 'id' | 'createdAt' | 'updatedAt'>> & {
  id?: string
  kind?: WorkspaceTaskKind
  label?: string
  createdAt?: number
  updatedAt?: number
}

export const TERMINAL_TASK_PHASES = new Set<WorkspaceTaskPhase>(['completed', 'failed', 'cancelled'])

function normalizeSteps(value: unknown): WorkspaceTaskStep[] {
  return (Array.isArray(value) ? value : []).slice(-24).map((step, index) => ({
    id: String(step?.id || `step-${index + 1}`),
    label: String(step?.label || '处理任务'),
    phase: ['pending', 'running', 'completed', 'failed', 'blocked'].includes(step?.phase) ? step.phase : 'pending',
    detail: String(step?.detail || ''),
    evidence: String(step?.evidence || ''),
    startedAt: step?.startedAt == null ? null : Number(step.startedAt),
    completedAt: step?.completedAt == null ? null : Number(step.completedAt)
  }))
}

function normalizeEvidence(value: unknown): WorkspaceTaskEvidence[] {
  return (Array.isArray(value) ? value : []).slice(-30).map((item, index) => ({
    id: String(item?.id || `evidence-${index + 1}`),
    kind: ['file', 'tool-result', 'state', 'receipt'].includes(item?.kind) ? item.kind : 'receipt',
    label: String(item?.label || '执行收据'),
    value: String(item?.value || ''),
    verified: item?.verified === true,
    createdAt: Number(item?.createdAt || Date.now()),
    ...(Number.isFinite(item?.bytes) ? { bytes: Number(item.bytes) } : {})
  }))
}

function normalizeBudget(value: unknown): WorkspaceTaskBudget | null {
  if (!value || typeof value !== 'object') return null
  const budget = value as Partial<WorkspaceTaskBudget>
  return {
    turns: Math.max(0, Number(budget.turns) || 0),
    maxTurns: Math.max(0, Number(budget.maxTurns) || 0),
    toolCalls: Math.max(0, Number(budget.toolCalls) || 0),
    maxToolCalls: Math.max(0, Number(budget.maxToolCalls) || 0),
    elapsedMs: Math.max(0, Number(budget.elapsedMs) || 0),
    maxElapsedMs: Math.max(0, Number(budget.maxElapsedMs) || 0)
  }
}

function normalizeQuality(value: unknown): WorkspaceTaskQuality | null {
  if (!value || typeof value !== 'object') return null
  const quality = value as Partial<WorkspaceTaskQuality>
  const score = Math.max(0, Math.min(100, Number(quality.score) || 0))
  const threshold = Math.max(1, Math.min(100, Number(quality.threshold) || 80))
  return {
    version: Math.max(1, Number(quality.version) || 1),
    profile: String(quality.profile || 'technical'), score, threshold,
    passed: quality.passed === true,
    level: ['pass', 'warning', 'fail'].includes(String(quality.level)) ? quality.level as WorkspaceTaskQuality['level'] : score >= threshold ? 'pass' : 'fail',
    reasons: (Array.isArray(quality.reasons) ? quality.reasons : []).slice(0, 12).map((item) => ({
      code: String(item?.code || 'QUALITY_NOTE'), message: String(item?.message || ''), repairable: item?.repairable === true,
      ...(item?.detail ? { detail: String(item.detail) } : {})
    })),
    checks: (Array.isArray(quality.checks) ? quality.checks : []).slice(0, 20).map((item) => ({
      id: String(item?.id || ''), label: String(item?.label || ''), passed: item?.passed === true,
      weight: Math.max(0, Number(item?.weight) || 0), score: Math.max(0, Number(item?.score) || 0),
      ...(item?.detail ? { detail: String(item.detail) } : {})
    }))
  }
}

function normalizeRepairHistory(value: unknown): WorkspaceTaskRepairReceipt[] {
  return (Array.isArray(value) ? value : []).slice(-4).map((item, index) => ({
    attempt: Math.max(1, Number(item?.attempt) || index + 1), action: String(item?.action || '自动修复'),
    fromScore: Math.max(0, Math.min(100, Number(item?.fromScore) || 0)), toScore: Math.max(0, Math.min(100, Number(item?.toScore) || 0)),
    passed: item?.passed === true, reasons: (Array.isArray(item?.reasons) ? item.reasons : []).map(String).slice(0, 6),
    completedAt: Number(item?.completedAt || Date.now())
  }))
}

function normalizeFailure(value: unknown): WorkspaceTaskFailure | null {
  if (!value || typeof value !== 'object') return null
  const failure = value as Partial<WorkspaceTaskFailure>
  return { code: String(failure.code || 'EXECUTION_FAILED'), message: String(failure.message || ''), retryable: failure.retryable !== false }
}

export function createWorkspaceTask(input: WorkspaceTaskInput = {}, now = Date.now()): WorkspaceTask {
  const phase = input.phase || 'queued'
  return {
    id: String(input.id || `task-${now}-${Math.random().toString(36).slice(2, 9)}`),
    kind: input.kind || 'doc',
    label: String(input.label || '任务'),
    phase,
    running: phase === 'running',
    status: String(input.status || ''),
    progress: Number.isFinite(input.progress) ? Math.max(0, Math.min(100, Number(input.progress))) : null,
    outputs: Array.isArray(input.outputs) ? [...input.outputs] : [],
    summary: String(input.summary || ''),
    error: String(input.error || ''),
    instruction: String(input.instruction || ''),
    source: String(input.source || ''),
    retry: input.retry || null,
    steps: normalizeSteps(input.steps),
    evidence: normalizeEvidence(input.evidence),
    budget: normalizeBudget(input.budget),
    quality: normalizeQuality(input.quality),
    repairHistory: normalizeRepairHistory(input.repairHistory),
    failure: normalizeFailure(input.failure),
    createdAt: Number(input.createdAt ?? now),
    updatedAt: Number(input.updatedAt ?? now),
    completedAt: input.completedAt == null ? null : Number(input.completedAt)
  }
}

export function patchWorkspaceTask(task: WorkspaceTask, patch: Partial<WorkspaceTask>, now = Date.now()): WorkspaceTask {
  const next: WorkspaceTask = { ...task, ...patch, updatedAt: now }
  next.outputs = Array.isArray(next.outputs) ? [...next.outputs] : []
  next.steps = normalizeSteps(next.steps)
  next.evidence = normalizeEvidence(next.evidence)
  next.budget = normalizeBudget(next.budget)
  next.quality = normalizeQuality(next.quality)
  next.repairHistory = normalizeRepairHistory(next.repairHistory)
  next.failure = normalizeFailure(next.failure)
  next.progress = Number.isFinite(next.progress) ? Math.max(0, Math.min(100, Number(next.progress))) : null
  next.running = next.phase === 'running'
  if (next.phase === 'completed') {
    next.error = ''
    next.progress = 100
    next.completedAt ||= now
    next.steps = next.steps.map((step) => step.phase === 'running'
      ? { ...step, phase: 'completed', completedAt: step.completedAt || now }
      : step)
  } else if (next.phase === 'failed') {
    next.steps = next.steps.map((step) => step.phase === 'running'
      ? { ...step, phase: 'failed', completedAt: step.completedAt || now, detail: next.error || step.detail }
      : step)
  } else if (!TERMINAL_TASK_PHASES.has(next.phase)) {
    next.completedAt = null
  }
  return next
}

export function recordWorkspaceTaskProgress(task: WorkspaceTask, status: string, now = Date.now()): WorkspaceTask {
  const detail = String(status || '').trim()
  if (!detail) return patchWorkspaceTask(task, { status: '' }, now)
  const label = detail.replace(/^（\d+\/\d+）\s*/, '').replace(/[.…]+$/, '').trim() || '正在处理'
  const steps = normalizeSteps(task.steps)
  const current = steps[steps.length - 1]
  if (current?.phase === 'running' && current.label === label) {
    steps[steps.length - 1] = { ...current, detail }
  } else {
    if (current?.phase === 'running') steps[steps.length - 1] = { ...current, phase: 'completed', completedAt: now }
    steps.push({
      id: `step-${now}-${steps.length + 1}`,
      label,
      phase: 'running',
      detail,
      evidence: '',
      startedAt: now,
      completedAt: null
    })
  }
  return patchWorkspaceTask(task, { status: detail, steps: steps.slice(-24) }, now)
}

export function applyWorkspaceOutputReceipts(task: WorkspaceTask, receipts: Array<{ path?: string; exists?: boolean; bytes?: number; error?: string }> = [], now = Date.now()): WorkspaceTask {
  const byPath = new Map(receipts.map((receipt) => [String(receipt.path || ''), receipt]))
  const evidence = task.outputs.map((output, index) => {
    const receipt = byPath.get(output)
    return {
      id: `file-${now}-${index + 1}`,
      kind: 'file' as const,
      label: receipt?.exists ? '成果文件已验证' : '成果文件待验证',
      value: output,
      verified: receipt?.exists === true,
      createdAt: now,
      ...(Number.isFinite(receipt?.bytes) ? { bytes: Number(receipt?.bytes) } : {})
    }
  })
  return patchWorkspaceTask(task, { evidence }, now)
}

export function restoreWorkspaceTasks(rawTasks: unknown, now = Date.now()): WorkspaceTask[] {
  return (Array.isArray(rawTasks) ? rawTasks : [])
    .filter((raw): raw is WorkspaceTaskInput => Boolean(raw && typeof raw === 'object'))
    .map((raw) => createWorkspaceTask(raw, now))
    .map((task) => {
      if (!['queued', 'running', 'waiting'].includes(task.phase)) return task
      return patchWorkspaceTask(task, {
        phase: 'interrupted',
        status: '',
        error: task.error || '应用上次关闭时任务尚未完成，请确认源内容后重试。'
      }, now)
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 80)
}

export function progressFromStatus(status: string): number | null {
  const text = String(status || '')
  const fraction = /（(\d+)\/(\d+)）/.exec(text)
  if (fraction && Number(fraction[2]) > 0) return Math.max(0, Math.min(100, Math.round((Number(fraction[1]) / Number(fraction[2])) * 100)))
  const percent = /(\d+(?:\.\d+)?)\s*%/.exec(text)
  return percent ? Math.max(0, Math.min(100, Math.round(Number(percent[1])))) : null
}
