// Agent 工具注册表（占位）
// 参考 DeepSeek 方案：25 个工具分 5 组（播放控制/检索/设备/投屏/AI处理）
// Phase 1 接入 LLM function calling（桌面 node-llama-cpp / Web 云端 API）

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  localOnly?: boolean
  requiresConfirmation?: boolean
}

export const TOOL_REGISTRY: ToolDefinition[] = [
  // 1. 播放控制（6 个，localOnly）
  { name: 'media_play', description: '播放指定媒体', parameters: { file_path: 'string' }, localOnly: true },
  { name: 'media_pause', description: '暂停', parameters: {}, localOnly: true },
  { name: 'media_seek', description: '跳转到指定位置', parameters: { position_seconds: 'number' }, localOnly: true },
  { name: 'media_set_volume', description: '设置音量', parameters: { level: 'number' }, localOnly: true },
  { name: 'media_set_subtitle', description: '设置字幕轨', parameters: { track_index: 'number' }, localOnly: true },
  { name: 'media_set_audio_track', description: '设置音轨', parameters: { track_index: 'number' }, localOnly: true },
  // 2. 媒体检索（5 个）-- TODO
  // 3. 设备操作（5 个，写操作需确认）-- TODO
  // 4. 投屏（3 个）-- TODO
  // 5. AI 处理（6 个，云端）-- TODO
]

// TODO: 接入 LLM function calling
// 桌面端：node-llama-cpp + Qwen2.5-7B GGUF Q4_K_M
// Web 端：云端 API（GPT-4o / Claude / DeepSeek）
// 意图分类 -> 本地 <100ms；复杂推理 -> 云端 2-5s
