import { useEffect, useMemo, useState } from 'react'

interface Provider {
  id: string
  name: string
  region: string
  protocol: 'openai' | 'anthropic' | 'gemini' | 'cli'
  baseUrl: string
  models: string[]
  requiresKey: boolean
  modelHint?: string
  roles: Array<'chat' | 'computerUse'>
  capabilities: { streaming?: boolean; tools?: boolean; vision?: boolean; computerUse?: boolean }
  contextWindow?: number
  maxOutputTokens?: number
  pricing?: { cachedInputUsdPerMillion?: number; inputUsdPerMillion: number; outputUsdPerMillion: number }
  modelProfiles?: Record<string, { contextWindow?: number; maxOutputTokens?: number; thinkingMode?: 'enabled' | 'disabled'; pricing?: { cachedInputUsdPerMillion?: number; inputUsdPerMillion: number; outputUsdPerMillion: number } }>
  pricingUrl?: string
  pricingVerifiedAt?: string
  warning?: string
  bundled?: boolean
}

interface DiscoveredService {
  id: string
  name: string
  providerId: string
  baseUrl: string
  models: string[]
}

type ModelRole = 'chat' | 'computerUse'

interface ModelCenterIntent {
  providerId?: string
  model?: string
  reason?: string
}

interface Props {
  onClose: () => void
  intent?: ModelCenterIntent | null
}

export default function ModelCenter({ onClose, intent }: Props) {
  const [providers, setProviders] = useState<Provider[]>([])
  const [role, setRole] = useState<ModelRole>('chat')
  const [providerId, setProviderId] = useState('deepseek')
  const [model, setModel] = useState('deepseek-v4-flash')
  const [thinkingMode, setThinkingMode] = useState<'enabled' | 'disabled'>('enabled')
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com/v1')
  const [apiKey, setApiKey] = useState('')
  const [hasApiKey, setHasApiKey] = useState(false)
  const [remoteModels, setRemoteModels] = useState<string[]>([])
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [discovered, setDiscovered] = useState<DiscoveredService[]>([])
  const [bundledStatus, setBundledStatus] = useState<BundledModelStatus | null>(null)
  // 安全接入：用户先选 Key 来源，只验证这一家，避免凭证被发送给其他厂商。
  const [oneKey, setOneKey] = useState('')
  const [oneKeyProviderId, setOneKeyProviderId] = useState('agnes')
  const [oneKeyBusy, setOneKeyBusy] = useState(false)
  const [oneKeyError, setOneKeyError] = useState('')
  const [oneKeyMatches, setOneKeyMatches] = useState<Array<{ providerId: string; providerName: string; models: string[]; latencyMs: number }>>([])
  const [oneKeyModelPick, setOneKeyModelPick] = useState<Record<string, string>>({})
  const [showKey, setShowKey] = useState(false)
  const [showLocalPacks, setShowLocalPacks] = useState(false)
  const [cliStatus, setCliStatus] = useState<{ codex: { installed: boolean; loggedIn: boolean; note: string }; claude: { installed: boolean; loggedIn: boolean; note: string } } | null>(null)
  const [whisperStatus, setWhisperStatus] = useState<{ available: boolean; smallAvailable?: boolean; reason: string; download: Partial<LocalAiDownloadProgress> & { active: boolean }; smallDownload?: Partial<LocalAiDownloadProgress> & { active: boolean }; pack: { totalBytes: number }; smallPack?: { totalBytes: number } } | null>(null)
  const [whisperError, setWhisperError] = useState('')
  const [translateStatus, setTranslateStatus] = useState<{ available: boolean; reason: string; download: Partial<LocalAiDownloadProgress> & { active: boolean }; pack: { totalBytes: number } } | null>(null)
  const [translateError, setTranslateError] = useState('')
  const [rapidocrStatus, setRapidocrStatus] = useState<{ available: boolean; reason: string; download: Partial<LocalAiDownloadProgress> & { active: boolean }; pack: { totalBytes: number } } | null>(null)
  const [rapidocrError, setRapidocrError] = useState('')
  const [unlimitedOcrStatus, setUnlimitedOcrStatus] = useState<{ enabled: boolean; ready: boolean; reason: string; baseUrl: string; model: string; local: boolean; hasApiKey: boolean } | null>(null)
  const [unlimitedOcrUrl, setUnlimitedOcrUrl] = useState('http://127.0.0.1:8000/v1')
  const [unlimitedOcrModel, setUnlimitedOcrModel] = useState('baidu/Unlimited-OCR')
  const [unlimitedOcrKey, setUnlimitedOcrKey] = useState('')
  const [siteStatus, setSiteStatus] = useState<{ available: boolean; reason: string; download: Partial<LocalAiDownloadProgress> & { active: boolean }; pack: { totalBytes: number } } | null>(null)
  const [siteError, setSiteError] = useState('')
  const [downloadProgress, setDownloadProgress] = useState<LocalAiDownloadProgress | null>(null)
  const [downloadActive, setDownloadActive] = useState(false)
  const [downloadError, setDownloadError] = useState('')
  const [packBytes, setPackBytes] = useState(0)
  const [planUpgrade, setPlanUpgrade] = useState<{ providerId: string; baseUrl: string; model: string; models: string[] } | null>(null)
  const [routingStatus, setRoutingStatus] = useState<ModelRoutingStatus | null>(null)
  const [showAdvancedModelSetup, setShowAdvancedModelSetup] = useState(false)
  const [requestedPreference, setRequestedPreference] = useState<'smart' | 'local' | 'cloud' | null>(null)
  const [showSmartEnhancement, setShowSmartEnhancement] = useState(false)

  const roleProviders = useMemo(
    () => providers.filter((item) => item.roles.includes(role) && (!item.bundled || bundledStatus?.assetsPresent)),
    [bundledStatus?.assetsPresent, providers, role]
  )
  const provider = roleProviders.find((item) => item.id === providerId)
  const modelOptions = useMemo(
    () => [...new Set([...(remoteModels || []), ...(provider?.models || [])])],
    [provider, remoteModels]
  )
  const selectedModelProfile = provider?.modelProfiles?.[model]
  const connectedServices = useMemo(() => {
    const seen = new Set<string>()
    return (routingStatus?.candidates || []).filter((candidate) => {
      const key = `${candidate.providerId}\u0000${candidate.baseUrl}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [routingStatus?.candidates])
  const hasCloud = connectedServices.some((candidate) => !candidate.localOnly)
  const routingPreference = requestedPreference || routingStatus?.settings?.preference
  const showCloudConnect = role === 'chat' && Boolean(
    intent?.providerId
    || (routingPreference === 'cloud' && !hasCloud)
    || (routingPreference === 'smart' && showSmartEnhancement && !hasCloud)
  )

  useEffect(() => {
    let active = true
    Promise.all([
      window.aiPlayer?.models?.providers(),
      window.aiPlayer?.models?.config('chat'),
      window.aiPlayer?.models?.bundledStatus(),
      window.aiPlayer?.localAI?.status(),
      window.aiPlayer?.models?.routingStatus?.()
    ]).then(([items, saved, localStatus, localAiStatus, nextRoutingStatus]) => {
      if (!active) return
      const nextProviders = items || []
      setProviders(nextProviders)
      setBundledStatus(localStatus || null)
      setRoutingStatus(nextRoutingStatus || null)
      setPackBytes(localAiStatus?.pack?.totalBytes || 0)
      setDownloadActive(Boolean(localAiStatus?.download?.active))
      const intended = intent?.providerId ? nextProviders.find((item) => item.id === intent.providerId) : null
      if (intended) {
        setRole('chat')
        setRequestedPreference('cloud')
        setOneKeyProviderId(intended.id)
        setProviderId(intended.id)
        setModel(intent?.model && intended.models.includes(intent.model) ? intent.model : intended.models[0])
        setThinkingMode((intent?.model && intended.models.includes(intent.model)
          ? intended.modelProfiles?.[intent.model]?.thinkingMode
          : intended.modelProfiles?.[intended.models[0]]?.thinkingMode) || 'enabled')
        setBaseUrl(intended.baseUrl)
        setHasApiKey(Boolean(saved?.providerId === intended.id && saved.hasApiKey))
        setStatus(intent?.reason || `已为你定位到 ${intended.name}，填写 Key 后测试并保存即可`)
      } else if (saved && !(saved.providerId === 'bundled-lite' && !localStatus?.assetsPresent)) {
        setProviderId(saved.providerId)
        setModel(saved.model)
        setThinkingMode(saved.thinkingMode || nextProviders.find((item) => item.id === saved.providerId)?.modelProfiles?.[saved.model]?.thinkingMode || 'enabled')
        setBaseUrl(saved.baseUrl)
        setHasApiKey(saved.hasApiKey)
      } else if (nextProviders.length) {
        const initial = nextProviders.find((item) => item.id === 'deepseek') || nextProviders[0]
        setProviderId(initial.id)
        setModel(initial.models[0])
        setThinkingMode(initial.modelProfiles?.[initial.models[0]]?.thinkingMode || 'enabled')
        setBaseUrl(initial.baseUrl)
      }
    }).catch((error) => {
      if (!active) return
      setStatus(`读取 AI 状态失败：${error instanceof Error ? error.message : String(error)}`)
    })
    const offProgress = window.aiPlayer?.localAI?.onProgress?.((progress) => {
      if (!active) return
      setDownloadProgress(progress)
      setDownloadActive(progress.stage !== 'done')
      if (progress.stage === 'done') {
        void window.aiPlayer?.models?.bundledStatus().then((next) => { if (active && next) setBundledStatus(next) })
      }
    })
    void window.aiPlayer?.transcribe?.status().then((status) => { if (active && status) setWhisperStatus(status) })
    void window.aiPlayer?.models?.cliStatus?.().then((status) => { if (active && status) setCliStatus(status) })
    const offWhisper = window.aiPlayer?.transcribe?.onProgress?.(() => {
      void window.aiPlayer?.transcribe?.status().then((status) => { if (active && status) setWhisperStatus(status) })
    })
    void window.aiPlayer?.translatePack?.status().then((status) => { if (active && status) setTranslateStatus(status) })
    const offTranslate = window.aiPlayer?.translatePack?.onProgress?.(() => {
      void window.aiPlayer?.translatePack?.status().then((status) => { if (active && status) setTranslateStatus(status) })
    })
    void window.aiPlayer?.rapidocrPack?.status().then((status) => { if (active && status) setRapidocrStatus(status) })
    void window.aiPlayer?.unlimitedOcr?.status().then((next) => {
      if (!active || !next) return
      setUnlimitedOcrStatus(next)
      setUnlimitedOcrUrl(next.baseUrl)
      setUnlimitedOcrModel(next.model)
    })
    const offRapidocr = window.aiPlayer?.rapidocrPack?.onProgress?.(() => {
      void window.aiPlayer?.rapidocrPack?.status().then((status) => { if (active && status) setRapidocrStatus(status) })
    })
    void window.aiPlayer?.siteVideo?.status().then((status) => { if (active && status) setSiteStatus(status) })
    const offSite = window.aiPlayer?.siteVideo?.onComponentProgress?.(() => {
      void window.aiPlayer?.siteVideo?.status().then((status) => { if (active && status) setSiteStatus(status) })
    })
    return () => { active = false; offProgress?.(); offWhisper?.(); offTranslate?.(); offRapidocr?.(); offSite?.() }
  }, [])

  const changeRole = async (nextRole: ModelRole) => {
    setRole(nextRole)
    if (nextRole === 'computerUse') setShowAdvancedModelSetup(true)
    setBusy(true)
    setStatus('正在加载该角色的独立配置…')
    const saved = await window.aiPlayer?.models?.config(nextRole)
    setBusy(false)
    setRemoteModels([])
    setDiscovered([])
    setApiKey('')
    if (saved) {
      setProviderId(saved.providerId)
      setModel(saved.model)
      setThinkingMode(saved.thinkingMode || providers.find((item) => item.id === saved.providerId)?.modelProfiles?.[saved.model]?.thinkingMode || 'enabled')
      setBaseUrl(saved.baseUrl)
      setHasApiKey(saved.hasApiKey)
    } else {
      const initial = providers.find((item) => item.roles.includes(nextRole))
      if (initial) changeProvider(initial.id)
    }
    setStatus('')
  }

  const changeProvider = (id: string) => {
    const next = roleProviders.find((item) => item.id === id)
    if (!next) return
    setProviderId(id)
    setModel(next.models[0] || '')
    setThinkingMode(next.modelProfiles?.[next.models[0]]?.thinkingMode || 'enabled')
    setBaseUrl(next.baseUrl)
    setApiKey('')
    setHasApiKey(false)
    setRemoteModels([])
    setStatus('')
  }

  const connectionInput = () => ({
    providerId,
    role,
    model,
    ...(providerId === 'deepseek' ? { thinkingMode } : {}),
    baseUrl,
    apiKey,
    useSavedKey: hasApiKey && !apiKey
  })

  // 订阅类厂商（cli）没有 /models 端点：直接用本地 catalog/官方 CLI 缓存清单
  const refreshModels = async () => {
    setBusy(true)
    if (provider?.protocol === 'cli') {
      setRemoteModels(modelOptions)
      if (modelOptions.length && !modelOptions.includes(model)) setModel(modelOptions[0])
      setStatus(`已就绪 ${modelOptions.length} 个模型（来自官方 CLI 缓存，随周更自动最新）`)
      setBusy(false)
      return
    }
    setStatus('正在读取账户可用模型…')
    const result = await window.aiPlayer?.models?.list(connectionInput())
    setBusy(false)
    if (!result?.success) {
      setStatus(`读取失败：${result?.error || '未知错误'}`)
      return
    }
    setRemoteModels(result.models)
    if (result.models.length && !result.models.includes(model)) setModel(result.models[0])
    setStatus(`已读取 ${result.models.length} 个可用模型`)
  }

  const discoverLocal = async () => {
    setBusy(true)
    setStatus('正在查找本机已启动的模型服务…')
    try {
      const results = await window.aiPlayer?.models?.discoverLocal(role) || []
      setDiscovered(results)
      setStatus(results.length ? `✓ 找到 ${results.length} 个本地模型服务` : '没有发现已启动的本地模型服务；请先启动 Ollama、LM Studio、vLLM、llama.cpp 或 Fara 服务。')
    } catch (error) {
      setStatus(`发现失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const useDiscovered = (service: DiscoveredService) => {
    const next = roleProviders.find((item) => item.id === service.providerId)
    if (!next) return
    setProviderId(next.id)
    setBaseUrl(service.baseUrl)
    setRemoteModels(service.models)
    setModel(service.models[0] || next.models[0] || '')
    setApiKey('')
    setHasApiKey(false)
    setStatus(`已填入 ${service.name}，请测试连接后保存。`)
  }

  const startLocalAiDownload = async () => {
    setDownloadError('')
    setDownloadActive(true)
    try {
      const result = await window.aiPlayer?.localAI?.download()
      if (!result) throw new Error('桌面本地下载接口不可用')
      if (!result.success) throw new Error(result.error || '下载失败')
      if (result.status) setBundledStatus(result.status)
      await startBundled()
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : String(error))
    } finally {
      setDownloadActive(false)
      setDownloadProgress(null)
    }
  }

  const cancelLocalAiDownload = async () => {
    await window.aiPlayer?.localAI?.cancel()
  }

  const applyMatch = async (match: { providerId: string; providerName: string; models: string[]; latencyMs: number }) => {
    const matchedProvider = roleProviders.find((item) => item.id === match.providerId)
    const preferred = matchedProvider?.models?.[0]
    const defaultModel = preferred && match.models.includes(preferred) ? preferred : match.models[0]
    const modelToUse = oneKeyModelPick[match.providerId] || defaultModel
    setStatus('正在验证文本、看图和工具能力（少量测试请求）…')
    const verified = role === 'chat' ? await window.aiPlayer?.models?.verify({ role, providerId: match.providerId, model: modelToUse, baseUrl: matchedProvider?.baseUrl || '', apiKey: oneKey.trim() }) : { success: true, message: '专用连接已保存，请使用测试连接验证。' }
    if (!verified?.success) throw new Error(verified?.message || '模型验证未完成，连接尚未保存')
    const saved = await window.aiPlayer?.models?.save({
      role,
      providerId: match.providerId,
      model: modelToUse,
      baseUrl: matchedProvider?.baseUrl || '',
      apiKey: oneKey.trim()
    })
    if (!saved) throw new Error('云端服务保存失败')

    setOneKeyMatches([])
    setOneKey('')
    window.dispatchEvent(new CustomEvent('ai-player-models-changed'))
    if (requestedPreference) {
      const objective = requestedPreference === 'cloud' ? 'quality' : requestedPreference === 'local' ? 'economy' : 'balanced'
      const next = await window.aiPlayer?.models?.routingSettings?.({ preference: requestedPreference, objective })
      if (next) setRoutingStatus(next)
      else await refreshRoutingStatus()
      setRequestedPreference(null)
    } else {
      await refreshRoutingStatus()
    }
    const config = await window.aiPlayer?.models?.config(role)
    if (config) {
      setProviderId(config.providerId)
      setModel(config.model)
      setThinkingMode(config.thinkingMode || roleProviders.find((item) => item.id === config.providerId)?.modelProfiles?.[config.model]?.thinkingMode || 'enabled')
      setBaseUrl(config.baseUrl)
      setHasApiKey(config.hasApiKey)
    }
    setShowSmartEnhancement(false)
    setStatus(`✓ 已接入 ${match.providerName}（${modelToUse}）。${verified.message}`)
  }

  const runAutoDetect = async () => {
    setOneKeyBusy(true)
    setOneKeyError('')
    setOneKeyMatches([])
    try {
      const result = await window.aiPlayer?.models?.autoDetect?.({ apiKey: oneKey.trim(), providerId: oneKeyProviderId })
      if (!result?.success || !result.matches?.length) throw new Error(result?.error || '没有识别到可用厂商')
      if (result.matches.length === 1) {
        await applyMatch(result.matches[0])
        return
      }
      setOneKeyMatches(result.matches)
    } catch (error) {
      setOneKeyError(error instanceof Error ? error.message : String(error))
    } finally {
      setOneKeyBusy(false)
    }
  }

  const changeRoutingPreference = async (preference: 'smart' | 'local' | 'cloud') => {
    if (!routingStatus || !bundledStatus) {
      setStatus('正在读取本机和云端状态，请稍候…')
      return
    }
    setRequestedPreference(preference)
    if (preference !== 'smart') setShowSmartEnhancement(false)
    if (preference === 'cloud' && !hasCloud) {
      setStatus('要优先效果，先在下方选择 Key 来源并粘贴验证；凭证只会发送给你选的这一家。')
      window.setTimeout(() => document.querySelector<HTMLInputElement>('[data-cloud-key-input="true"]')?.focus(), 0)
      return
    }
    setBusy(true)
    setStatus('正在保存 AI 使用方式…')
    try {
      if (preference === 'local') {
        if (!bundledStatus.assetsPresent) {
          // 模式先保存；主界面只给出一次下载并启用入口。
        } else {
          const switched = await window.aiPlayer?.models?.quickSwitch?.({ role: 'chat', target: 'bundled' })
          if (!switched?.switched) throw new Error(switched?.reason || '本机模型切换失败')
        }
      }
      const objective = preference === 'cloud' ? 'quality' : preference === 'local' ? 'economy' : 'balanced'
      const next = await window.aiPlayer?.models?.routingSettings?.({ preference, objective })
      if (!next) throw new Error('桌面模型设置接口暂不可用')
      setRoutingStatus(next)
      setRequestedPreference(null)
      window.dispatchEvent(new CustomEvent('ai-player-models-changed'))
      setStatus(preference === 'smart'
        ? '✓ 已启用智能选择：在任务允许的范围内按能力和真实表现自动选择'
        : preference === 'local'
          ? bundledStatus?.assetsPresent
            ? '✓ 已设为只在本机：不会把内容交给云端模型；复杂任务可能提示能力不足'
            : '✓ 已设为只在本机；还需在下方下载一次本机 AI 组件'
          : '✓ 已设为优先效果：对话可使用已接入云端；生成付费成果和额外上传仍会确认')
    } catch (error) {
      setRequestedPreference(null)
      setStatus(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const refreshRoutingStatus = async () => {
    const next = await window.aiPlayer?.models?.routingStatus?.()
    if (!next) throw new Error('无法读取最新 AI 状态')
    setRoutingStatus(next)
    return next
  }

  const disconnectCandidate = async (candidate: ModelRoutingStatus['candidates'][number]) => {
    setBusy(true)
    try {
      const result = await window.aiPlayer?.models?.disconnect?.({ role: 'chat', providerId: candidate.providerId, baseUrl: candidate.baseUrl })
      if (!result || typeof result.disconnected !== 'boolean' || !Array.isArray(result.candidates)) throw new Error('断开操作没有返回可确认的结果')
      setRoutingStatus((current) => current ? { ...current, candidates: result.candidates } : current)
      if (!result.disconnected) {
        setStatus('已取消，未删除任何凭证')
        return
      }
      setStatus(`✓ 已断开 ${candidate.providerName}，对应凭证不会再被自动使用`)
      void refreshRoutingStatus().catch(() => undefined)
    } catch (error) {
      setStatus(`断开失败：${error instanceof Error ? error.message : String(error)}`)
    } finally { setBusy(false) }
  }

  const startWhisperDownload = async () => {
    setWhisperError('')
    try {
      const result = await window.aiPlayer?.transcribe?.download()
      if (!result?.success) throw new Error(result?.error || '下载失败')
      const status = await window.aiPlayer?.transcribe?.status()
      if (status) setWhisperStatus(status)
    } catch (error) {
      setWhisperError(error instanceof Error ? error.message : String(error))
    }
  }

  const cancelWhisperDownload = async () => {
    await window.aiPlayer?.transcribe?.cancelDownload()
  }

  // 订阅账号一键接入：保存 cli provider（无需 Key，官方 CLI 自管 OAuth）
  const applyCli = async (cliProviderId: 'codex-chatgpt' | 'claude-code') => {
    const provider = roleProviders.find((item) => item.id === cliProviderId)
    const cliModel = provider?.models?.[0] || 'default'
    const saved = await window.aiPlayer?.models?.save({ role, providerId: cliProviderId, model: cliModel, baseUrl: '' })
    if (saved) localStorage.setItem('aiplayer_last_cli', JSON.stringify({ providerId: cliProviderId, model: cliModel }))
    if (saved) {
      setStatus(`已接入 ${provider?.name || cliProviderId}，可以开始对话了`)
      window.dispatchEvent(new CustomEvent('ai-player-models-changed'))
      await refreshRoutingStatus()
      setProviderId(cliProviderId)
      setModel(provider?.models?.[0] || 'default')
    }
  }

  const startSmallDownload = async () => {
    setWhisperError('')
    try {
      const result = await window.aiPlayer?.transcribe?.downloadSmall()
      if (!result?.success) throw new Error(result?.error || '下载失败')
      const status = await window.aiPlayer?.transcribe?.status()
      if (status) setWhisperStatus(status)
    } catch (error) {
      setWhisperError(error instanceof Error ? error.message : String(error))
    }
  }

  const cancelSmallDownload = async () => {
    await window.aiPlayer?.transcribe?.cancelDownloadSmall()
  }

  const startTranslateDownload = async () => {
    setTranslateError('')
    try {
      const result = await window.aiPlayer?.translatePack?.download()
      if (!result?.success) throw new Error(result?.error || '下载失败')
      const status = await window.aiPlayer?.translatePack?.status()
      if (status) setTranslateStatus(status)
    } catch (error) {
      setTranslateError(error instanceof Error ? error.message : String(error))
    }
  }

  const startSiteDownload = async () => {
    setSiteError('')
    try {
      const result = await window.aiPlayer?.siteVideo?.downloadComponent()
      if (!result?.success) throw new Error(result?.error || '下载失败')
      const status = await window.aiPlayer?.siteVideo?.status()
      if (status) setSiteStatus(status)
    } catch (error) {
      setSiteError(error instanceof Error ? error.message : String(error))
    }
  }

  const cancelSiteDownload = async () => {
    await window.aiPlayer?.siteVideo?.cancelComponent()
  }

  const cancelTranslateDownload = async () => {
    await window.aiPlayer?.translatePack?.cancelDownload()
  }

  const startRapidocrDownload = async () => {
    setRapidocrError('')
    try {
      const result = await window.aiPlayer?.rapidocrPack?.download()
      if (!result?.success) throw new Error(result?.error || '下载失败')
      const status = await window.aiPlayer?.rapidocrPack?.status()
      if (status) setRapidocrStatus(status)
    } catch (error) {
      setRapidocrError(error instanceof Error ? error.message : String(error))
    }
  }

  const cancelRapidocrDownload = async () => {
    await window.aiPlayer?.rapidocrPack?.cancelDownload()
  }

  const startBundled = async () => {
    setBusy(true)
    setStatus('正在校验并加载内置模型；已采用低占用配置，首次启动通常需要数秒…')
    try {
      const result = await window.aiPlayer?.models?.startBundled()
      if (!result) throw new Error('桌面本地模型接口不可用')
      const switched = await window.aiPlayer?.models?.quickSwitch?.({ role: 'chat', target: 'bundled' })
      if (!switched?.switched) throw new Error(switched?.reason || '本机模型切换失败')
      const nextRoutingStatus = await window.aiPlayer?.models?.routingSettings?.({ preference: 'local', objective: 'economy' })
      if (!nextRoutingStatus) throw new Error('无法保存本机 AI 使用方式')
      setBundledStatus(result)
      setRoutingStatus(nextRoutingStatus)
      setRequestedPreference(null)
      setProviderId(result.providerId)
      setBaseUrl(result.baseUrl)
      setModel(result.model)
      setRemoteModels([result.model])
      setApiKey('')
      setHasApiKey(false)
      window.dispatchEvent(new CustomEvent('ai-player-models-changed'))
      setStatus('✓ 本机 AI 已启动并设为当前使用方式；之后会自动从这里继续。')
    } catch (error) {
      const next = await window.aiPlayer?.models?.bundledStatus().catch(() => null)
      if (next) setBundledStatus(next)
      setStatus(`启动失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const stopBundled = async () => {
    setBusy(true)
    try {
      const result = await window.aiPlayer?.models?.stopBundled()
      if (result) setBundledStatus(result)
      setStatus('内置模型已停止并释放内存')
    } finally {
      setBusy(false)
    }
  }

  const testConnection = async () => {
    setBusy(true)
    setStatus('正在测试连接…')
    setPlanUpgrade(null)
    const result = await window.aiPlayer?.models?.test(connectionInput())
    setBusy(false)
    if (result?.success && result.planDetected && result.upgrade) {
      setPlanUpgrade(result.upgrade)
      setStatus(`✓ ${result.message}`)
      return
    }
    setStatus(result?.success ? `✓ ${result.message}` : `连接失败：${result?.message || '未知错误'}`)
  }

  // 测试连接识别出 Coding Plan 套餐后，一键按套餐专用地址与模型列表接入
  const applyPlanUpgrade = async () => {
    if (!planUpgrade) return
    setBusy(true)
    try {
      setProviderId(planUpgrade.providerId)
      setBaseUrl(planUpgrade.baseUrl)
      setModel(planUpgrade.model)
      setRemoteModels(planUpgrade.models)
      const keyToSave = apiKey
      const saved = await window.aiPlayer?.models?.save({ role, providerId: planUpgrade.providerId, model: planUpgrade.model, baseUrl: planUpgrade.baseUrl, apiKey: keyToSave })
      setHasApiKey(Boolean(saved?.hasApiKey))
      setApiKey('')
      setPlanUpgrade(null)
      setStatus(`✓ 已按 Coding Plan 套餐接入：${planUpgrade.baseUrl} / ${planUpgrade.model}（可用 ${planUpgrade.models.length} 个套餐模型）`)
      await refreshRoutingStatus()
    } catch (error) {
      setStatus(`套餐接入失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    setBusy(true)
    setStatus('正在安全保存…')
    try {
      setStatus('正在验证文本、看图和工具能力（少量测试请求）…')
      const verified = role === 'chat' ? await window.aiPlayer?.models?.verify(connectionInput()) : { success: true, message: '专用连接已保存，请使用测试连接验证。' }
      if (!verified?.success) throw new Error(verified?.message || '模型验证未完成，连接尚未保存')
      const saved = providerId === 'deepseek'
        ? await window.aiPlayer?.models?.save({ role, providerId, model, thinkingMode, baseUrl, apiKey })
        : await window.aiPlayer?.models?.save({ role, providerId, model, baseUrl, apiKey })
      setHasApiKey(Boolean(saved?.hasApiKey))
      setApiKey('')
      setStatus(`✓ 已保存 ${provider?.name || providerId}。${verified.message}；Key 使用系统加密存储`)
      window.dispatchEvent(new CustomEvent('ai-player-models-changed'))
      await refreshRoutingStatus()
    } catch (error) {
      setStatus(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const clearKey = async () => {
    await window.aiPlayer?.models?.save({ role, providerId, model, baseUrl, clearApiKey: true })
    setApiKey('')
    setHasApiKey(false)
    setStatus('已清除保存的 API Key')
    window.dispatchEvent(new CustomEvent('ai-player-models-changed'))
    await refreshRoutingStatus()
  }

  const saveUnlimitedOcr = async (enabled: boolean) => {
    setBusy(true)
    setStatus(enabled ? '正在验证高级文档解析服务…' : '正在停用高级文档解析…')
    try {
      const result = await window.aiPlayer?.unlimitedOcr?.save({
        enabled,
        baseUrl: unlimitedOcrUrl,
        model: unlimitedOcrModel,
        ...(unlimitedOcrKey.trim() ? { apiKey: unlimitedOcrKey.trim() } : {})
      })
      if (result?.status) setUnlimitedOcrStatus({
        enabled: result.status.enabled,
        ready: result.status.ready === true,
        reason: result.status.reason || '',
        baseUrl: result.status.baseUrl,
        model: result.status.model,
        local: result.status.local,
        hasApiKey: result.status.hasApiKey
      })
      if (result?.cancelled) setStatus('已取消，没有更改高级文档解析配置')
      else if (result?.success) {
        setUnlimitedOcrKey('')
        setStatus(enabled ? '✓ 高级文档解析已就绪；复杂扫描 PDF 会自动使用，失败时回退本机 OCR。' : '✓ 已停用高级文档解析')
      } else setStatus(`连接失败：${result?.error || result?.status?.reason || '服务未就绪'}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[70] bg-black/70 flex items-center justify-center p-6" onClick={onClose}>
      <div className="w-full max-w-3xl max-h-[88vh] overflow-y-auto rounded-2xl border border-white/10 theme-panel shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-start justify-between px-6 py-5 border-b border-white/10 theme-panel">
          <div>
            <h2 className="text-lg font-medium">AI 使用方式</h2>
            <p className="text-xs text-gray-500 mt-1">选你在意的结果，其余交给 AgentPlay</p>
          </div>
          <div className="flex items-center gap-2">
            {showAdvancedModelSetup && <button
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setStatus('正在刷新模型列表…')
                try {
                  const result = await window.aiPlayer?.models?.refreshCatalog?.()
                  setStatus(result?.error ? ('刷新失败：' + result.error) : ('模型列表已更新（' + (result?.updated ?? 0) + ' 个厂商，每周自动刷新一次）'))
                  const fresh = await window.aiPlayer?.models?.providers()
                  if (fresh) setProviders(fresh)
                } finally {
                  setBusy(false)
                }
              }}
              title="立即刷新模型清单（淘汰下架旧型号、上新型号；平时每周自动刷新）"
              className="rounded-lg bg-white/10 px-3 py-1.5 text-xs text-gray-300 hover:bg-white/15 disabled:opacity-40"
            >更新模型列表</button>}
            <button onClick={onClose} className="text-gray-400 hover:text-white text-lg">✕</button>
          </div>
        </div>

        <div className="p-6 space-y-5">
          {role === 'chat' && <section className="rounded-2xl border border-cyan-300/20 bg-gradient-to-br from-cyan-400/10 to-violet-500/10 p-4" data-model-routing-simple="true">
            <p className="text-xs leading-5 text-gray-400">选一种使用方式即可；厂商、型号和地址都收在高级设置里。</p>
            <div className="mt-4 grid gap-2 md:grid-cols-3">
              {[
                { id: 'smart' as const, title: '智能选择（推荐）', description: '沿用你当前的本机/云端边界；任务明确允许时，再按真实效果自动选择。' },
                { id: 'local' as const, title: '只在本机', description: '内容不交给云端；硬件或能力不够时直接说明，不偷偷切换。' },
                { id: 'cloud' as const, title: '优先效果', description: '对话内容可交给已接入云端；生成付费成果和额外上传仍会确认。' }
              ].map((option) => {
                const selected = routingPreference === option.id
                return <button
                  key={option.id}
                  disabled={busy || !routingStatus || !bundledStatus}
                  onClick={() => void changeRoutingPreference(option.id)}
                  className={`rounded-xl border px-3.5 py-3 text-left transition ${selected ? 'border-cyan-300/55 bg-cyan-300/12 shadow-[0_0_28px_rgba(34,211,238,0.08)]' : 'border-white/10 bg-black/15 hover:border-white/25 hover:bg-white/5'} disabled:opacity-50`}
                >
                  <span className="flex items-center justify-between gap-2 text-sm font-medium text-gray-100"><span>{option.title}</span>{routingStatus && selected && <span className="text-cyan-300">✓</span>}</span>
                  <span className="mt-1.5 block text-xs leading-5 text-gray-500">{option.description}</span>
                </button>
              })}
            </div>
            {(!routingStatus || !bundledStatus) && <div className="mt-3 rounded-xl border border-white/10 bg-black/15 px-4 py-3 text-sm text-gray-400">正在读取本机与云端状态…</div>}
            {routingStatus && bundledStatus && routingPreference === 'local' && <div className="mt-3 rounded-xl border border-emerald-400/20 bg-emerald-400/5 px-4 py-3" data-local-mode-action="true">
              {bundledStatus.assetsPresent ? <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-emerald-100">本机 AI 已就绪</div>
                  <div className="mt-1 text-xs text-gray-500">内容只在这台电脑处理，不会自动切到云端。</div>
                  {!bundledStatus.hardware.eligible && <div className="mt-2 text-xs text-amber-300">{bundledStatus.hardware.reason}</div>}
                </div>
                {!bundledStatus.running && <button disabled={busy || !bundledStatus.hardware.eligible} onClick={() => void startBundled()} className="rounded-lg bg-emerald-600/80 px-4 py-2 text-sm text-white hover:bg-emerald-600 disabled:opacity-40">启用本机 AI</button>}
              </div> : <div>
                <div className="text-sm font-medium text-emerald-100">下载一次，就能只在本机使用</div>
                <div className="mt-1 text-xs text-gray-500">约 {packBytes ? `${Math.round(packBytes / 1024 / 1024)}MB` : '426MB'}，支持断点续传与完整性校验，下载后会自动启用。</div>
                {!bundledStatus.hardware.eligible && <div className="mt-2 text-xs text-amber-300">{bundledStatus.hardware.reason}</div>}
                {downloadActive ? <div className="mt-3">
                  <div className="h-2 overflow-hidden rounded-full bg-black/40"><div className="h-full bg-emerald-500 transition-all" style={{ width: `${downloadProgress && downloadProgress.totalBytes ? Math.min(100, Math.round((downloadProgress.receivedBytes / downloadProgress.totalBytes) * 100)) : 0}%` }} /></div>
                  <div className="mt-2 flex items-center justify-between gap-3 text-xs text-gray-400"><span>{downloadProgress?.currentFile || '正在连接…'}</span><button onClick={() => void cancelLocalAiDownload()} className="text-red-300 hover:text-red-200">取消</button></div>
                </div> : <button disabled={busy || !bundledStatus.hardware.eligible} onClick={() => void startLocalAiDownload()} className="mt-3 rounded-lg bg-emerald-600/80 px-4 py-2 text-sm text-white hover:bg-emerald-600 disabled:opacity-40">下载并启用本机 AI</button>}
                {downloadError && <div className="mt-2 text-xs text-red-300">{downloadError}</div>}
              </div>}
            </div>}
            {routingStatus && bundledStatus && routingPreference === 'cloud' && hasCloud && <div className="mt-3 rounded-xl border border-sky-400/20 bg-sky-400/5 px-4 py-3">
              <div className="text-sm font-medium text-sky-100">云端 AI 已接入</div>
              <div className="mt-1 text-xs text-gray-500">{connectedServices.filter((candidate) => !candidate.localOnly).map((candidate) => candidate.providerName).join('、')}；需要联网的对话会优先使用它。</div>
            </div>}
            {routingStatus && bundledStatus && routingPreference === 'smart' && <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-violet-400/20 bg-violet-400/5 px-4 py-3">
              <div>
                <div className="text-sm font-medium text-violet-100">AgentPlay 会按任务自动选择</div>
                <div className="mt-1 text-xs text-gray-500">默认守住当前隐私边界；需要更强能力时再由你接入一次。</div>
              </div>
              {!hasCloud && <button onClick={() => setShowSmartEnhancement(true)} className="rounded-lg bg-violet-600/80 px-4 py-2 text-sm text-white hover:bg-violet-600">增强 AI 能力</button>}
            </div>}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-gray-500">
              <span>只在本机不会上传内容；使用云端或产生费用时仍按任务确认。</span>
              <button onClick={() => setShowAdvancedModelSetup((value) => !value)} className="text-gray-400 hover:text-white">{showAdvancedModelSetup ? '收起高级设置' : '高级设置'}</button>
            </div>
          </section>}
          {intent?.providerId && <div data-model-center-intent="subtitle-translation" className="rounded-2xl border border-cyan-300/25 bg-cyan-300/10 px-4 py-3.5">
            <div className="text-sm font-medium text-cyan-50">已为字幕翻译定位到 Agnes 2.5 Flash</div>
            <div className="mt-1 text-xs leading-5 text-cyan-100/80">字幕翻译只发送字幕原文，不上传视频。填写 Agnes API Key 后，先真实连接验证，再安全保存；保存成功会自动返回播放器继续生成英文字幕。</div>
            <div className="mt-2 text-[11px] text-gray-400">价格以 Agnes 账户 Billing 为准；应用拿不到可靠单价时明确显示“价格未知”，不会按免费计算。</div>
          </div>}

          {showAdvancedModelSetup && <div>
            <span className="block text-xs text-gray-400 mb-2">用途</span>
            <div className="flex items-center justify-between">
              <div className="rounded-lg bg-player-accent px-4 py-1.5 text-sm text-white">AI 对话</div>
              <button disabled={busy} onClick={() => void changeRole('computerUse')} title="电脑观察是实验功能：让 AI 看屏幕给操作建议，需要单独配一个视觉小模型" className={`text-xs ${role === 'computerUse' ? 'text-amber-400' : 'text-gray-500 hover:text-gray-300'}`}>配置电脑观察模型 ▸</button>
            </div>
          </div>}

          {role === 'computerUse' && <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200 flex items-center justify-between">安全预览阶段：模型只观察当前应用画面并给出建议，不会点击鼠标、输入键盘或执行命令。
            <button onClick={() => void changeRole('chat')} className="shrink-0 ml-3 text-xs text-amber-100 underline hover:text-white">返回 AI 对话</button>
          </div>}

          {showCloudConnect && <div className="rounded-xl border border-player-accent/30 bg-player-accent/5 px-4 py-4" data-cloud-model-config="true">
            <div className="text-sm text-gray-200">☁ 接入一个云端服务</div>
            <div className="mt-1 text-xs text-gray-500">先选 Key 从哪里复制，再粘贴验证；Key 只会发给这一家，不会拿去试探其他厂商。</div>
            {intent?.providerId && <div className="mt-2 rounded-lg border border-cyan-400/15 bg-cyan-400/5 px-3 py-2 text-xs text-cyan-100/80">字幕云端翻译只发送字幕原文，不会上传视频文件。</div>}
            <div className="mt-2.5 grid gap-2 sm:grid-cols-[180px_minmax(0,1fr)_auto]">
              <select value={oneKeyProviderId} onChange={(event) => setOneKeyProviderId(event.target.value)} className="rounded-lg border border-white/10 bg-black/35 px-3 py-2 text-sm outline-none focus:border-player-accent" aria-label="Key 来自哪里">
                {roleProviders.filter((item) => item.protocol === 'openai' && !item.bundled && !['custom', 'ollama', 'lmstudio', 'vllm', 'llamacpp', 'colibri'].includes(item.id)).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
              <input
                type="password"
                data-cloud-key-input="true"
                value={oneKey}
                onChange={(event) => setOneKey(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && !oneKeyBusy && oneKey.trim().length >= 8 && void runAutoDetect()}
                placeholder={intent?.providerId === 'agnes' ? '粘贴 Agnes API Key…' : '粘贴 API Key…'}
                className="flex-1 rounded-lg border border-white/10 bg-black/35 px-3 py-2 text-sm outline-none focus:border-player-accent"
              />
              <button
                disabled={oneKeyBusy || oneKey.trim().length < 8}
                onClick={() => void runAutoDetect()}
                className="shrink-0 rounded-lg bg-player-accent px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-40"
              >{oneKeyBusy ? '验证中…' : '验证并接入'}</button>
            </div>
            {oneKeyError && <div className="mt-2 text-xs text-red-300">{oneKeyError}</div>}
            {oneKeyMatches.length > 0 && (
              <div className="mt-3 space-y-2">
                {oneKeyMatches.map((match) => (
                  <div key={match.providerId} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/20 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-gray-200">{match.providerName}</div>
                      <div className="text-[11px] text-gray-500">{match.latencyMs}ms · {match.models.length} 个模型</div>
                    </div>
                    <select
                      value={oneKeyModelPick[match.providerId] || (roleProviders.find((item) => item.id === match.providerId)?.models?.[0] && match.models.includes(roleProviders.find((item) => item.id === match.providerId)!.models![0]) ? roleProviders.find((item) => item.id === match.providerId)!.models![0] : match.models[0])}
                      onChange={(event) => setOneKeyModelPick((current) => ({ ...current, [match.providerId]: event.target.value }))}
                      className="max-w-44 rounded-lg border border-white/10 bg-black/35 px-2 py-1.5 text-xs text-gray-300 outline-none focus:border-player-accent"
                    >
                      {match.models.slice(0, 30).map((name) => <option key={name} value={name}>{name}</option>)}
                    </select>
                    <button onClick={() => void applyMatch(match).catch((error) => setOneKeyError(error instanceof Error ? error.message : String(error)))} className="shrink-0 rounded-lg bg-emerald-600/80 px-3 py-1.5 text-xs text-white hover:bg-emerald-600">接入</button>
                  </div>
                ))}
              </div>
            )}
          </div>}

          {showAdvancedModelSetup && <button onClick={() => setShowLocalPacks((value) => !value)} className="flex w-full items-center justify-between rounded-xl border border-white/10 px-4 py-3 text-left text-sm text-gray-400 hover:bg-white/5 hover:text-gray-200">
            <span>本地组件与下载（可选 · 离线模型 · 精修 · 翻译 · OCR · 站点视频）</span>
            <span className="text-xs">{showLocalPacks ? '▾ 收起' : '▸ 展开'}</span>
          </button>}

          {showAdvancedModelSetup && showLocalPacks && <>
          {role === 'chat' && bundledStatus && <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-4 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm text-emerald-100">内置离线模型 · {bundledStatus.modelName}</div>
                <div className="mt-1 text-xs text-gray-500">
                  {bundledStatus.modelSizeMb}MB · 当前可用 {bundledStatus.hardware.availableMemoryGb}/{bundledStatus.hardware.totalMemoryGb}GB · AI {bundledStatus.hardware.threads}/{bundledStatus.hardware.logicalCpus} 线程 · {bundledStatus.hardware.contextSize / 1024}K 上下文
                </div>
                <div className={`mt-2 text-xs ${bundledStatus.hardware.eligible ? 'text-emerald-300/80' : 'text-amber-300'}`}>{bundledStatus.hardware.reason}</div>
                <div className="mt-2 text-xs text-sky-300/80">暂停、快进、音量、倍速、字幕、画面比例、窗口和截图均走本地快速路由；模型只做语义与字幕摘要，闲置 {bundledStatus.idleReleaseMinutes} 分钟自动释放。</div>
                {!bundledStatus.assetsPresent && <div className="mt-3 rounded-lg border border-sky-500/25 bg-sky-500/5 p-3">
                  <div className="text-xs text-gray-400">当前是标准版，未携带本地模型。可在线下载本地 AI 组件（约 {packBytes ? `${Math.round(packBytes / 1024 / 1024)}MB` : '426MB'}，只需下载一次，支持断点续传和 SHA-256 校验），下载完成后即可离线使用；也可以直接连接云端或已有 Ollama、LM Studio、vLLM、llama.cpp 服务。</div>
                  {downloadActive ? (
                    <div className="mt-3">
                      <div className="h-2 overflow-hidden rounded-full bg-black/40"><div className="h-full bg-sky-500 transition-all" style={{ width: `${downloadProgress && downloadProgress.totalBytes ? Math.min(100, Math.round((downloadProgress.receivedBytes / downloadProgress.totalBytes) * 100)) : 0}%` }} /></div>
                      <div className="mt-2 flex items-center justify-between gap-3 text-xs text-gray-400">
                        <span>{downloadProgress ? `${({ download: '下载中', verify: '校验中', extract: '解压中', done: '完成' } as Record<string, string>)[downloadProgress.stage] || downloadProgress.stage} ${downloadProgress.currentFile || ''} · ${(downloadProgress.receivedBytes / 1024 / 1024).toFixed(0)}/${(downloadProgress.totalBytes / 1024 / 1024).toFixed(0)}MB` : '正在连接…'}</span>
                        <button onClick={() => void cancelLocalAiDownload()} className="shrink-0 text-red-300 hover:text-red-200">取消</button>
                      </div>
                    </div>
                  ) : (
                    <button disabled={busy} onClick={() => void startLocalAiDownload()} className="mt-3 rounded-lg bg-sky-600/80 px-4 py-2 text-sm text-white hover:bg-sky-600 disabled:opacity-40">下载本地 AI 组件</button>
                  )}
                  {downloadError && <div className="mt-2 text-xs text-red-300">{downloadError}</div>}
                </div>}
                {bundledStatus.lastNotice && <div className="mt-2 text-xs text-sky-300">{bundledStatus.lastNotice}</div>}
                {bundledStatus.lastError && <div className="mt-2 text-xs text-red-300">{bundledStatus.lastError}</div>}
              </div>
              {bundledStatus.running
                ? <button disabled={busy} onClick={() => void stopBundled()} className="rounded-lg bg-white/10 px-4 py-2 text-sm hover:bg-white/15 disabled:opacity-40">停止并释放内存</button>
                : <button disabled={busy || !bundledStatus.assetsPresent || !bundledStatus.hardware.eligible} onClick={() => void startBundled()} className="rounded-lg bg-emerald-600/80 px-4 py-2 text-sm hover:bg-emerald-600 disabled:opacity-40">启动内置模型</button>}
            </div>
          </div>}

          {role === 'chat' && whisperStatus && <div className="rounded-xl border border-violet-500/25 bg-violet-500/5 px-4 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm text-violet-100">录音转写组件 · whisper.cpp + ggml-tiny</div>
                <div className="mt-1 text-xs text-gray-500">约 {Math.round((whisperStatus.pack?.totalBytes || 0) / 1024 / 1024)}MB · 离线中文语音转文字，可出带时间轴字幕</div>
                {!whisperStatus.available && !whisperStatus.download?.active && <div className="mt-2 text-xs text-amber-300">{whisperStatus.reason}；下载一次即可离线使用。</div>}
                {whisperStatus.available && <div className="mt-2 text-xs text-emerald-300">已就绪：音频附件说“转写这段录音”，视频可自动识别语言并生成反向翻译字幕。</div>}
                {whisperError && <div className="mt-2 text-xs text-red-300">{whisperError}</div>}
              </div>
              {!whisperStatus.available && (whisperStatus.download?.active
                ? <button onClick={() => void cancelWhisperDownload()} className="rounded-lg bg-white/10 px-4 py-2 text-sm hover:bg-white/15">取消下载</button>
                : <button disabled={busy} onClick={() => void startWhisperDownload()} className="rounded-lg bg-violet-600/80 px-4 py-2 text-sm hover:bg-violet-600 disabled:opacity-40">下载转写组件</button>)}
            </div>
            {whisperStatus.download?.active && (
              <div className="mt-3">
                <div className="h-2 overflow-hidden rounded-full bg-black/40"><div className="h-full bg-violet-500 transition-all" style={{ width: `${Math.min(100, Math.round(((whisperStatus.download.receivedBytes || 0) / (whisperStatus.download.totalBytes || 1)) * 100))}%` }} /></div>
                <div className="mt-1 text-xs text-gray-400">{whisperStatus.download.currentFile || '下载中'} · {((whisperStatus.download.receivedBytes || 0) / 1024 / 1024).toFixed(0)}/{((whisperStatus.download.totalBytes || 0) / 1024 / 1024).toFixed(0)}MB</div>
              </div>
            )}
          </div>}

          {role === 'chat' && whisperStatus?.available && <div className="rounded-xl border border-cyan-500/25 bg-cyan-500/5 px-4 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm text-cyan-100">精修转写模型 · ggml-small（可选）</div>
                <div className="mt-1 text-xs text-gray-500">约 {Math.round((whisperStatus.smallPack?.totalBytes || 0) / 1024 / 1024)}MB · 字幕质量显著优于 tiny（“三经外”→“三千万”级提升）；实时识别先出 tiny 初稿，small 后台自动精修替换</div>
                {!whisperStatus.smallAvailable && !whisperStatus.smallDownload?.active && <div className="mt-2 text-xs text-amber-300">未安装；下载一次即可，与转写组件共用引擎。</div>}
                {whisperStatus.smallAvailable && <div className="mt-2 text-xs text-emerald-300">已就绪：实时识别完成后自动后台精修并替换字幕。</div>}
                {whisperError && <div className="mt-2 text-xs text-red-300">{whisperError}</div>}
              </div>
              {!whisperStatus.smallAvailable && (whisperStatus.smallDownload?.active
                ? <button onClick={() => void cancelSmallDownload()} className="rounded-lg bg-white/10 px-4 py-2 text-sm hover:bg-white/15">取消下载</button>
                : <button disabled={busy} onClick={() => void startSmallDownload()} className="rounded-lg bg-cyan-600/80 px-4 py-2 text-sm hover:bg-cyan-600 disabled:opacity-40">下载精修模型</button>)}
            </div>
            {whisperStatus.smallDownload?.active && (
              <div className="mt-3">
                <div className="h-2 overflow-hidden rounded-full bg-black/40"><div className="h-full bg-cyan-500 transition-all" style={{ width: `${Math.min(100, Math.round(((whisperStatus.smallDownload?.receivedBytes || 0) / (whisperStatus.smallDownload?.totalBytes || 1)) * 100))}%` }} /></div>
                <div className="mt-1 text-xs text-gray-400">{whisperStatus.smallDownload?.currentFile || '下载中'} · {((whisperStatus.smallDownload?.receivedBytes || 0) / 1024 / 1024).toFixed(0)}/{((whisperStatus.smallDownload?.totalBytes || 0) / 1024 / 1024).toFixed(0)}MB</div>
              </div>
            )}
          </div>}

          {role === 'chat' && rapidocrStatus && <div className="rounded-xl border border-teal-500/25 bg-teal-500/5 px-4 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm text-teal-100">高精度 OCR 组件 · PP-OCRv4 中文识别</div>
                <div className="mt-1 text-xs text-gray-500">约 {Math.round((rapidocrStatus.pack?.totalBytes || 0) / 1024 / 1024)}MB · 扫描件 PDF/图片的中文高精度识别，纯本地运行、内容不出机</div>
                {!rapidocrStatus.available && !rapidocrStatus.download?.active && <div className="mt-2 text-xs text-amber-300">{rapidocrStatus.reason}；下载一次即可离线使用。</div>}
                {rapidocrStatus.available && <div className="mt-2 text-xs text-emerald-300">已就绪：扫描件 PDF 提取文字、图片识字自动优先走高精度引擎，系统 OCR 兜底。</div>}
                {rapidocrError && <div className="mt-2 text-xs text-red-300">{rapidocrError}</div>}
              </div>
              {!rapidocrStatus.available && (rapidocrStatus.download?.active
                ? <button onClick={() => void cancelRapidocrDownload()} className="rounded-lg bg-white/10 px-4 py-2 text-sm hover:bg-white/15">取消下载</button>
                : <button disabled={busy} onClick={() => void startRapidocrDownload()} className="rounded-lg bg-teal-600/80 px-4 py-2 text-sm hover:bg-teal-600 disabled:opacity-40">下载高精度 OCR 组件</button>)}
            </div>
            {rapidocrStatus.download?.active && (
              <div className="mt-3">
                <div className="h-2 overflow-hidden rounded-full bg-black/40"><div className="h-full bg-teal-500 transition-all" style={{ width: `${Math.min(100, Math.round(((rapidocrStatus.download.receivedBytes || 0) / (rapidocrStatus.download.totalBytes || 1)) * 100))}%` }} /></div>
                <div className="mt-1 text-xs text-gray-400">{rapidocrStatus.download.currentFile || '下载中'} · {((rapidocrStatus.download.receivedBytes || 0) / 1024 / 1024).toFixed(0)}/{((rapidocrStatus.download.totalBytes || 0) / 1024 / 1024).toFixed(0)}MB</div>
              </div>
            )}
          </div>}

          {role === 'chat' && unlimitedOcrStatus && <div className="rounded-xl border border-indigo-400/25 bg-indigo-400/5 px-4 py-4" data-unlimited-ocr-config="true">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-indigo-100">高级文档解析 · Unlimited-OCR</div>
                <div className="mt-1 text-xs leading-5 text-gray-500">客户自行部署的可选服务，不随 AgentPlay 安装包下载模型。适合有 NVIDIA GPU 的电脑处理复杂多页扫描、表格、公式和阅读顺序。</div>
                <div className={`mt-2 text-xs ${unlimitedOcrStatus.ready ? 'text-emerald-300' : unlimitedOcrStatus.enabled ? 'text-amber-300' : 'text-gray-500'}`}>
                  {unlimitedOcrStatus.ready ? '已就绪：复杂扫描 PDF 自动使用；结果异常会回退本机 OCR。' : unlimitedOcrStatus.enabled ? unlimitedOcrStatus.reason : '默认关闭；普通电脑继续使用现有 PP-OCRv4/系统 OCR。'}
                </div>
              </div>
              {unlimitedOcrStatus.enabled
                ? <button disabled={busy} onClick={() => void saveUnlimitedOcr(false)} className="rounded-lg bg-white/10 px-4 py-2 text-sm hover:bg-white/15 disabled:opacity-40">停用</button>
                : <button disabled={busy} onClick={() => void saveUnlimitedOcr(true)} className="rounded-lg bg-indigo-600/80 px-4 py-2 text-sm text-white hover:bg-indigo-600 disabled:opacity-40">验证并启用</button>}
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <input value={unlimitedOcrUrl} onChange={(event) => setUnlimitedOcrUrl(event.target.value)} placeholder="http://127.0.0.1:8000/v1" className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs outline-none focus:border-indigo-400" />
              <input value={unlimitedOcrModel} onChange={(event) => setUnlimitedOcrModel(event.target.value)} placeholder="baidu/Unlimited-OCR" className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs outline-none focus:border-indigo-400" />
            </div>
            <input type="password" value={unlimitedOcrKey} onChange={(event) => setUnlimitedOcrKey(event.target.value)} placeholder={unlimitedOcrStatus.hasApiKey ? '凭证已由系统加密保存；留空继续使用' : 'API Key（本机服务通常留空）'} className="mt-2 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs outline-none focus:border-indigo-400" />
            <div className="mt-2 text-[11px] leading-5 text-gray-500">推荐仅连接本机回环地址。远端地址会先确认保存，实际上传每份文档仍需单独授权。</div>
          </div>}

          {role === 'chat' && cliStatus && (cliStatus.codex.installed || cliStatus.claude.installed) && <div className="rounded-xl border border-violet-500/25 bg-violet-500/5 px-4 py-4">
            <div className="text-sm text-violet-100">订阅账号（免 API Key）</div>
            <div className="mt-1 text-xs text-gray-500">复用本机官方 CLI 的订阅登录态，只读子进程调用，不产生 API 费用</div>
            <div className="mt-3 space-y-2">
              {[
                { key: 'codex' as const, providerId: 'codex-chatgpt' as const, label: 'ChatGPT 订阅（经 Codex CLI）', status: cliStatus.codex },
                { key: 'claude' as const, providerId: 'claude-code' as const, label: 'Claude 订阅（经 Claude Code）', status: cliStatus.claude }
              ].map((item) => (
                <div key={item.key} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/20 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm text-gray-200">{item.label}</div>
                    <div className={`text-[11px] ${item.status.loggedIn ? 'text-emerald-300' : 'text-amber-300'}`}>{item.status.loggedIn ? '已就绪' : item.status.note || '未登录'}</div>
                  </div>
                  <button disabled={!item.status.loggedIn || busy} onClick={() => void applyCli(item.providerId)} className="shrink-0 rounded-lg bg-violet-600/80 px-3 py-1.5 text-xs text-white hover:bg-violet-600 disabled:opacity-40">接入</button>
                </div>
              ))}
            </div>
          </div>}

          {role === 'chat' && translateStatus && <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-4 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm text-emerald-100">离线翻译组件 · OPUS-MT 英译中</div>
                <div className="mt-1 text-xs text-gray-500">约 {Math.round((translateStatus.pack?.totalBytes || 0) / 1024 / 1024)}MB · 纯本地翻译英文字幕，不用云模型、不发任何内容出机</div>
                {!translateStatus.available && !translateStatus.download?.active && <div className="mt-2 text-xs text-amber-300">{translateStatus.reason}；下载一次即可离线使用。</div>}
                {translateStatus.available && <div className="mt-2 text-xs text-emerald-300">已就绪：英文转中文可自动走本地；中文转英文需使用已配置的云端文本模型。</div>}
                {translateError && <div className="mt-2 text-xs text-red-300">{translateError}</div>}
              </div>
              {!translateStatus.available && (translateStatus.download?.active
                ? <button onClick={() => void cancelTranslateDownload()} className="rounded-lg bg-white/10 px-4 py-2 text-sm hover:bg-white/15">取消下载</button>
                : <button disabled={busy} onClick={() => void startTranslateDownload()} className="rounded-lg bg-emerald-600/80 px-4 py-2 text-sm hover:bg-emerald-600 disabled:opacity-40">下载离线翻译组件</button>)}
            </div>
            {translateStatus.download?.active && (
              <div className="mt-3">
                <div className="h-2 overflow-hidden rounded-full bg-black/40"><div className="h-full bg-emerald-500 transition-all" style={{ width: `${Math.min(100, Math.round(((translateStatus.download.receivedBytes || 0) / (translateStatus.download.totalBytes || 1)) * 100))}%` }} /></div>
                <div className="mt-1 text-xs text-gray-400">{translateStatus.download.currentFile || '下载中'} · {((translateStatus.download.receivedBytes || 0) / 1024 / 1024).toFixed(0)}/{((translateStatus.download.totalBytes || 0) / 1024 / 1024).toFixed(0)}MB</div>
              </div>
            )}
          </div>}

          {role === 'chat' && siteStatus && <div className="rounded-xl border border-orange-500/25 bg-orange-500/5 px-4 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm text-orange-100">站点视频解析组件 · yt-dlp 官方版</div>
                <div className="mt-1 text-xs text-gray-500">约 {Math.round((siteStatus.pack?.totalBytes || 0) / 1024 / 1024)}MB · B站/YouTube/抖音等公开视频页解析下载；VIP/付费/DRM 内容不支持</div>
                {!siteStatus.available && !siteStatus.download?.active && <div className="mt-2 text-xs text-amber-300">{siteStatus.reason}；首次粘贴站点链接时会自动下载，也可在此提前下载。</div>}
                {siteStatus.available && <div className="mt-2 text-xs text-emerald-300">已就绪：对话窗粘贴站点视频链接即自动解析下载并播放。</div>}
                {siteError && <div className="mt-2 text-xs text-red-300">{siteError}</div>}
              </div>
              {!siteStatus.available && (siteStatus.download?.active
                ? <button onClick={() => void cancelSiteDownload()} className="rounded-lg bg-white/10 px-4 py-2 text-sm hover:bg-white/15">取消下载</button>
                : <button disabled={busy} onClick={() => void startSiteDownload()} className="rounded-lg bg-orange-600/80 px-4 py-2 text-sm hover:bg-orange-600 disabled:opacity-40">下载解析组件</button>)}
            </div>
            {siteStatus.download?.active && (
              <div className="mt-3">
                <div className="h-2 overflow-hidden rounded-full bg-black/40"><div className="h-full bg-orange-500 transition-all" style={{ width: `${Math.min(100, Math.round(((siteStatus.download.receivedBytes || 0) / (siteStatus.download.totalBytes || 1)) * 100))}%` }} /></div>
                <div className="mt-1 text-xs text-gray-400">{siteStatus.download.currentFile || '下载中'} · {((siteStatus.download.receivedBytes || 0) / 1024 / 1024).toFixed(0)}/{((siteStatus.download.totalBytes || 0) / 1024 / 1024).toFixed(0)}MB</div>
              </div>
            )}
          </div>}

          <div className="rounded-xl border border-sky-500/20 bg-sky-500/5 px-4 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm text-sky-100">已有本地模型服务？</div>
                <div className="mt-1 text-xs text-gray-500">只检测本机端口，不下载模型、不启动后台服务。</div>
              </div>
              <button disabled={busy} onClick={() => void discoverLocal()} className="rounded-lg bg-sky-600/80 px-4 py-2 text-sm hover:bg-sky-600 disabled:opacity-40">自动发现本地模型</button>
            </div>
            {discovered.length > 0 && <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {discovered.map((service) => <button key={`${service.id}-${service.baseUrl}`} onClick={() => useDiscovered(service)} className="rounded-lg border border-white/10 bg-black/20 px-3 py-3 text-left hover:border-sky-500/50">
                <span className="block text-sm text-gray-200">{service.name}</span>
                <span className="mt-1 block truncate text-xs text-gray-500">{service.models.length} 个型号 · {service.baseUrl}</span>
              </button>)}
            </div>}
          </div>
          </>}


          {showAdvancedModelSetup && <>
          {connectedServices.length ? <div className="rounded-xl border border-white/10 bg-black/15 p-4">
            <div className="text-sm text-gray-200">已接入服务</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {connectedServices.map((candidate) => <div key={`${candidate.providerId}-${candidate.baseUrl}`} className="flex items-center gap-2 rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-xs text-gray-300">
                <span>{candidate.localOnly ? '本机' : candidate.providerName}</span>
                {!candidate.localOnly && <button disabled={busy} onClick={() => void disconnectCandidate(candidate)} className="text-gray-600 hover:text-red-300">断开</button>}
              </div>)}
            </div>
          </div> : null}
          {routingStatus?.models?.length ? <div className="rounded-xl border border-white/10 bg-black/15 p-4">
            <div className="text-sm text-gray-200">真实任务表现</div>
            <div className="mt-1 text-xs text-gray-500">只统计耗时、成功率、质量分和模型返回的用量；不保存你的提问、结果或 Key。</div>
            <div className="mt-3 space-y-2">
              {routingStatus.models.map((item) => <div key={item.key} className="grid gap-1 rounded-lg border border-white/8 bg-black/20 px-3 py-2 text-xs md:grid-cols-[minmax(0,1.5fr)_repeat(4,minmax(70px,1fr))]">
                <div className="min-w-0"><div className="truncate text-gray-200">{item.providerName || item.providerId} · {item.model}</div><div className="text-[11px] text-gray-600">{item.samples} 次任务</div></div>
                <div><span className="text-gray-600">成功率</span><div className="text-gray-300">{item.successRate === null ? '样本不足' : `${Math.round(item.successRate * 100)}%`}</div></div>
                <div><span className="text-gray-600">质量</span><div className="text-gray-300">{item.qualityScore === null ? '样本不足' : `${Math.round(item.qualityScore)} 分`}</div></div>
                <div><span className="text-gray-600">速度</span><div className="text-gray-300">{item.latencyMs === null ? '样本不足' : `${(item.latencyMs / 1000).toFixed(1)} 秒`}</div></div>
                <div><span className="text-gray-600">成本</span><div className="text-gray-300">{item.cost.label}</div></div>
              </div>)}
            </div>
          </div> : null}
          <label className="block">
            <span className="block text-xs text-gray-400 mb-2">1. 模型公司 / 服务</span>
            <select value={providerId} onChange={(event) => changeProvider(event.target.value)} className="w-full bg-black/35 border border-white/10 rounded-lg px-3 py-3 text-sm outline-none focus:border-player-accent">
              {roleProviders.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.region}</option>)}
            </select>
          </label>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="block">
              <span className="block text-xs text-gray-400 mb-2">2. 大模型型号</span>
              <select value={model} onChange={(event) => {
                const nextModel = event.target.value
                setModel(nextModel)
                setThinkingMode(provider?.modelProfiles?.[nextModel]?.thinkingMode || 'enabled')
              }} className="w-full bg-black/35 border border-white/10 rounded-lg px-3 py-3 text-sm outline-none focus:border-player-accent">
                {modelOptions.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
              {provider?.modelHint && <p className="text-xs text-amber-400/80 mt-2">{provider.modelHint}</p>}
              {provider?.warning && <p className="text-xs text-amber-400/80 mt-2">{provider.warning}</p>}
              {selectedModelProfile?.pricing && <p className="mt-2 text-xs text-sky-300/80">
                官方参考价：输入 ${selectedModelProfile.pricing.inputUsdPerMillion}/百万 tokens · 输出 ${selectedModelProfile.pricing.outputUsdPerMillion}/百万 tokens
                {provider?.pricingVerifiedAt ? ` · 核验于 ${provider.pricingVerifiedAt}` : ''}
              </p>}
              {providerId === 'deepseek' && <div className="mt-3 grid grid-cols-2 gap-2" data-deepseek-thinking-mode="true">
                <button type="button" onClick={() => setThinkingMode('enabled')} className={`rounded-lg border px-3 py-2 text-xs ${thinkingMode === 'enabled' ? 'border-sky-400/60 bg-sky-400/10 text-sky-200' : 'border-white/10 bg-black/15 text-gray-400'}`}>深度思考</button>
                <button type="button" onClick={() => setThinkingMode('disabled')} className={`rounded-lg border px-3 py-2 text-xs ${thinkingMode === 'disabled' ? 'border-sky-400/60 bg-sky-400/10 text-sky-200' : 'border-white/10 bg-black/15 text-gray-400'}`}>快速回答</button>
              </div>}
            </label>
            {provider?.protocol !== 'cli' && <label className="block">
              <span className="block text-xs text-gray-400 mb-2">3. API Key {provider?.requiresKey ? '' : '（本地服务可不填）'}</span>
              <span className="relative block">
                <input type={showKey ? 'text' : 'password'} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={hasApiKey ? '已安全保存；留空表示继续使用' : '粘贴 API Key'} className="w-full bg-black/35 border border-white/10 rounded-lg px-3 py-3 pr-10 text-sm outline-none focus:border-player-accent" />
                <button type="button" onClick={() => setShowKey((value) => !value)} title={showKey ? '隐藏 Key' : '显示 Key'} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-200 text-sm">{showKey ? '🙈' : '👁'}</button>
              </span>
            </label>}
          </div>

          {provider?.protocol === 'cli' ? (
            <div className="rounded-lg border border-violet-500/25 bg-violet-500/5 px-4 py-3 text-xs text-violet-200">订阅账号无需 Key 和地址：复用本机官方 CLI 登录态，选好型号直接「保存并启用」即可。</div>
          ) : (
            <label className="block">
              <span className="block text-xs text-gray-400 mb-2">4. API / 网页服务地址</span>
              <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://.../v1" className="w-full bg-black/35 border border-white/10 rounded-lg px-3 py-3 text-sm font-mono outline-none focus:border-player-accent" />
              <p className="text-xs text-gray-600 mt-2">支持官方接口、本地 Ollama / LM Studio、OpenAI 兼容代理和自建服务；不会抓取网页账号或 Cookie。</p>
            </label>
          )}

          <div className="flex flex-wrap gap-3">
            <button disabled={busy} onClick={refreshModels} className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-sm disabled:opacity-40">读取可用型号</button>
            <button disabled={busy} onClick={testConnection} className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-sm disabled:opacity-40">测试连接</button>
            <button disabled={busy || !model || (provider?.protocol !== 'cli' && !baseUrl)} onClick={save} className="px-5 py-2 rounded-lg bg-player-accent hover:bg-blue-600 text-sm disabled:opacity-40">{role === 'chat' ? '验证并连接' : '保存并启用'}</button>
            {hasApiKey && <button disabled={busy} onClick={clearKey} className="px-3 py-2 text-xs text-red-300 hover:text-red-200">清除已存 Key</button>}
          </div>

          {role === 'chat' && <p className="text-xs text-gray-400">连接时会发送少量文字、纯色图片与工具协议测试，可能产生少量模型用量，不上传你的文件。</p>}
          {planUpgrade && (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-emerald-100">
                已识别 Coding Plan 套餐：专用地址 + 套餐内 {planUpgrade.models.length} 个模型（通用地址会失败或产生额外费用）
              </div>
              <button disabled={busy} onClick={() => void applyPlanUpgrade()} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white hover:bg-emerald-500 disabled:opacity-40">按套餐接入</button>
            </div>
          )}
          </>}

          {status && <div className={`rounded-lg px-4 py-3 text-sm ${status.startsWith('✓') ? 'bg-emerald-500/10 text-emerald-300' : 'bg-white/5 text-gray-300'}`}>{status}</div>}

          {showAdvancedModelSetup && <div className="rounded-xl bg-black/25 px-4 py-3 text-xs text-gray-500 leading-6">
            已内置全球及国内主流服务，并以“实时读取账户模型”应对厂商型号更新。本地框架可连接 Ollama、LM Studio、vLLM、llama.cpp、Colibri 和 Fara 的 OpenAI 兼容服务，只允许本机回环地址，绝不自动下载大模型权重。API Key 由系统安全存储加密后落盘。
          </div>}
        </div>
      </div>
    </div>
  )
}
