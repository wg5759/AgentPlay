// 统一设备抽象（DeepSeek 方案）-- Agent 只看到 Device，不感知底层协议
export type DeviceType = 'wifi' | 'printer' | 'cast_target' | 'scanner'
export type DeviceStatus = 'online' | 'offline' | 'busy' | 'error'

export interface Device {
  id: string
  name: string
  type: DeviceType
  subtype: string
  status: DeviceStatus
  capabilities: string[]
  metadata: Record<string, unknown>
}

export interface DeviceActionResult {
  success: boolean
  data?: unknown
  error?: string
}

export interface DeviceManager {
  scan(type: DeviceType): Promise<Device[]>
  connect(id: string, credentials?: unknown): Promise<boolean>
  disconnect(id: string): Promise<void>
  execute(id: string, action: string, params?: unknown): Promise<DeviceActionResult>
  onDeviceFound(cb: (device: Device) => void): void
  onDeviceLost(cb: (deviceId: string) => void): void
}
