const GENERIC_STAGES = ['准备任务', '执行处理', '验证结果']

const STAGES_BY_KIND = {
  download: ['校验链接', '下载视频'],
  'link-analysis': ['获取内容', '理解画面', '生成报告'],
  doc: ['读取文件', '理解需求', '生成成果'],
  analysis: ['读取媒体', '分析内容', '生成报告'],
  media: ['校验素材', '执行处理', '验证结果'],
  creative: ['冻结方案', '云端生成', '验证成片']
}

const COMPLETED_LABEL_BY_KIND = {
  download: '下载完成',
  'link-analysis': '分析完成',
  doc: '文档完成',
  analysis: '分析完成',
  media: '处理完成'
}

const RUNNING_LABEL_BY_KIND = {
  download: '正在下载',
  'link-analysis': '正在分析',
  doc: '正在处理文档',
  analysis: '正在分析',
  media: '正在处理'
}

const normalizeActiveStage = (task, stages) => {
  if (task.phase === 'completed') return stages.length - 1
  if (task.phase === 'failed' || task.phase === 'cancelled') return Math.max(0, Math.min(stages.length - 1, Number(task.progress || 0) > 0 ? Math.floor(Number(task.progress) / (100 / stages.length)) : 0))
  if (task.kind === 'download') return /下载|合并|写入|保存/i.test(task.status || '') ? 1 : 0
  if (Number.isFinite(task.progress) && task.progress !== null) return Math.max(0, Math.min(stages.length - 1, Math.floor(Number(task.progress) / (100 / stages.length))))
  if (task.outputs?.length) return Math.max(0, stages.length - 2)
  const status = String(task.status || '')
  if (/验证|核对|保存|写入|回读|质量/.test(status)) return stages.length - 1
  if (/理解|分析|生成|执行|处理|转写|翻译|编码|下载/.test(status)) return Math.min(1, stages.length - 1)
  return 0
}

export function taskTimingForTask(task = {}) {
  if (!['queued', 'running', 'waiting'].includes(task.phase) && !task.running) return ''
  const status = String(task.status || '')
  const explicit = status.match(/(?:预计|约需|约)\s*[^；。\n]{1,40}(?:秒|分钟|小时)/)?.[0]
  if (explicit) return explicit
  if (task.kind === 'download') return '时间取决于文件大小和网络，只显示真实下载百分比'
  if (task.kind === 'doc') return '短文通常 1–3 分钟；多格式按完成份数续跑'
  if (task.kind === 'analysis' || task.kind === 'link-analysis') return '通常约视频时长的 0.5–2 倍，取决于转写和模型'
  if (task.kind === 'creative') return '每个云端镜头通常约 1–2 分钟'
  if (task.kind === 'media') return '通常几十秒到数分钟，取决于素材时长和编码'
  return '耗时取决于素材规模；未知时使用动态状态，不显示假倒计时'
}

export function workspaceJourneyForTask(task = {}) {
  const stages = STAGES_BY_KIND[task.kind] || GENERIC_STAGES
  let eyebrow = '当前内容'
  if (task.phase === 'completed') eyebrow = COMPLETED_LABEL_BY_KIND[task.kind] || '处理完成'
  else if (task.phase === 'failed') eyebrow = '处理失败'
  else if (task.phase === 'cancelled') eyebrow = '已取消'
  else if (task.phase === 'waiting') eyebrow = /确认|允许|审批/.test(task.status || '') ? '等待确认' : '等待处理'
  else if (task.phase === 'queued') eyebrow = '等待开始'
  else if (task.phase === 'running' || task.running) eyebrow = RUNNING_LABEL_BY_KIND[task.kind] || '正在处理'

  return { eyebrow, stages: [...stages], activeStage: normalizeActiveStage(task, stages) }
}
