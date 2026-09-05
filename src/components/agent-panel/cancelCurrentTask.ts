import { useAgentStore } from '../../stores/agentStore'

export async function cancelCurrentTask() {
  const store = useAgentStore.getState()
  const task = store.task
  if (!task.id || !['queued', 'running', 'waiting', 'interrupted'].includes(task.phase)) return { cancelled: false, message: '当前没有可取消的任务。' }
  const api = window.aiPlayer?.taskRuntime
  if (!api) return { cancelled: false, message: '当前环境无法确认后台状态，请使用任务的停止按钮。' }
  let off: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const tasks = await api.list()
    if (tasks.some(item => item.failure?.code === 'TASK_STORAGE_UNREADABLE')) return { cancelled: false, message: '任务存储需要恢复，暂时无法确认取消状态。' }
    const native = tasks.find(item => item.workspaceTaskId === task.id || item.id === task.id)
    if (!native) {
      if (!['waiting', 'queued'].includes(task.phase)) return { cancelled: false, message: '未找到可确认的后台任务，状态暂未改变。' }
      store.updateTask(task.id, { phase: 'cancelled', status: '', error: '已取消，尚未执行' })
      return { cancelled: true, id: task.id, message: '已取消待确认的任务，没有执行。' }
    }
    if (['completed', 'failed', 'cancelled'].includes(native.state)) return { cancelled: false, message: '后台任务已经结束。' }
    let settle: (value: PersistentRuntimeTask | null) => void = () => {}
    const terminal = new Promise<PersistentRuntimeTask | null>(resolve => { settle = resolve })
    off = api.onEvent(value => { if (value.id === native.id && ['completed', 'failed', 'cancelled'].includes(value.state)) settle(value) })
    timer = setTimeout(() => settle(null), 6000)
    if (!await api.cancel(native.id)) return { cancelled: false, message: '后台没有确认取消，状态暂未改变。' }
    const current = (await api.list()).find(item => item.id === native.id)
    if (current && ['completed', 'failed', 'cancelled'].includes(current.state)) settle(current)
    const result = await terminal
    if (result?.state === 'cancelled') {
      store.updateTask(task.id, { phase: 'cancelled', status: '', error: '任务已取消' })
      return { cancelled: true, id: task.id, message: '任务已取消，后台已确认。' }
    }
    return { cancelled: false, message: result?.state === 'completed' ? '任务刚刚已完成，结果仍然保留。' : '取消请求已发送，正在等待后台收尾。' }
  } catch { return { cancelled: false, message: '未能确认取消，请在任务与结果中查看状态。' } }
  finally { off?.(); if (timer) clearTimeout(timer) }
}
