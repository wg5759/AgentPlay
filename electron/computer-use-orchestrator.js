const ALLOWED_ACTIONS = new Set(['click', 'double_click', 'right_click', 'mouse_move', 'type', 'scroll', 'key', 'wait', 'done', 'ask_user'])

function finiteNumber(value, label) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${label} 必须是有限数字`)
  return number
}

function normalizeCoordinate(value, extent, label) {
  let number = finiteNumber(value, label)
  if (number > 1 && extent > 1) number /= extent
  if (number < 0 || number > 1) throw new Error(`${label} 坐标越界`)
  return number
}

function validateRecommendation(raw, observation) {
  if (!raw || typeof raw !== 'object') throw new Error('模型没有返回有效动作')
  if (raw.frameId !== observation.frameId) throw new Error('画面已变化，建议已失效')
  const source = typeof raw.action === 'string' ? raw : (raw.action || {})
  const type = String(typeof raw.action === 'string' ? raw.action : source.type || source.action || '').toLowerCase()
  if (!ALLOWED_ACTIONS.has(type)) throw new Error(`不支持的动作: ${type || '空'}`)

  const action = { type }
  if (['click', 'double_click', 'right_click', 'mouse_move'].includes(type)) {
    action.x = normalizeCoordinate(source.x ?? raw.x, observation.width, 'x')
    action.y = normalizeCoordinate(source.y ?? raw.y, observation.height, 'y')
    if (type !== 'mouse_move') {
      action.button = type === 'right_click' ? 'right' : String(source.button || raw.button || 'left')
      if (!['left', 'right'].includes(action.button)) throw new Error('不支持的鼠标按键')
    }
  } else if (type === 'type') {
    action.text = String(source.text ?? raw.text ?? '').slice(0, 2000)
    if (!action.text) throw new Error('输入动作缺少文字')
  } else if (type === 'scroll') {
    action.deltaY = Math.max(-2000, Math.min(2000, finiteNumber(source.deltaY ?? raw.deltaY ?? 0, '滚动距离')))
  } else if (type === 'key') {
    action.key = String(source.key ?? raw.key ?? '').slice(0, 40)
    if (!action.key) throw new Error('按键动作缺少键名')
  }

  return {
    frameId: observation.frameId,
    action,
    reason: String(raw.reason || source.reason || '模型未提供理由').slice(0, 1000)
  }
}

class ComputerUseOrchestrator {
  constructor({ capture, provider }) {
    if (typeof capture !== 'function') throw new Error('缺少安全截图服务')
    if (!provider || typeof provider.suggest !== 'function') throw new Error('缺少 ComputerUse Provider')
    this.capture = capture
    this.provider = provider
  }

  async suggest({ task, config, signal, onStatus }) {
    const normalizedTask = String(task || '').trim().slice(0, 2000)
    if (!normalizedTask) throw new Error('请先填写要观察的任务')
    onStatus?.('capturing')
    const observation = await this.capture()
    onStatus?.('thinking')
    const raw = await this.provider.suggest({ task: normalizedTask, observation, config, signal })
    const recommendation = validateRecommendation(raw, observation)
    onStatus?.('ready')
    return {
      mode: 'observe-only',
      observation,
      recommendation,
      warning: '观察模式不会执行任何鼠标、键盘、文件或系统操作。'
    }
  }
}

module.exports = { ALLOWED_ACTIONS, validateRecommendation, ComputerUseOrchestrator }
