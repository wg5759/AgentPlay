import type { RefObject } from 'react'
import type { AgentDocumentAttachment, AgentTask } from '../../stores/agentStore'

type Options = {
  selectTask: (id: string) => void
  closeTaskCenter: () => void
  setAttachments: (next: AgentDocumentAttachment[]) => void
  setInputText: (value: string) => void
  inputRef: RefObject<HTMLInputElement>
}

export default function useContinueTask({ selectTask, closeTaskCenter, setAttachments, setInputText, inputRef }: Options) {
  return async (selectedTask: AgentTask) => {
    selectTask(selectedTask.id)
    closeTaskCenter()
    const outputs = selectedTask.outputs || []
    const mediaOutput = outputs.find((output) => /\.(?:mp4|mkv|mov|webm|avi|m4v|wmv|flv|ts)$/i.test(output))
    if (mediaOutput) window.dispatchEvent(new CustomEvent('ai-player-play-file', { detail: mediaOutput }))
    const attachable = outputs.filter((output) => !/\.(?:mp4|mkv|mov|webm|avi|m4v|wmv|flv|ts)$/i.test(output))
    if (attachable.length > 0) {
      const attached = await window.aiPlayer?.documents?.attachPaths(attachable)
      if (Array.isArray(attached)) setAttachments(attached)
    }
    setInputText(`继续修改“${selectedTask.label}”的结果：`)
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }
}
