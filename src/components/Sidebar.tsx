import { useState } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { useAgentStore } from '../stores/agentStore'
import { useThemeStore, THEMES } from '../stores/themeStore'
import UiIcon, { type UiIconName } from './UiIcon'

interface Props {
  pinned: boolean
  onTogglePin: () => void
  onOpenLibrary: () => void
  onOpenModelCenter: () => void
  onOpenOnlineMedia: () => void
  onOpenSmartCast: () => void
}

export default function Sidebar({ pinned, onTogglePin, onOpenLibrary, onOpenModelCenter, onOpenOnlineMedia, onOpenSmartCast }: Props) {
  const recentMedia = usePlayerStore((state) => state.recentMedia)
  const tasks = useAgentStore((state) => state.tasks)
  const selectTask = useAgentStore((state) => state.selectTask)
  const theme = useThemeStore((state) => state.theme)
  const setTheme = useThemeStore((state) => state.setTheme)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [recentOpen, setRecentOpen] = useState(false)

  const closePanels = () => {
    setDrawerOpen(false)
    setRecentOpen(false)
  }

  const handleOpen = () => {
    closePanels()
    window.dispatchEvent(new CustomEvent('ai-player-ask-open-mode'))
  }

  const openAnalysisChat = () => {
    closePanels()
    const store = useAgentStore.getState()
    store.openPanel()
    if (store.messages.length === 0) {
      store.addMessage('agent', '把 B站/YouTube/抖音等视频链接粘贴发给我，就自动下载并开始拉片；也可以先用「打开」选一个本地视频，然后对我说“深度解剖这个视频”。')
    } else {
      store.addMessage('agent', '想拉片的话：粘贴视频链接发来即自动下载解剖；或先用「打开」选个本地视频，对我说“深度解剖这个视频”。')
    }
  }

  const run = (action: () => void) => {
    closePanels()
    action()
  }

  const capabilities: Array<{ icon: UiIconName; label: string; description: string; action: () => void; accent?: boolean }> = [
    { icon: 'open', label: '打开', description: '文件、文件夹或媒体', action: handleOpen, accent: true },
    { icon: 'analysis', label: '拉片', description: '下载并深度剖析视频', action: openAnalysisChat },
    { icon: 'cast', label: '投屏', description: '电视与 AgentPlay 设备', action: () => run(onOpenSmartCast) },
    { icon: 'file', label: '本地媒体', description: '最近文件与文件夹', action: () => run(onOpenLibrary) },
    { icon: 'globe', label: '在线媒体库', description: '合法公版媒体内容', action: () => run(onOpenOnlineMedia) },
    { icon: 'model', label: '模型接入中心', description: '云端、本地与组件下载', action: () => run(onOpenModelCenter) }
  ]

  const railButton = (name: UiIconName, label: string, onClick: () => void, active = false) => (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={'workspace-rail-button' + (active ? ' workspace-rail-button-active' : '')}>
      <UiIcon name={name} size={19} />
    </button>
  )

  return (
    <div className="workspace-rail">
      <button type="button" className="workspace-brand-mark" title="AgentPlay 首页" aria-label="AgentPlay 首页" onClick={closePanels}>
        <UiIcon name="agent" size={28} />
      </button>

      <nav className="workspace-rail-nav" aria-label="主要导航">
        {railButton('home', '首页', () => {
          closePanels()
          useAgentStore.getState().openPanel()
        }, !recentOpen && !drawerOpen)}
        {railButton('history', '最近记录', () => {
          setRecentOpen((value) => !value)
          setDrawerOpen(false)
        }, recentOpen)}
      </nav>

      <div className="workspace-rail-footer">
        {railButton('grid', '全部能力', () => {
          setDrawerOpen((value) => !value)
          setRecentOpen(false)
        }, drawerOpen)}
      </div>

      {recentOpen && (
        <section className="workspace-flyout workspace-recent-flyout" aria-label="最近记录">
          <div className="workspace-flyout-heading">
            <div><p className="workspace-eyebrow">最近记录</p><h2>继续任务或重新播放</h2></div>
            <button type="button" onClick={() => setRecentOpen(false)} aria-label="关闭最近记录"><UiIcon name="close" size={17} /></button>
          </div>
          <div className="workspace-recent-list">
            {tasks.length === 0 && recentMedia.length === 0 && <div className="workspace-empty-note"><UiIcon name="history" size={20} /><span>还没有任务或播放记录</span></div>}
            {tasks.length > 0 && <p className="workspace-recent-divider">任务记录 · {Math.min(tasks.length, 10)}</p>}
            {tasks.slice(0, 10).map((task) => (
              <button type="button" key={task.id} onClick={() => { selectTask(task.id); useAgentStore.getState().openPanel(); window.dispatchEvent(new CustomEvent('agentplay-open-task-center')); closePanels() }} title={task.source || task.instruction} className={'workspace-recent-item workspace-task-item workspace-task-item-' + task.phase}>
                <span className="workspace-recent-icon"><UiIcon name={task.kind === 'analysis' || task.kind === 'link-analysis' ? 'analysis' : task.kind === 'download' || task.kind === 'media' ? 'video' : 'report'} size={16} /></span>
                <span className="min-w-0 flex-1">
                  <strong>{task.label}</strong>
                  <small>{task.phase === 'completed' ? `已完成 · ${task.outputs.length} 个结果` : task.phase === 'running' ? task.status || '执行中' : task.phase === 'waiting' ? '等你确认' : task.phase === 'interrupted' ? '已中断，可重试' : task.error || '等待处理'}</small>
                </span>
              </button>
            ))}
            {recentMedia.length > 0 && <p className="workspace-recent-divider">播放记录 · {recentMedia.length}</p>}
            {recentMedia.map((item) => (
              <button type="button" key={item.src} onClick={() => { usePlayerStore.getState().setMedia(item.name, item.src); closePanels() }} title={item.src} className="workspace-recent-item">
                <span className="workspace-recent-icon"><UiIcon name="video" size={16} /></span>
                <span className="min-w-0 flex-1"><strong>{item.name}</strong><small>{new Date(item.openedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small></span>
              </button>
            ))}
          </div>
        </section>
      )}

      {drawerOpen && (
        <section className="workspace-flyout workspace-capability-flyout" aria-label="全部能力">
          <div className="workspace-flyout-heading">
            <div><p className="workspace-eyebrow">全部能力</p><h2>需要时再打开</h2></div>
            <button type="button" onClick={() => setDrawerOpen(false)} aria-label="关闭全部能力"><UiIcon name="close" size={17} /></button>
          </div>
          <div className="workspace-capability-grid">
            {capabilities.map((item) => (
              <button type="button" key={item.label} onClick={item.action} className={'workspace-capability-card' + (item.accent ? ' workspace-capability-card-accent' : '')}>
                <span><UiIcon name={item.icon} size={20} /></span>
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </button>
            ))}
          </div>
          <div className="workspace-backstage">
            <div className="workspace-backstage-title">
              <span><UiIcon name="palette" size={16} /> 界面气质</span>
              <button type="button" onClick={onTogglePin} title={pinned ? '播放时自动隐藏入口栏' : '播放时保留入口栏'}>
                <UiIcon name="pin" size={15} /> {pinned ? '已固定' : '播放时隐藏'}
              </button>
            </div>
            <div className="workspace-theme-row">
              {THEMES.map((item) => <button type="button" key={item.id} onClick={() => setTheme(item.id)} className={item.id === theme ? 'is-active' : ''}>{item.name}</button>)}
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
