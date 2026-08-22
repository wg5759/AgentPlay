import { useMemo } from 'react'
import { useAgentStore, type AgentTask } from '../stores/agentStore'
import UiIcon from './UiIcon'
import { taskTimingForTask } from '../workspace-journey-policy.mjs'

interface Props {
  onClose: () => void
  onRetry: (task: AgentTask) => void
  onContinue: (task: AgentTask) => void
  onCancel: () => void
  cancellableTaskId: string
}

const PHASE_LABEL: Record<AgentTask['phase'], string> = {
  queued: '等待中',
  running: '执行中',
  waiting: '等你确认',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断'
}

const ACTIVE_PHASES = new Set<AgentTask['phase']>(['queued', 'running', 'waiting'])

export default function TaskCenter({ onClose, onRetry, onContinue, onCancel, cancellableTaskId }: Props) {
  const tasks = useAgentStore((state) => state.tasks)
  const activeTaskId = useAgentStore((state) => state.activeTaskId)
  const selectTask = useAgentStore((state) => state.selectTask)
  const clearFinishedTasks = useAgentStore((state) => state.clearFinishedTasks)
  const grouped = useMemo(() => ({
    active: tasks.filter((task) => ACTIVE_PHASES.has(task.phase)),
    recent: tasks.filter((task) => !ACTIVE_PHASES.has(task.phase))
  }), [tasks])

  const renderTask = (task: AgentTask) => {
    const retryable = Boolean(task.retry) && ['failed', 'cancelled', 'interrupted'].includes(task.phase)
    return (
      <article key={task.id} className={'task-center-card task-center-card-' + task.phase + (task.id === activeTaskId ? ' is-selected' : '')} onClick={() => selectTask(task.id)}>
        <div className="task-center-card-head">
          <span className="task-center-kind"><UiIcon name={task.kind === 'analysis' || task.kind === 'link-analysis' ? 'analysis' : task.kind === 'download' || task.kind === 'media' ? 'video' : 'report'} size={17} /></span>
          <div className="task-center-title"><strong>{task.label}</strong><small>{PHASE_LABEL[task.phase]}</small></div>
          <time>{new Date(task.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
        </div>
        {(task.instruction || task.source) && <p className="task-center-input" title={task.source}>{task.instruction || task.source}</p>}
        {task.phase === 'running' && (
          <><div className="task-center-progress"><i style={task.progress == null ? undefined : { width: `${task.progress}%` }} className={task.progress == null ? 'is-indeterminate' : ''} /><span>{task.status || '正在处理…'}</span></div><small className="task-center-timing">{taskTimingForTask(task)}</small></>
        )}
        {task.steps.length > 0 && (
          <ol className="task-center-steps" aria-label="任务执行步骤">
            {task.steps.slice(-4).map((step) => (
              <li key={step.id} className={`is-${step.phase}`}>
                <i aria-hidden="true" />
                <span><strong>{step.label}</strong>{step.detail && step.detail !== step.label ? <small>{step.detail}</small> : null}</span>
              </li>
            ))}
          </ol>
        )}
        {(task.evidence.length > 0 || task.budget) && (
          <div className="task-center-receipts">
            {task.evidence.length > 0 && <span>{task.evidence.filter((item) => item.verified).length}/{task.evidence.length} 份证据已验证</span>}
            {task.budget && <span>工具 {task.budget.toolCalls}/{task.budget.maxToolCalls} · {Math.ceil(task.budget.elapsedMs / 1000)} 秒</span>}
          </div>
        )}
        {task.evidence.length > 0 && <ul className="task-center-evidence" aria-label="成果证据">
          {task.evidence.slice(0, 4).map((item) => <li key={item.id} title={item.value}><i className={item.verified ? 'is-verified' : ''} /><strong>{item.label}</strong><span>{item.value}</span></li>)}
        </ul>}
        {task.quality && (
          <div className={`task-center-quality is-${task.quality.level}`}>
            <div><strong>质量评分 {task.quality.score}</strong><span>交付线 {task.quality.threshold}</span></div>
            <i aria-label={`质量评分 ${task.quality.score}，交付线 ${task.quality.threshold}`}><b style={{ width: `${task.quality.score}%` }} /></i>
            {task.quality.reasons.length > 0 && <ul>{task.quality.reasons.slice(0, 3).map((item) => <li key={item.code}>{item.message}</li>)}</ul>}
          </div>
        )}
        {task.repairHistory.length > 0 && (
          <div className="task-center-repairs">
            <strong>自动修复 {task.repairHistory.length} 次</strong>
            {task.repairHistory.slice(-2).map((item) => <span key={`${item.attempt}-${item.completedAt}`}>{item.action} · {item.fromScore} → {item.toScore}{item.passed ? ' · 已通过' : ' · 仍未通过'}</span>)}
          </div>
        )}
        {task.error && <p className="task-center-error">{task.error}</p>}
        {task.summary && <p className="task-center-summary">{task.summary}</p>}
        {task.outputs.length > 0 && (
          <div className="task-center-outputs">
            {task.outputs.slice(0, 4).map((output) => (
              <div key={output}>
                <button type="button" onClick={(event) => { event.stopPropagation(); void window.aiPlayer?.system?.openPath(output) }} title={output}><UiIcon name="open" size={14} />打开结果</button>
                <button type="button" onClick={(event) => { event.stopPropagation(); void window.aiPlayer?.system?.showInFolder(output) }} title="在文件夹中定位"><UiIcon name="file" size={14} /></button>
              </div>
            ))}
          </div>
        )}
        {(retryable || (task.phase === 'completed' && task.outputs.length > 0) || (task.phase === 'running' && task.id === cancellableTaskId)) && (
          <div className="task-center-actions">
            {retryable && <button type="button" onClick={(event) => { event.stopPropagation(); onRetry(task) }}>再次执行</button>}
            {task.phase === 'completed' && task.outputs.length > 0 && <button type="button" onClick={(event) => { event.stopPropagation(); onContinue(task) }}>继续修改</button>}
            {task.phase === 'running' && task.id === cancellableTaskId && <button type="button" className="is-danger" onClick={(event) => { event.stopPropagation(); onCancel() }}>取消任务</button>}
          </div>
        )}
      </article>
    )
  }

  return (
    <section className="task-center" aria-label="任务与结果中心">
      <div className="task-center-heading">
        <div><span>后台队列</span><strong>任务与结果</strong></div>
        <div className="task-center-heading-actions">
          {grouped.recent.length > 0 && <button type="button" onClick={clearFinishedTasks}>清理已结束</button>}
          <button type="button" onClick={onClose} aria-label="关闭任务与结果"><UiIcon name="close" size={17} /></button>
        </div>
      </div>
      <div className="task-center-scroll">
        {tasks.length === 0 && <div className="task-center-empty"><UiIcon name="history" size={24} /><strong>还没有任务</strong><span>下载、拉片和文档处理的进度与结果会出现在这里。</span></div>}
        {grouped.active.length > 0 && <div className="task-center-group"><h3>进行中 · {grouped.active.length}</h3>{grouped.active.map(renderTask)}</div>}
        {grouped.recent.length > 0 && <div className="task-center-group"><h3>最近结果</h3>{grouped.recent.slice(0, 30).map(renderTask)}</div>}
      </div>
    </section>
  )
}
