import { useCallback, useState, type ReactNode } from 'react'
import { useAgentStore } from '../stores/agentStore'
import { usePlayerStore } from '../stores/playerStore'
import { workspaceJourneyForTask } from '../workspace-journey-policy.mjs'
import UiIcon from './UiIcon'

interface Props {
  rightOpen: boolean
  sidebar: (props: { pinned: boolean; onTogglePin: () => void }) => ReactNode
  center: ReactNode
  right: ReactNode
}

export default function Workbench({ rightOpen, sidebar, center, right }: Props) {
  const theater = usePlayerStore((state) => state.theater)
  const mediaName = usePlayerStore((state) => state.mediaName)
  const task = useAgentStore((state) => state.task)
  const tasks = useAgentStore((state) => state.tasks)
  const journeyTask = tasks.find((item) => ['queued', 'running', 'waiting'].includes(item.phase)) || task
  const [pinned, setPinned] = useState(() => localStorage.getItem('aiplayer_left_pinned') === '1')

  const togglePin = useCallback(() => {
    setPinned((value) => {
      localStorage.setItem('aiplayer_left_pinned', value ? '0' : '1')
      return !value
    })
  }, [])

  const showRail = !theater && (!rightOpen || pinned)
  const journey = workspaceJourneyForTask(journeyTask)

  return (
    <div className={'workspace-shell' + (theater ? ' workspace-theater' : '')}>
      {showRail && <aside className="workspace-rail-shell">{sidebar({ pinned, onTogglePin: togglePin })}</aside>}

      <section key="stage" className="workspace-stage">
        <header className={'workspace-topbar' + (rightOpen ? ' workspace-topbar-focus' : '')}>
          <div className="workspace-topbar-title">
            {!showRail && <span className="workspace-inline-brand"><UiIcon name="agent" size={22} /></span>}
            <div>
              <span>{rightOpen ? journey.eyebrow : 'AgentPlay'}</span>
              <strong>{rightOpen ? mediaName || '当前内容' : '今天 / 新任务'}</strong>
            </div>
          </div>

          {rightOpen ? (
            <ol className="workspace-journey" aria-label="任务进度">
              {journey.stages.map((stage, index) => (
                <li key={stage} className={index <= journey.activeStage ? 'is-active' : ''}><span>{stage}</span><i /></li>
              ))}
            </ol>
          ) : (
            <div className="workspace-topbar-trust"><UiIcon name="shield" size={15} /><span>本地优先，云端前会询问</span></div>
          )}

          <div className="workspace-profile" title="运行与隐私设置"><span>AP</span></div>
        </header>

        {!rightOpen ? (
          <main className="workspace-home-main">{center}</main>
        ) : (
          <div className="workspace-focus-body">
            <section className="workspace-focus-canvas" aria-label="当前内容">{right}</section>
            <aside className="workspace-focus-assistant" aria-label="AgentPlay 助手">{center}</aside>
          </div>
        )}
      </section>
    </div>
  )
}
