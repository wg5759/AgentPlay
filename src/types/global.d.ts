declare module '*.mjs' {
  export interface WorkspaceJourneyTask {
    kind?: string
    phase?: string
    running?: boolean
    status?: string
    progress?: number | null
    outputs?: string[]
  }
  export function workspaceJourneyForTask(task?: WorkspaceJourneyTask): {
    eyebrow: string
    stages: string[]
    activeStage: number
  }
  export function taskTimingForTask(task?: WorkspaceJourneyTask): string
  export function dedupeAttachments<T>(files: T[]): T[]
  export const PLAYER_CHROME_HIDE_DELAY_MS: number
  export const PLAYER_MOUSE_WAKE_THRESHOLD_PX: number
  export function shouldAutoHideControls(input: { hasMedia?: boolean; playing: boolean; immersive?: boolean; blocked?: boolean }): boolean
  export function isRealMouseActivity(last: { x: number; y: number } | null, next: { x: number; y: number } | null, threshold?: number): boolean
  export type SubtitlePosition = 'high' | 'middle' | 'low'
  export const SUBTITLE_POSITIONS: SubtitlePosition[]
  export function normalizeSubtitlePosition(value: unknown): SubtitlePosition
  export function subtitleLinePercent(value: unknown): number
  export function shiftSubtitlePosition(value: unknown, direction: 'up' | 'down'): SubtitlePosition
  export function subtitleCueSettings(value: unknown): string
  export interface LinkChoice {
    url: string
    text: string
    direct: boolean
    canAnalyze: boolean
  }
  export function buildLinkChoice(
    detection: { matched?: boolean; url?: string; direct?: boolean; mode?: string | null } | null | undefined,
    text: string
  ): LinkChoice | null
  export type AgentMode = 'ask' | 'plan' | 'work' | 'auto'
  export const AGENT_MODES: Record<AgentMode, {
    id: AgentMode
    label: string
    description: string
    canDispatchTasks: boolean
    maxToolTurns: number
  }>
  export function normalizeAgentMode(value: unknown): AgentMode
  export function canDispatchAgentTask(value: unknown): boolean
  export function buildAgentSystemPrompt(taskPrompt?: string, mode?: AgentMode): string
  export function selectDocumentPreviewPath(documents: Array<{ previewPath?: string }> | null | undefined): string | null
  export function selectPrimaryPreviewPath(
    media: string[] | null | undefined,
    documents: Array<{ previewPath?: string }> | null | undefined
  ): string | null
  export interface RecentMediaRecord { name: string; src: string; openedAt: number }
  export function normalizeRecentMedia(value: unknown, limit?: number): RecentMediaRecord[]
  export function recordRecentMedia(current: unknown, item: Partial<RecentMediaRecord>, limit?: number): RecentMediaRecord[]
  export interface MediaFileStat { size: number; mtimeMs: number }
  export function sameMediaFileStat(left: MediaFileStat | null | undefined, right: MediaFileStat | null | undefined): boolean
  export function classifyMediaPlaybackError(input: { localFile: boolean; openedStat: MediaFileStat | null; currentStat: MediaFileStat | null }): 'growing' | 'stable-error' | 'unavailable'
}

// 桌面端 Electron 注入的全局 API 类型声明
interface AiPlayerPlayerAPI {
  info: () => Promise<{ ready: boolean; embedded: boolean; available: boolean }>
  loadFile: (p: string) => Promise<boolean>
  play: () => Promise<boolean>
  pause: () => Promise<boolean>
  seek: (s: number) => Promise<boolean>
  setVolume: (v: number) => Promise<boolean>
  setSpeed: (v: number) => Promise<boolean>
  setPictureMode: (mode: 'original' | 'fit' | 'fill' | 'stretch') => Promise<boolean>
  loadSubtitle: (p: string) => Promise<boolean>
  setSubtitleVisible: (v: boolean) => Promise<boolean>
  setSubtitlePosition: (position: 'high' | 'middle' | 'low') => Promise<boolean>
  stop: () => Promise<boolean>
  screenshot: (suggestedName: string) => Promise<boolean>
  setPlayerArea: (rect: { x: number; y: number; width: number; height: number }) => void
  showContainer: () => void
  hideContainer: () => void
  onEvent: (cb: (data: MpvEvent) => void) => () => void
  onRemeasure: (cb: () => void) => () => void
}

interface SubtitleRecovery {
  kind: 'install-whisper' | 'install-translate' | 'configure-cloud'
  title: string
  detail: string
  actionLabel: string
  canAutoFix: boolean
  downloadBytes: number
  estimatedRequests: number
  timeLabel: string
  costLabel: string
  targetLang: '中文' | '英文'
  providerId?: string
  model?: string
  pricingUrl?: string
  pricingVerifiedAt?: string
}

interface PersistentRuntimeTask {
  id: string
  workspaceTaskId: string
  type: string
  state: 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled'
  status: string
  error: string
  updatedAt: number
  completedAt: number | null
  spec: {
    url?: string
    instruction?: string
    outputFormat?: string
    sources?: Array<{ path?: string; size?: number; mtimeMs?: number; sha256?: string }>
    [key: string]: unknown
  }
  checkpoint: Record<string, unknown>
  result: { outputPath?: string; outputs?: string[]; summary?: string; historyId?: string; [key: string]: unknown } | null
  quality?: {
    version: number; profile: string; score: number; threshold: number; passed: boolean; level: 'pass' | 'warning' | 'fail'
    reasons: Array<{ code: string; message: string; repairable: boolean; detail?: string }>
    checks: Array<{ id: string; label: string; passed: boolean; weight: number; score: number; detail?: string }>
  } | null
  repairHistory?: Array<{ attempt: number; action: string; fromScore: number; toScore: number; passed: boolean; reasons: string[]; completedAt: number }>
  failure?: { code: string; message: string; retryable: boolean } | null
  resumeToken: string
  approval?: {
    id: string
    action: 'cloud' | 'paid' | 'publish' | 'delete' | 'credential'
    summary: string
    status: string
    expiresAt: number
    token?: string
  } | null
}

interface PluginSkillInfo {
  id: string
  name: string
  version: string
  description: string
  publisher: string
  permissions: string[]
  enabled: boolean
  valid: boolean
  kind: 'declarative' | 'legacy-js'
  file: string
  skillCount: number
  toolCount: number
  error: string
  needsPermissionApproval?: boolean
}

interface PluginMutationResult {
  success?: boolean
  cancelled?: boolean
  error?: string
  plugins: PluginSkillInfo[]
}

interface EditDecisionListV1 {
  schemaVersion: 1
  kind: 'agentplay.edit-decision-list'
  decisionKind: string
  materials: Array<{ id: string; role: 'video' | 'music' | 'ambience' | 'sfx' | 'subtitle' | 'effect-video'; path: string; name: string }>
  tracks: Array<{ id: string; type: 'video' | 'audio' | 'subtitle'; materialId: string; optional?: boolean }>
  operations: Array<{
    id: string
    type: string
    materialId: string
    trackIds: string[]
    order?: number
    sourceRangeSeconds?: { start: number; end: number }
    targetRangeSeconds?: { start: number; end: number }
    parameters?: Record<string, unknown>
  }>
  output: { container: string; overwrite: false; suffix: string }
  quality: Record<string, unknown>
}

interface AudioExportQualityReceiptV1 {
  schemaVersion: 1
  method: 'unified-audio-export-qc-v1'
  verdict: 'matched'
  clipping: { verdict: 'matched'; samplePeakDbfs: number; truePeakDbtp: number; maximumTruePeakDbtp: number }
  loudness: { verdict: 'matched' | 'matched-user-policy'; integratedLufs: number; truePeakDbtp: number; withinProfessionalEnvelope: boolean; policy: { mode: string; minimumLufs: number; maximumLufs: number; maximumTruePeakDbtp: number } }
  avSync: { verdict: 'matched'; startDeltaSeconds: number; endDeltaSeconds: number; maximumStartDeltaSeconds: number; maximumEndDeltaSeconds: number }
  silence: { verdict: 'matched' | 'matched-source-baseline' | 'matched-planned-tail'; intervals: Array<{ startSeconds: number; endSeconds: number; durationSeconds: number; position: string }>; totalSilenceSeconds: number; silenceRatio: number; maximumSilenceSeconds: number }
  copyright: { verdict: 'documented'; sources: Array<{ fileName?: string; role?: string; status: 'verified-open-license' | 'user-supplied-unverified' | 'source-contained'; requiresUserResponsibility: boolean; licenseId?: string; licenseUrl?: string; track?: string; performer?: string; sourcePageUrl?: string; sha256?: string; receiptAbsolutePathOmitted?: true }> }
}

interface SubtitlePreviewBurnProofV1 {
  schemaVersion: 1
  method: 'single-render-subtitle-preview-burn-v1'
  verdict: 'matched'
  renderer: 'ffmpeg-libass-single-render'
  sameArtifact: true
  subtitleSha256: string
  renderFilterSha256: string
  cueCount: number
  cueLedgerSha256: string
  cues: Array<{ index: number; startMs: number; endMs: number; lineCount: number; previewCueSha256: string; finalCueSha256: string; matched: true }>
  preview: { path: string; artifactSha256: string; bytes: number; role: 'play-this-frozen-final-artifact' }
  final: { path: string; artifactSha256: string; bytes: number; role: 'delivered-artifact' }
}

interface AiAssetBundleDecisionV1 {
  schemaVersion: 1
  kind: 'creative.asset-bundle'
  strategy: 'ai-generated-asset-bundle-v1'
  instruction: string
  requestedKinds: Array<'shot' | 'narration' | 'voice' | 'sound-effect'>
  source?: { path: string; name: string }
  shot: { durationSeconds: number; width: number; height: number; motion: 'subtle-push' }
  soundEffect: { durationSeconds: number }
  safety: { approvalAction: 'paid'; uploadSourceMedia: false; markAiGeneratedSource: true; overwrite: false }
  output: { overwrite: false; bundle: true; suffix: string }
  verification: Record<string, boolean>
}

interface AiAssetBundleResultV1 {
  success: boolean
  requestId?: string
  cancelled?: boolean
  outputPath?: string
  outputs?: string[]
  summary?: string
  error?: string
  aiAssetReceipt?: {
    schemaVersion: 1
    kind: 'agentplay.ai-asset-bundle-receipt'
    verdict: 'matched'
    approvalAction: 'paid'
    sourceMediaUploaded: false
    requestedKinds: AiAssetBundleDecisionV1['requestedKinds']
    model: { providerId: string; providerName: string; model: string; local: false }
    artifacts: Array<{ kind: string; path: string; bytes: number; sha256: string; aiGenerated: true; generationMethod: string; providerId: string; model: string }>
    manifest: { path: string; bytes: number; sha256: string }
    recovery: { repeatedCloudCalls: 0; resumedFromCheckpoint: boolean }
  }
}

interface PersonalEditSkillV1 {
  id: string
  name: string
  enabled: boolean
  autoApply: boolean
  revision: number
  settings: { pace?: 'fast' | 'balanced' | 'restrained'; subtitlePreset?: 'clean' | 'impact' | 'documentary'; targetLufs?: number }
  createdAt: number
  updatedAt: number
  digest: string
}

interface MediaEditDecisionV1 {
  schemaVersion: 1
  kind: 'media.trim' | 'media.remove-segment' | 'media.concat-segments' | 'media.add-music' | 'media.mix-audio' | 'media.repair-audio' | 'media.rhythm-edit' | 'media.visual-effects' | 'media.smart-reframe' | 'media.visual-repair' | 'media.concat-sources' | 'media.burn-subtitles' | 'media.shift-subtitles' | 'media.mux-subtitles' | 'media.translate-subtitles' | 'media.edit-subtitle-cues' | 'media.transform-subtitles' | 'media.subtitle-layout-variants'
  instruction: string
  edl: EditDecisionListV1
  personalEditSkill?: { schemaVersion: 1; id: string; name: string; revision: number; digest: string; fieldsApplied: string[] }
  source?: { path: string; name: string }
  sources?: Array<{ path: string; name: string }>
  effectSources?: Array<{ path: string; name: string }>
  effects?: Array<
    | { type: 'crop'; aspect: '16:9' | '9:16' | '1:1' }
    | { type: 'scale'; factor: number }
    | { type: 'pip'; path: string; position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center'; scale: number; timeRange?: { startSeconds: number; endSeconds: number } }
    | { type: 'motion'; kind: 'zoom-in' | 'zoom-out' | 'pan-left-right' | 'pan-right-left'; amount: number; timeRange?: { startSeconds: number; endSeconds: number } }
    | { type: 'transition'; kind: 'fade'; atSeconds: number; durationSeconds: number }
    | { type: 'mask'; kind: 'solid' | 'privacy'; position: string; width: number; height: number; opacity: number; timeRange?: { startSeconds: number; endSeconds: number } }
    | { type: 'blur'; strength: number; timeRange?: { startSeconds: number; endSeconds: number } }
    | { type: 'color'; brightness: number; contrast: number; saturation: number; temperature: number }
    | { type: 'brand-package'; templateId: 'clean-tech' | 'warm-human' | 'bold-news'; elementKinds: Array<'title' | 'chapters' | 'person' | 'corner' | 'outro'> }
  >
  brandPackage?: { schemaVersion: 1; strategy: 'ass-brand-package-v1'; template: { id: 'clean-tech' | 'warm-human' | 'bold-news'; label: string; primaryAss: string; accentAss: string; backAss: string }; title?: { text: string }; chapters?: Array<{ atSeconds: number; text: string }>; person?: { name: string; role: string }; corner?: { text: string }; outro?: { text: string; durationSeconds: number } }
  reframe?: {
    strategy: 'vision-keyframes-linear-follow-v1'
    subject: { description: string; observed: string }
    sourceDimensions: { width: number; height: number }
    durationSeconds: number
    tracking: { strategy: 'sampled-subject-boxes-v1'; minimumConfidence: number; frames: Array<{ label: string; seconds: number; box: { x: number; y: number; width: number; height: number }; confidence: number }> }
    outputs: Array<{ aspect: '16:9' | '9:16' | '1:1'; suffix: string; width: number; height: number }>
    model: { providerId: string; providerName: string; model: string; local: boolean }
    correctionOf?: { subject: string; model: { providerId: string; providerName: string; model: string; local: boolean } | null }
  }
  repair?: {
    strategy: 'ffmpeg-visual-repair-v1'
    confirmationRequired: true
    sourceDimensions: { width: number; height: number }
    expectedDimensions: { width: number; height: number }
    durationSeconds: number
    stabilize: boolean
    rotationDegrees: number
    autoColor: boolean
    correction: { brightness: number; contrast: number; saturation: number; redShift: number; blueShift: number } | null
    signalStats: { sampleCount: number; yAvg: number; uAvg: number; vAvg: number; satAvg: number } | null
    lowQualityFindings: Array<{ type: 'black' | 'blur' | 'duplicate'; startSeconds: number; endSeconds: number; reason: string; action: 'review-only' }>
    comparison: { enabled: true; layout: 'side-by-side'; originalLabel: string; repairedLabel: string }
  }
  subtitle?: { path: string; name: string; style?: { fontSize?: 'large' | 'small'; alignment?: 'top' | 'bottom'; color?: string }; professional?: { schemaVersion: 1; strategy: 'acoustic-speaker-karaoke-v1'; enabled: true; speakers: { enabled: true; method: 'decoded-pcm-acoustic-cluster-v1'; maximumSpeakers: number; distanceThreshold: number; anonymousLabels: true }; wordHighlight: { enabled: true; method: 'whisper.cpp-dtw-v1'; minimumConfidence: number; exactCueAlignmentRequired: true }; karaoke: { enabled: true; mode: 'ass-kf'; assTag: 'kf' }; keywords: { enabled: true; explicit: string[]; autoWhenEmpty: true }; safeArea: { enabled: true; strategy: 'frame-band-complexity-v1'; candidateZones: Array<'top' | 'bottom'>; maximumLines: number } } }
  shift?: { direction: 'earlier' | 'later'; offsetSeconds: number }
  translate?: { targetLang: '英文' | '中文' | 'auto'; mode: 'translated' | 'bilingual' }
  cueEdit?: { operation: 'delete'; startIndex: number; endIndex: number } | { operation: 'replace'; index: number; text: string }
  subtitleTransform?: { schemaVersion: 1; strategy: 'ordered-subtitle-transform-v1'; replacements: Array<{ index: number; text: string }>; merges: Array<{ startIndex: number; endIndex: number; separator: string }>; splits: Array<{ index: number; atSeconds: number; parts: [string, string] }>; shift?: { direction: 'earlier' | 'later'; offsetSeconds: number }; translate?: { targetLang: '中文' | '英文' | 'auto'; mode: 'translated' | 'bilingual' }; style?: { preset: 'clean' | 'impact' | 'documentary' }; operationKinds: Array<'replace' | 'merge' | 'split' | 'shift' | 'translate' | 'style'> }
  subtitleLayout?: { schemaVersion: 1; strategy: 'responsive-ass-layout-v1'; position: 'auto' | 'top' | 'middle' | 'bottom'; stylePreset: 'clean' | 'impact' | 'documentary'; profiles: Array<{ id: string; label: string; aspect: '16:9' | '9:16' | '1:1'; width: number; height: number; maximumLines: 2 }> }
  audio?: { path: string; volume: number; fadeInSeconds: number; fadeOutSeconds: number; duck: boolean; loop: boolean; selection?: { startSeconds: number; endSeconds: number; durationSeconds: number }; loudness?: { enabled: boolean; targetLufs: number; targetTruePeakDbtp: number; maxTruePeakDbtp: number; lra: number; toleranceLufs: number } }
  audioMix?: {
    schemaVersion: 1
    strategy: 'multitrack-audio-mix-v1'
    dialogue: { enabled: boolean; volume: number; automation: Array<{ startSeconds: number; endSeconds: number; volume: number }> }
    tracks: Array<{ id: string; role: 'music' | 'ambience' | 'sfx'; path: string; name: string; volume: number; startSeconds: number; endSeconds?: number; loop: boolean; duckAgainstDialogue: boolean; fadeInSeconds: number; fadeOutSeconds: number; automation: Array<{ startSeconds: number; endSeconds: number; volume: number }> }>
    removedRoles: Array<'dialogue' | 'music' | 'ambience' | 'sfx'>
    master: { loudness: { enabled: boolean; targetLufs: number; targetTruePeakDbtp: number; maxTruePeakDbtp: number; lra: number; toleranceLufs: number }; limiter: { limit: number; autoLevel: false } }
  }
  music?: { path: string; name: string }
  policy?: { schemaVersion: 1; strategy: 'pcm-beat-highlight-edit-v1'; analysis: 'decoded-pcm-onset-grid-v1'; pace: 'fast' | 'balanced' | 'restrained'; baseBeatsPerCut: number; highlightBeatsPerCut: number; jumpGapSeconds: number; tailFadeSeconds: number; minimumCutSeconds: number; maximumCuts: number; preserveDialogue: boolean; musicVolume: number; dialogueDucking: boolean; outputLoudness: { targetLufs: number; maxTruePeakDbtp: number } }
  rhythm?: { schemaVersion: 1; strategy: 'beat-synced-jump-cut-v1'; pace: 'fast' | 'balanced' | 'restrained'; bpm: number; supportRatio: number; analysisMethod: 'decoded-pcm-onset-grid-v1'; sourceDurationSeconds: number; musicDurationSeconds: number; outputDurationSeconds: number; cutTimes: number[]; segments: Array<{ index: number; sourceStartSeconds: number; sourceEndSeconds: number; targetStartSeconds: number; targetEndSeconds: number }>; highlight: { startSeconds: number; endSeconds: number; score: number; alignedBeatSeconds: number; highlightAverageCutSeconds: number; outsideAverageCutSeconds: number; densityRatio: number }; tail: { endBeatSeconds: number; fadeSeconds: number; videoFade: true; audioFade: true }; confirmationRequired: true }
  audioRepair?: {
    schemaVersion: 1
    strategy: 'ffmpeg-audio-repair-v1'
    denoise: { enabled: boolean; method: string; noiseReductionDb: number; noiseFloorDb: number }
    dcRemoval: { enabled: boolean; method: string; cutoffHz: number }
    loudness: { enabled: boolean; targetLufs: number; targetTruePeakDbtp: number; maxTruePeakDbtp: number; lra: number; toleranceLufs: number }
    silenceRepair: { enabled: boolean; method: string; minimumGapSeconds: number; maximumGapSeconds: number; fillAmplitude: number; maximumGapCount: number; restoresSpeech: false }
    separation: { enabled: boolean; method: 'stereo-mid-side-v1'; requiresStereo: true; artifactWarning: string; outputs: Array<{ role: 'voice' | 'accompaniment'; suffix: string }> }
  }
  timeline?: ({ startSeconds: number; endSeconds: number; durationSeconds?: number; removedDurationSeconds?: number; segments?: never } | { segments: Array<{ sourceStartSeconds: number; sourceEndSeconds: number; durationSeconds: number; targetStartSeconds: number; targetEndSeconds: number }>; durationSeconds: number; startSeconds?: never; endSeconds?: never; removedDurationSeconds?: never })
  semanticLocate?: {
    schemaVersion: 1
    strategy: 'subtitle-exact-quote-v1' | 'whisper-dtw-phrase-start-v1'
    target: 'start-at-quote'
    subtitlePath: string
    query: string
    cueIndex: number
    cueStartSeconds: number
    cueEndSeconds: number
    text: string
    wordTimingEvidence?: { phraseStartSeconds: number; phraseEndSeconds: number; confidence: number; method: string; model: string; wordCount: number }
  }
  semanticSelect?: {
    schemaVersion: 1
    strategy: 'model-topic-selection-v1'
    target: 'keep-topic'
    topic: string
    subtitlePath: string
    sourceDurationSeconds: number
    confidence: number
    selectedCueIndexes: number[]
    evidence: Array<{ cueIndex: number; quote: string }>
    reason: string
    model: { providerId: string; providerName: string; model: string; local: boolean }
    ranges: Array<{ sourceStartSeconds: number; sourceEndSeconds: number; cueIndexes: number[] }>
    confirmationRequired: true
  }
  autoInspection?: {
    schemaVersion: 1
    strategy: 'media-auto-inspection-v1'
    confirmationRequired: true
    sourceDurationSeconds: number
    subtitlePath: string
    findings: {
      silences: Array<Record<string, unknown>>
      subtitleCandidates: Array<Record<string, unknown>>
      blackRanges: Array<Record<string, unknown>>
      blurRanges: Array<Record<string, unknown>>
      duplicateRanges: Array<Record<string, unknown>>
    }
    safeRemovals: Array<{ startSeconds: number; endSeconds: number; durationSeconds: number; kinds: string[]; reasons: string[] }>
    reviewOnly: Array<{ kind: string; startSeconds?: number; endSeconds?: number; durationSeconds?: number; reason?: string; text?: string; cueIndex?: number }>
    totalRemovedSeconds: number
  }
  semanticCut?: {
    schemaVersion: 1
    strategy: 'audio-silencedetect-v1' | 'subtitle-cue-cleanup-v1' | 'model-semantic-review-v1'
    target: 'long-pauses' | 'filler-and-adjacent-repeat' | 'near-duplicate-and-offtopic'
    minimumSilenceSeconds?: number
    keepPaddingSeconds?: number
    subtitlePath?: string
    confirmationRequired?: boolean
    sourceDurationSeconds: number
    detected: Array<{ startSeconds: number; endSeconds: number; durationSeconds?: number; cueIndex?: number; text?: string; reason?: string; preciseStartSeconds?: number; preciseEndSeconds?: number; timingMethod?: string; timingConfidence?: number; model?: string; match?: string }>
    removed: Array<{ startSeconds: number; endSeconds: number; durationSeconds: number; cueIndex?: number; text?: string; reason: string; timingMethod?: string; timingConfidence?: number; model?: string; match?: string }>
    reviewOnly?: Array<{ startSeconds: number; endSeconds: number; cueIndex: number; text: string; reason: string; matches: string[] }>
    wordTimingEvidence?: Array<{ cueIndex: number; text: string; match: string; startSeconds: number; endSeconds: number; confidence: number; method: string; model: string }>
    modelEvidence?: { topicSummary: string; model: { providerId: string; providerName: string; model: string; local: boolean }; candidates: Array<{ type: 'near_duplicate' | 'off_topic'; cueIndexes: number[]; removeCueIndexes: number[]; confidence: number; reason: string; evidence: Array<{ cueIndex: number; quote: string }> }> }
    visualEvidence?: { model: { providerId: string; providerName: string; model: string; local: boolean }; validations: Array<{ candidateIndex: number; verdict: 'safe' | 'unsafe' | 'uncertain'; confidence: number; reason: string; evidenceLabels: string[] }>; safeCandidateIndexes: number[]; blockedCandidateIndexes: number[]; frameMoments: Array<{ candidateIndex: number; role: 'before' | 'middle' | 'after'; label: string; seconds: number }> }
    totalRemovedSeconds: number
  }
  output: { overwrite: false; suffix: string; container?: string }
  verification?: { toleranceSeconds?: number; requirePreviewBurnParity?: boolean; requireProfessionalSubtitleProof?: boolean; [key: string]: unknown }
}

interface MediaEditClarification {
  id: string
  reason: 'missing-start' | 'missing-end' | 'missing-operation' | 'missing-range' | 'confirm-join-order'
  question: string
  sourcePath: string
  expiresAt: number
}

interface LongVideoVersionPlanV1 {
  schemaVersion: 1
  strategy: 'shared-evidence-long-video-versions-v1'
  confirmationRequired: true
  planHash: string
  instruction: string
  source: { path: string; name: string }
  subtitlePath: string
  sourceDurationSeconds: number
  summary: string
  model: { providerId: string; providerName: string; model: string; local: boolean }
  sharedEvidence: {
    chapters: Array<{ title: string; startCueIndex: number; endCueIndex: number; importance: number; reason: string; evidence: Array<{ cueIndex: number; quote: string }> }>
    highlights: Array<{ startCueIndex: number; endCueIndex: number; importance: number; reason: string; evidence: Array<{ cueIndex: number; quote: string }> }>
  }
  variants: Array<{ id: string; label: string; targetSeconds: number; durationSeconds: number; segments: Array<{ sourceStartSeconds: number; sourceEndSeconds: number; durationSeconds: number; importance: number; reason: string }> }>
  chapters: Array<{ id: string; label: string; title: string; sourceStartSeconds: number; sourceEndSeconds: number; durationSeconds: number; importance: number; reason: string }>
}

interface AiPlayerAPI {
  inlinePlayback?: {
    prepare: (input: { requestId: string; sourcePath: string; kind: 'video' | 'audio'; preflight?: boolean }) => Promise<{ success: boolean; path?: string; cached?: boolean; kind?: 'video' | 'audio'; duration?: number; backend?: string; cancelled?: boolean; error?: string }>
    cancel: (requestId: string) => Promise<boolean>
    onProgress: (cb: (progress: { requestId: string; phase: string; percent?: number }) => void) => () => void
  }
  platform: string
  isElectron: boolean
  version: string
  documents?: {
    capabilities: () => Promise<{
      formats: string[]
      modelConfigured: boolean
      modelLocal: boolean
      providerName: string
      model: string
      defaultOutputDir: string
    }>
    selectFiles: () => Promise<Array<{ token: string; name: string; ext: string; size: number; previewPath?: string }>>
    attachPaths: (filePaths: string[]) => Promise<Array<{ token: string; name: string; ext: string; size: number; previewPath?: string }> | { error: string }>
    previewText: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>
    history: () => Promise<Array<{ id: string; createdAt: string; instruction: string; kind: string; outputs: string[]; summary: string }>>
    plan: (input: {
      tokens: string[]
      instruction: string
      outputFormat: string
    }) => Promise<{
      kind: string
      requiresAi: boolean
      outputFormat: string
      summary: string
      estimatedTokens?: number
      contextWindow?: number
      processingMode?: 'single' | 'local-chunked' | 'cloud-fallback'
      requiresCloudApproval?: boolean
      fallbackModel?: string
      files: Array<{ name: string; ext: string; size: number }>
    }>
    run: (input: {
      tokens: string[]
      instruction: string
      outputFormat: string
      cloudApproved: boolean
      preferLocal?: boolean
      requestId: string
      workspaceTaskId?: string
    }) => Promise<{
      success: boolean
      requestId: string
      requiresApproval?: boolean
      approval?: {
        id: string
        action: 'cloud' | 'paid' | 'publish' | 'delete' | 'credential'
        summary: string
        status: string
        expiresAt: number
        token?: string
      }
      outputs?: string[]
      summary?: string
      historyId?: string
      plan?: { kind: string; requiresAi: boolean; outputFormat: string }
      failures?: Record<string, string>
      deliveryReceipt?: {
        schemaVersion: 1
        kind: 'agentplay.delivery-receipt'
        status: 'complete' | 'partial'
        instructionSha256: string
        sources: Array<{ path: string; name: string; bytes: number; sha256: string }>
        artifacts: Array<{ path: string; name: string; format: string; bytes: number; sha256: string; factIds?: string[]; sourceLedgerSha256?: string }>
        bundle?: {
          requestedFormats: string[]
          completedFormats: string[]
          failedFormats: Record<string, string>
          sourceLedgerSha256: string
          consistency: { verdict: 'matched' | 'partial'; sharedSourceLedger: boolean }
        }
      }
      quality?: import('../taskLifecycle').WorkspaceTaskQuality | null
      repairHistory?: import('../taskLifecycle').WorkspaceTaskRepairReceipt[]
      failure?: import('../taskLifecycle').WorkspaceTaskFailure | null
      projectCapsule?: { schemaVersion: 1; projectId: string; name: string; revision: number; materialCount: number; artifactCount: number; currentPath: string; currentArtifactId: string; updatedAt: number }
      error?: string
    }>
    cancel: (requestId: string) => Promise<boolean>
    onStatus: (cb: (event: { requestId: string; status: string }) => void) => () => void
    onOpenExternal: (cb: (files: Array<{ token: string; name: string; ext: string; size: number; previewPath?: string }>) => void) => () => void
  }
  analysis?: {
    detect: (text: string) => Promise<{ matched: boolean; outputFormat: string }>
    run: (input: {
      sourcePath: string
      mediaName: string | null
      duration: number
      instruction: string
      outputFormat: string
      cloudApproved: boolean
      requestId: string
      workspaceTaskId?: string
    }) => Promise<{
      success: boolean
      requestId: string
      requiresApproval?: boolean
      approval?: {
        id: string
        action: 'cloud' | 'paid' | 'publish' | 'delete' | 'credential'
        summary: string
        status: string
        expiresAt: number
        token?: string
      }
      outputs?: string[]
      summary?: string
      historyId?: string
      usedAi?: boolean
      excerpt?: string
      cueCount?: number
      error?: string
    }>
    cancel: (requestId: string) => Promise<boolean>
    onStatus: (cb: (event: { requestId: string; status: string }) => void) => () => void
  }
  outcomeWorkflow?: {
    detect: (input: { sourcePath: string; instruction: string }) => Promise<{ matched: boolean; formats: string[]; steps: string[] }>
    run: (input: { sourcePath: string; mediaName: string | null; duration: number; instruction: string; cloudApproved: boolean; requestId: string; workspaceTaskId?: string }) => Promise<{
      success: boolean
      requestId: string
      requiresApproval?: boolean
      approval?: { id: string; action: 'cloud' | 'paid' | 'publish' | 'delete' | 'credential'; summary: string; status: string; expiresAt: number; token?: string }
      outputs?: string[]
      summary?: string
      workflowReceipt?: { schemaVersion: 1; kind: 'agentplay.outcome-workflow-receipt'; source: { path: string; size: number; mtimeMs: number; sha256: string }; steps: Array<{ id: string; state: string; outputs: string[]; historyId?: string }> }
      deliveryReceipt?: { schemaVersion: 1; kind: 'agentplay.delivery-receipt'; sources: Array<{ path: string; name: string; bytes: number; sha256: string }>; artifacts: Array<{ path: string; name: string; format: string; bytes: number; sha256: string }> }
      quality?: import('../taskLifecycle').WorkspaceTaskQuality | null
      failure?: import('../taskLifecycle').WorkspaceTaskFailure | null
      projectCapsule?: { schemaVersion: 1; projectId: string; name: string; revision: number; materialCount: number; artifactCount: number; currentPath: string; currentArtifactId: string; updatedAt: number }
      error?: string
    }>
    cancel: (requestId: string) => Promise<boolean>
    onStatus: (cb: (event: { requestId: string; status: string }) => void) => () => void
  }
  projects?: {
    list: () => Promise<Array<{ schemaVersion: 1; projectId: string; name: string; revision: number; materialCount: number; artifactCount: number; currentPath: string; currentArtifactId: string; updatedAt: number }>>
    get: (projectId: string) => Promise<Record<string, unknown> | null>
    listTrash: () => Promise<Array<{ projectId: string; name: string; status: string; revision: number }>>
    archive: (input: { projectId: string; archived?: boolean }) => Promise<{ projectId: string; status: string }>
    copy: (projectId: string) => Promise<{ projectId: string; name: string; status: string }>
    trash: (input: { projectId: string; requestId: string; approvalId?: string; approvalToken?: string }) => Promise<{ success: boolean; requiresApproval?: boolean; requestId?: string; approval?: { id: string; action: 'delete'; summary: string; token: string; expiresAt: number }; error?: string; projectCapsule?: { projectId: string; status: string } }>
    restore: (projectId: string) => Promise<{ projectId: string; status: string; revision: number }>
  }
  linkContent?: {
    detect: (text: string) => Promise<{ matched: boolean; kind: string; url: string; host?: string }>
    handle: (input: { url: string; instruction: string }) => Promise<{ success: boolean; action?: 'preview' | 'download' | 'translate' | 'project'; controlled?: boolean; kind?: string; url?: string; title?: string; excerpt?: string; translated?: string; outputPath?: string; reason?: string; error?: string; evidence?: Array<{ schemaVersion: 1; kind: 'agentplay.evidence-reference'; evidenceKind: string; source: string; locator: Record<string, unknown>; excerpt: string }>; projectCapsule?: { projectId: string; revision: number } }>
  }
  evidence?: {
    inspectFile: (filePath: string) => Promise<{ source: string; evidence: Array<{ schemaVersion: 1; kind: 'agentplay.evidence-reference'; evidenceKind: 'video-time' | 'document-page' | 'web-paragraph' | 'sheet-cell' | 'image-region'; source: string; locator: Record<string, unknown>; excerpt: string }> }>
  }
  crossMaterial?: {
    detect: (input: { tokens: string[]; currentPath?: string; question: string }) => Promise<{ matched: boolean; sourceCount: number; projectId?: string; error?: string }>
    ask: (input: { tokens: string[]; currentPath?: string; question: string; cloudApproved: boolean; requestId: string; workspaceTaskId?: string }) => Promise<{
      success: boolean; matched: boolean; requestId: string; summary?: string; error?: string; requiresApproval?: boolean
      approval?: { id: string; action: 'cloud'; summary: string; status: string; expiresAt: number; token?: string }
      claims?: Array<{ id: string; text: string; status: 'confirmed' | 'inference' | 'unknown'; evidenceIds: string[] }>
      evidence?: Array<{ id: string; schemaVersion: 1; kind: 'agentplay.evidence-reference'; evidenceKind: 'video-time' | 'document-page' | 'web-paragraph' | 'sheet-cell' | 'image-region'; source: string; locator: Record<string, unknown>; excerpt: string; locatorLabel: string }>
      quality?: import('../taskLifecycle').WorkspaceTaskQuality | null
      projectCapsule?: { projectId: string; name: string; revision: number }
    }>
    cancel: (requestId: string) => Promise<boolean>
    onStatus: (cb: (event: { requestId: string; status: string }) => void) => () => void
  }
  localAI?: {
    status: () => Promise<LocalAiComponentStatus>
    download: () => Promise<{ success: boolean; error?: string; status?: BundledModelStatus }>
    cancel: () => Promise<boolean>
    onProgress: (cb: (progress: LocalAiDownloadProgress) => void) => () => void
  }
  home?: {
    open: () => Promise<{ media: string[]; documents: Array<{ token: string; name: string; ext: string; size: number; previewPath?: string }>; folders: string[] }>
    openFolder: () => Promise<{ folders: string[] }>
  }
  chat?: {
    openAny: () => Promise<{ media: string[]; documents: Array<{ token: string; name: string; ext: string; size: number; previewPath?: string }> }>
    attachPaths: (filePaths: string[]) => Promise<{ documents: Array<{ token: string; name: string; ext: string; size: number; previewPath?: string }>; skipped: number }>
  }
  transcribe?: {
    status: () => Promise<{ available: boolean; engineOk: boolean; modelOk: boolean; reason: string; download: Partial<LocalAiDownloadProgress> & { active: boolean; installed: boolean; presentBytes: number; totalBytes: number }; pack: { tag: string; totalBytes: number; assetCount: number } }>
    download: () => Promise<{ success: boolean; error?: string; availability?: unknown }>
    downloadSmall: () => Promise<{ success: boolean; error?: string; availability?: unknown }>
    cancelDownloadSmall: () => Promise<boolean>
    cancelDownload: () => Promise<boolean>
    blob: (input: { data: Uint8Array; ext?: string }) => Promise<{ success: boolean; text?: string; error?: string }>
    onProgress: (cb: (progress: LocalAiDownloadProgress) => void) => () => void
  }
  siteVideo?: {
    status: () => Promise<{ available: boolean; reason: string; enginePath: string; download: Partial<LocalAiDownloadProgress> & { active: boolean; installed: boolean; presentBytes: number; totalBytes: number }; pack: { tag: string; totalBytes: number; assetCount: number } }>
    downloadComponent: () => Promise<{ success: boolean; error?: string; availability?: unknown }>
    cancelComponent: () => Promise<boolean>
    download: (input: { url: string; requestId: string; workspaceTaskId?: string }) => Promise<{ success: boolean; error?: string; requestId?: string; outputPath?: string; bytes?: number; info?: { title: string; duration: number; uploader: string; extractor: string } }>
    importCookies: () => Promise<{ success: boolean; canceled?: boolean; error?: string; domain?: string; count?: number }>
    cookiesStatus: () => Promise<Array<{ domain: string; updatedAt: number }>>
    login: (input: { url: string }) => Promise<{ success: boolean; canceled?: boolean; error?: string; domain?: string; file?: string }>
    onComponentProgress: (cb: (progress: LocalAiDownloadProgress) => void) => () => void
  }
  mirror?: {
    startReceiver: () => Promise<{ success: boolean; port?: number; pin?: string; name?: string; error?: string }>
    stopReceiver: () => Promise<boolean>
    scan: () => Promise<Array<{ name: string; host: string; port: number }>>
    startSender: (input: { host: string; port: number; pin: string }) => Promise<{ success: boolean; error?: string }>
    stopSender: () => Promise<boolean>
    status: () => Promise<{ receiving: { port: number; pin: string; name: string } | null; sending: { host: string; port: number } | null }>
  }
  mediaDownload?: {
    detect: (text: string) => Promise<{ matched: boolean; url: string; direct?: boolean; mode?: 'analyze' | 'download' | null }>
    download: (input: { url: string; requestId: string; workspaceTaskId?: string }) => Promise<{ success: boolean; error?: string; requestId?: string; outputPath?: string; bytes?: number; finalUrl?: string }>
    linkAnalysis: (input: { url?: string; videoPath?: string; instruction?: string; outputFormat?: string; cloudApproved?: boolean; requestId: string }) => Promise<{ success: boolean; error?: string; requiresApproval?: boolean; requestId?: string; videoPath?: string; info?: { title: string; duration: number; uploader: string }; outputs?: string[]; summary?: string; usedAi?: boolean; excerpt?: string; cueCount?: number; whispered?: boolean }>
    cancel: (requestId: string) => Promise<boolean>
    onStatus: (cb: (event: { requestId: string; status: string }) => void) => () => void
  }
  taskRuntime?: {
    list: () => Promise<PersistentRuntimeTask[]>
    approve: (input: { approvalId: string; token: string }) => Promise<PersistentRuntimeTask>
    resume: (input: { id: string; token: string }) => Promise<PersistentRuntimeTask>
    cancel: (id: string) => Promise<boolean>
    onEvent: (cb: (task: PersistentRuntimeTask) => void) => () => void
  }
  notifications?: {
    history: () => Promise<Array<{ schemaVersion: 1; id: string; runtimeTaskId: string; workspaceTaskId: string; taskType: string; state: 'waiting_approval' | 'completed' | 'failed'; title: string; body: string; outputPath: string; nativeShown: boolean; nativeSupported: boolean; createdAt: number; activatedAt: number | null }>>
    activate: (id: string) => Promise<boolean>
    onActivate: (cb: (record: { id: string; runtimeTaskId: string; workspaceTaskId: string; state: string; outputPath: string }) => void) => () => void
  }
  translatePack?: {
    status: () => Promise<{ available: boolean; missing: string[]; reason: string; modelDir: string; download: Partial<LocalAiDownloadProgress> & { active: boolean; installed: boolean; presentBytes: number; totalBytes: number }; pack: { tag: string; totalBytes: number; assetCount: number } }>
    download: () => Promise<{ success: boolean; error?: string; availability?: unknown }>
    cancelDownload: () => Promise<boolean>
    onProgress: (cb: (progress: LocalAiDownloadProgress) => void) => () => void
  }
  ebook?: {
    open: (input: { identifier: string; fileName: string }) => Promise<{ success: boolean; error?: string; chapters: string[]; count: number }>
    chapter: (input: { identifier: string; fileName: string; index: number }) => Promise<{ success: boolean; error?: string; title: string; text: string; index: number }>
    translate: (input: { identifier: string; fileName: string; index: number; engine: 'offline' | 'cloud'; target?: 'zh' | 'vernacular' | 'en' }) => Promise<{ success: boolean; error?: string; text: string; cached?: boolean }>
    onTranslateStatus: (cb: (event: { index: number; status: string }) => void) => () => void
  }
  rapidocrPack?: {
    status: () => Promise<{ available: boolean; missing: string[]; reason: string; modelDir: string; download: Partial<LocalAiDownloadProgress> & { active: boolean; installed: boolean; presentBytes: number; totalBytes: number }; pack: { tag: string; totalBytes: number; assetCount: number } }>
    download: () => Promise<{ success: boolean; error?: string; availability?: unknown }>
    cancelDownload: () => Promise<boolean>
    onProgress: (cb: (progress: LocalAiDownloadProgress) => void) => () => void
  }
  unlimitedOcr?: {
    status: (input?: { probe?: boolean }) => Promise<{ enabled: boolean; ready: boolean; reason: string; baseUrl: string; model: string; local: boolean; hasApiKey: boolean; models?: string[] }>
    save: (input: { enabled?: boolean; baseUrl?: string; model?: string; apiKey?: string; clearApiKey?: boolean }) => Promise<{ success: boolean; cancelled?: boolean; error?: string; status: { enabled: boolean; ready?: boolean; reason?: string; baseUrl: string; model: string; local: boolean; hasApiKey: boolean; models?: string[] } }>
  }
  onlineMedia?: {
    search: (input: { query: string; kind?: 'movie' | 'audio' | 'book'; page?: number }) => Promise<{ success: boolean; error?: string; items: Array<{ identifier: string; title: string; track?: string; year: string; creator: string; performer?: string; recordingSource?: string; downloads: number; license?: { id: string; name: string; url: string; publicDomain: boolean; attributionRequired: boolean }; usageScope?: { commercialUse: boolean; adaptationAllowed: boolean; videoSyncAllowed: boolean; attributionRequired: boolean; shareAlike: boolean; notice: string } }>; total: number }>
    files: (input: { identifier: string; kind?: 'movie' | 'audio' }) => Promise<{ success: boolean; error?: string; identifier: string; title: string; files: Array<{ name: string; size: number; url: string; format: string }> }>
    licensedMusicFiles: (input: { identifier: string }) => Promise<{ success: boolean; error?: string; identifier: string; title: string; files: Array<{ name: string; size: number; url: string; format: string; track: string; performer: string; recordingSource: string; sourcePageUrl: string; license: { id: string; name: string; url: string; publicDomain: boolean; attributionRequired: boolean }; usageScope: { commercialUse: boolean; adaptationAllowed: boolean; videoSyncAllowed: boolean; attributionRequired: boolean; shareAlike: boolean; notice: string }; attributionText: string }> }>
    bookFiles: (input: { identifier: string }) => Promise<{ success: boolean; error?: string; identifier: string; title: string; creator: string; files: Array<{ name: string; size: number; url: string; format: string }> }>
    download: (input: { url: string; requestId: string }) => Promise<{ success: boolean; error?: string; outputPath?: string; bytes?: number }>
    downloadLicensedMusic: (input: { identifier: string; fileName: string; requestId: string }) => Promise<{ success: boolean; error?: string; outputPath?: string; bytes?: number; receiptPath?: string; receipt?: { schemaVersion: 1; kind: 'agentplay.licensed-music-receipt'; track: { title: string }; recording: { performer: string; source: string }; license: { id: string; name: string; url: string }; usageScope: { commercialUse: boolean; adaptationAllowed: boolean; videoSyncAllowed: boolean; attributionRequired: boolean; shareAlike: boolean; notice: string }; file: { sha256: string } } }>
    cancel: (requestId: string) => Promise<boolean>
    onProgress: (cb: (progress: { requestId: string; received: number; total: number }) => void) => () => void
  }
  subtitleBilingual?: {
    generate: (input: { path: string; requestId: string; workspaceTaskId?: string; cloudApproved?: boolean; engine?: 'auto' | 'cloud' | 'local'; targetLang?: '中文' | '英文'; durationSeconds?: number }) => Promise<{ success: boolean; error?: string; cancelled?: boolean; busy?: boolean; needDownload?: boolean; recovery?: SubtitleRecovery; srtPath?: string; outputs?: string[]; count?: number; sourceCount?: number; failed?: number; cached?: boolean; engine?: string; sourceLang?: 'zh' | 'en'; targetLang?: '中文' | '英文' }>
    cancel: (requestId: string) => Promise<boolean>
    onStatus: (cb: (event: { requestId: string; status: string }) => void) => () => void
  }
  detectLanguage?: (filePath: string) => Promise<{ lang: string; reason?: string; sample?: string }>
  subtitleLive?: {
    start: (input: { mediaPath: string; subtitlePath?: string; currentTime?: number; targetLang?: string; requestId: string; engine?: 'auto' | 'cloud' | 'local' }) => Promise<{
      success: boolean
      error?: string
      requestId?: string
      total?: number
      subtitlePath?: string
      engine?: string
      targetLang?: string
      cues?: Array<{ index: number; start: number; end: number; text: string }>
    }>
    startTranscribe: (input: { mediaPath: string; currentTime: number; duration?: number; requestId?: string }) => Promise<{
      success: boolean
      error?: string
      requestId?: string
      durationSec?: number
    }>
    seek: (input: { requestId: string; currentTime: number }) => Promise<boolean>
    stop: (requestId?: string) => Promise<boolean>
    onEvent: (cb: (event: {
      requestId: string
      type: 'progress' | 'finish' | 'error' | 'transcribe-cues' | 'refining' | 'refined' | 'refine-failed'
      done?: number
      failed?: number
      total?: number
      batch?: Array<{ index: number; text: string }>
      cueCount?: number
      cues?: Array<{ index: number; start: number; end: number; text: string }>
      srtPath?: string | null
      targetLang?: string
      cancelled?: boolean
      error?: string
    }) => void) => () => void
  }
  player?: AiPlayerPlayerAPI
  sync?: {
    url: () => Promise<string | null>
    stop: () => Promise<boolean>
    setPeer: (url: string) => Promise<boolean>
    upload: () => Promise<{ success?: boolean; error?: string; count?: number }>
    download: () => Promise<{ success?: boolean; error?: string; count?: number }>
    getProgress: (key: string) => Promise<{ position: number; preferences?: { volume?: number; subtitleVisible?: boolean }; updatedAt: number } | null>
    setProgress: (key: string, position: number, preferences: { volume: number; subtitleVisible: boolean }) => Promise<boolean>
  }
  cast?: {
    scan: () => Promise<Array<{ id: string; name: string; location: string; controlUrl: string; lastSuccess?: boolean }>>
    cast: (deviceId: string, filePath: string) => Promise<{ success: boolean; action?: string; error?: string }>
    stop: (deviceId: string) => Promise<{ success: boolean; action?: string; error?: string }>
    pause: (deviceId: string) => Promise<{ success: boolean; action?: string; error?: string }>
    resume: (deviceId: string) => Promise<{ success: boolean; action?: string; error?: string }>
    seek: (deviceId: string, seconds: number) => Promise<{ success: boolean; action?: string; error?: string }>
    status: (deviceId: string) => Promise<{ success: boolean; state?: string; label?: string; error?: string }>
    ensureFirewall: () => Promise<{ needed: boolean }>
    allowFirewall: () => Promise<{ success: boolean; error?: string }>
    smartScan: () => Promise<Array<{ id: string; name: string; kind: 'tv' | 'agentplay'; host?: string; port?: number; lastSuccess?: boolean }>>
  }
  tmdb?: {
    search: (name: string) => Promise<{ success: boolean; data?: { title: string; poster: string | null; overview: string; year: string | null }; error?: string }>
  }
  serviceCredentials?: {
    status: () => Promise<{
      schemaVersion: number
      keyStorage: string
      services: Record<'tmdb' | 'opensubtitles', { hasKey: boolean; updatedAt: string | null; source: 'system' | 'environment' | 'none' }>
    }>
    save: (input: { service: 'tmdb' | 'opensubtitles'; key?: string; clear?: boolean }) => Promise<{
      schemaVersion: number
      keyStorage: string
      services: Record<'tmdb' | 'opensubtitles', { hasKey: boolean; updatedAt: string | null; source: 'system' | 'environment' | 'none' }>
    }>
  }
  wifi?: {
    url: () => Promise<string | null>
    pin: () => Promise<string | null>
    stop: () => Promise<boolean>
  }
  dlna?: {
    serverUrl: () => Promise<string | null>
    stopServer: () => Promise<boolean>
  }
  plugin?: {
    list: () => Promise<PluginSkillInfo[]>
    refresh: () => Promise<PluginSkillInfo[]>
    install: () => Promise<PluginMutationResult>
    setEnabled: (input: { id: string; enabled: boolean; permissions: string[] }) => Promise<PluginMutationResult>
    remove: (input: { id: string; confirmed: boolean }) => Promise<PluginMutationResult>
    openFolder: () => Promise<{ success: boolean; error?: string }>
  }
  media?: {
    analyze: (dir?: string) => Promise<{
      files: Array<{ name: string; path: string; ext: string; type: string; size: number; tags: string[]; group: string }>
      clusters: Record<string, unknown[]>
    }>
    dedup: (input: { requestId: string; dir?: string; directoryPath?: string; workspaceTaskId?: string }) => Promise<{
      success: boolean
      requestId: string
      cancelled?: boolean
      error?: string
      duplicates: Array<{ original: string; duplicate: string; name: string }>
      filesScanned: number
    }>
    cancel: (requestId: string) => Promise<boolean>
    onDedupProgress: (cb: (progress: {
      requestId: string
      phase: 'scanning' | 'hashing' | 'complete'
      filesScanned?: number
      directoriesScanned?: number
      processedFiles?: number
      totalFiles?: number
      bytesRead?: number
      totalBytes?: number
      currentFile?: string
      duplicateCount?: number
    }) => void) => () => void
    suggest: (dir?: string) => Promise<Array<{ tag: string; count: number; files: string[]; suggestion: string }>>
  }
  studio?: {
    capabilities: () => Promise<{ platform: string; multimodalPlanning: boolean; cloudImage: boolean; cloudVoice: boolean; systemVoice: boolean; advancedRender: boolean; renderBinary: string | null }>
    context: (mediaPath: string) => Promise<{
      subtitlePath: string | null
      cues: Array<{ start: number; end: number; text: string }>
      transcript: string
    }>
    offlineAnalysis: (input: {
      mediaName: string | null
      duration: number
      markers: Array<{
        id: string
        at: number
        thumbnail?: string
        shotSize: string
        movement: string
        function: string
        emotion: string
        note: string
      }>
      cues: Array<{ start: number; end: number; text: string }>
    }) => Promise<string>
    exportProject: (project: Record<string, unknown>) => Promise<{ success: boolean; cancelled?: boolean; outputPath?: string }>
    render: (input: {
      mediaName: string | null
      sourcePath: string
      segments: Array<{ start: number; end: number }>
    }) => Promise<{ success: boolean; cancelled?: boolean; outputPath?: string; bytes?: number }>
    creativePlan: (input: Record<string, unknown>) => Promise<{
      version: number
      title: string
      hook: string
      narration: string
      musicBrief: string
      subtitleStyle: 'clean' | 'impact' | 'documentary'
      deepAnalysis: { narrative: string; visual: string; editing: string; audio: string; hook: string; weaknesses: string[] }
      modality: 'text-evidence' | 'vision+text-evidence'
      provider?: string
      model?: string
      visualEvidenceCount?: number
      visualFallbackReason?: string
      riskNotes: string[]
      shots: Array<{
        id: string
        kind: 'source' | 'generated'
        segmentId: string
        duration: number
        title: string
        prompt: string
        narration: string
        caption: string
        assetPath: string
        status: string
      }>
    }>
    planAssets: (input: { instruction: string; sourcePath?: string }) => Promise<{ matched: boolean; decision?: AiAssetBundleDecisionV1 }>
    generateAssets: (input: { instruction: string; sourcePath?: string; decision: AiAssetBundleDecisionV1; requestId: string; workspaceTaskId?: string }) => Promise<AiAssetBundleResultV1>
    generateImage: (input: { id: string; prompt: string; model?: string; size?: string }) => Promise<{ success: boolean; outputPath: string; bytes: number }>
    generateVideo: (input: { id?: string; prompt: string; instruction?: string; model?: string; duration?: number; fps?: number; size?: string; imageBase64?: string; requestId: string; workspaceTaskId?: string }) => Promise<{ success: boolean; requestId?: string; cancelled?: boolean; outputPath?: string; outputs?: string[]; bytes?: number; videoId?: string; numFrames?: number; error?: string }>
    planRecut: (input: { reportText?: string; mediaName: string; count?: number; originalGoal?: string }) => Promise<{ success: boolean; blueprint?: Record<string, unknown>; blueprintSha256?: string; protectedFragmentCount?: number; summary?: string; error?: string }>
    validateRecutShots: (input: { reportText?: string; mediaName: string; count?: number; shots: Array<{ prompt: string; duration: number; shotSize: string; movement: string; originalityDeclaration: string }> }) => Promise<{ success: boolean; shots?: Array<{ prompt: string; duration: number; shotSize: string; movement: string }>; receipt?: Record<string, unknown>; error?: string }>
    recutShort: (input: { reportText?: string; mediaName: string; originalGoal?: string; blueprintSha256?: string; count?: number; seconds?: number; requestId: string; workspaceTaskId?: string }) => Promise<{ success: boolean; requestId?: string; cancelled?: boolean; outputPath?: string; outputs?: string[]; shots?: string[]; styleShots?: Array<{ prompt: string; duration: number; shotSize: string; movement: string }>; styleReuseReceipt?: Record<string, unknown>; clips?: number; summary?: string; error?: string }>
    cancelTask: (requestId: string) => Promise<boolean>
    onRecutProgress: (cb: (event: { requestId?: string; stage: string }) => void) => () => void
    generateVoice: (input: { text: string; engine: 'system' | 'cloud'; model?: string; voice?: string; rate?: number }) => Promise<{ success: boolean; outputPath: string; bytes: number; engine: string }>
    selectAsset: (kind: 'image' | 'audio') => Promise<string | null>
    renderCreative: (input: Record<string, unknown>) => Promise<{ success: boolean; cancelled?: boolean; outputPath?: string; bytes?: number; shots?: number; duration?: number }>
    cancelRender: () => Promise<boolean>
  }
  receiver?: {
    start: () => Promise<boolean>
    stop: () => Promise<boolean>
    onPlay: (cb: (url: string) => void) => () => void
  }
  menu?: {
    onAction: (cb: (action: string) => void) => () => void
    onOpenFile: (cb: (filePath: string) => void) => () => void
    confirmOpenFile?: (filePath: string) => void
    onOpenFolder: (cb: (dirPath: string) => void) => () => void
    onAgent: (cb: () => void) => () => void
  }
  contextMenu?: {
    show: (state: { hasMedia: boolean; isPlaying: boolean; subtitleVisible: boolean; pictureMode: string; playbackRate: number; liveTranslate?: boolean }) => void
  }
  windowControls?: {
    setPreset: (preset: 'original' | 'half' | 'fill' | 'fullscreen', mediaSize?: { width: number; height: number }) => Promise<boolean>
    setFullscreen: (fullscreen: boolean) => Promise<boolean>
    isFullscreen: () => Promise<boolean>
    setPlaybackChromeVisible: (visible: boolean) => Promise<boolean>
    isPlaybackChromeVisible: () => Promise<boolean>
    onFullscreenChanged: (cb: (fullscreen: boolean) => void) => () => void
  }
  screenshot?: {
    save: (dataUrl: string, suggestedName: string) => Promise<boolean>
  }
  models?: {
    providers: () => Promise<Array<{
      id: string; name: string; region: string; protocol: 'openai' | 'anthropic' | 'gemini';
      baseUrl: string; models: string[]; requiresKey: boolean; modelHint?: string; warning?: string;
      computerUseProtocol?: 'fara-native';
      bundled?: boolean;
      roles: Array<'chat' | 'computerUse'>;
      capabilities: { streaming?: boolean; tools?: boolean; vision?: boolean; computerUse?: boolean }
      contextWindow?: number; maxOutputTokens?: number;
      thinkingMode?: 'enabled' | 'disabled';
      pricing?: { cachedInputUsdPerMillion?: number; inputUsdPerMillion: number; outputUsdPerMillion: number };
      modelProfiles?: Record<string, { contextWindow?: number; maxOutputTokens?: number; thinkingMode?: 'enabled' | 'disabled'; pricing?: { cachedInputUsdPerMillion?: number; inputUsdPerMillion: number; outputUsdPerMillion: number } }>;
      pricingUrl?: string; pricingVerifiedAt?: string;
    }>>
    config: (role?: 'chat' | 'computerUse') => Promise<{ schemaVersion: number; role: 'chat' | 'computerUse'; providerId: string; providerName: string; model: string; baseUrl: string; hasApiKey: boolean; requiresKey: boolean; localOnly: boolean; configured: boolean; keyStorage: string; capabilities: Record<string, boolean | number>; contextWindow?: number; maxOutputTokens?: number; thinkingMode?: 'enabled' | 'disabled'; pricing?: { cachedInputUsdPerMillion?: number; inputUsdPerMillion: number; outputUsdPerMillion: number }; pricingUrl?: string; pricingVerifiedAt?: string }>
    routingStatus: () => Promise<ModelRoutingStatus>
    routingSettings: (input: { preference?: 'smart' | 'local' | 'cloud'; objective?: 'balanced' | 'quality' | 'speed' | 'economy' }) => Promise<ModelRoutingStatus>
    disconnect: (input: { role?: 'chat' | 'computerUse'; providerId: string; baseUrl: string }) => Promise<{ disconnected: boolean; candidates: Array<{ providerId: string; providerName: string; model: string; baseUrl: string; localOnly: boolean; configured: boolean; hasApiKey: boolean }> }>
    save: (config: { role?: 'chat' | 'computerUse'; providerId: string; model: string; thinkingMode?: 'enabled' | 'disabled'; baseUrl: string; apiKey?: string; clearApiKey?: boolean }) => Promise<{ providerId: string; model: string; thinkingMode?: 'enabled' | 'disabled'; baseUrl: string; hasApiKey: boolean }>
    list: (config: { role?: 'chat' | 'computerUse'; providerId: string; model: string; thinkingMode?: 'enabled' | 'disabled'; baseUrl: string; apiKey?: string; useSavedKey?: boolean }) => Promise<{ success: boolean; models: string[]; error?: string }>
    test: (config: { role?: 'chat' | 'computerUse'; providerId: string; model: string; thinkingMode?: 'enabled' | 'disabled'; baseUrl: string; apiKey?: string; useSavedKey?: boolean }) => Promise<{ success: boolean; message: string; planDetected?: boolean; upgrade?: { providerId: string; baseUrl: string; model: string; models: string[] } }>
    discoverLocal: (role?: 'chat' | 'computerUse') => Promise<Array<{ id: string; role: 'chat' | 'computerUse'; name: string; providerId: string; baseUrl: string; status: 'ready'; models: string[] }>>
    autoDetect: (input: { apiKey: string; providerId: string }) => Promise<{ success: boolean; needsProvider?: boolean; matches?: Array<{ providerId: string; providerName: string; models: string[]; latencyMs: number }>; error?: string }>
    cliStatus: () => Promise<{ codex: { installed: boolean; loggedIn: boolean; note: string }; claude: { installed: boolean; loggedIn: boolean; note: string } }>
    refreshCatalog: () => Promise<{ updated: number; providers?: string[]; error?: string }>
    bundledStatus: () => Promise<BundledModelStatus>
    startBundled: () => Promise<BundledModelStatus>
    stopBundled: () => Promise<BundledModelStatus>
    quickSwitch: (input: { role?: 'chat' | 'computerUse'; target: 'cloud' | 'bundled' }) => Promise<{ switched: boolean; needDownload?: boolean; reason?: string; config?: { providerId: string; providerName: string; model: string; baseUrl: string; hasApiKey: boolean; configured?: boolean } }>
  }
  mediaBatch?: {
    run: (input: { tokens: string[]; kind?: 'compress' | 'transcribe'; targetMb?: number; requestId: string; workspaceTaskId?: string }) => Promise<{ success: boolean; requestId?: string; cancelled?: boolean; error?: string; kind?: string; results?: Array<{ token: string; success: boolean; outputPath?: string; error?: string }> }>
    cancel: (requestId: string) => Promise<boolean>
    onProgress: (cb: (event: { requestId?: string; done: number; total: number; name: string }) => void) => () => void
  }
  mediaTools?: {
    planEdit: (input: { instruction: string; sourcePath: string; clarificationId?: string }) => Promise<{ matched: boolean; cancelled?: boolean; clarification?: MediaEditClarification; review?: { kind: string; summary: string; candidates: unknown[] }; decision?: MediaEditDecisionV1; versionPlan?: LongVideoVersionPlanV1; error?: string }>
    planBatchEdit: (input: { instruction: string; tokens?: string[]; sourcePaths?: string[] }) => Promise<{ matched: boolean; plan?: { schemaVersion: 1; kind: 'media.batch-edit-plan'; strategy: 'independent-media-edit-batch-v1'; instruction: string; operation: string; digest: string; items: Array<{ id: string; sourcePath: string; taskType: string; decision: MediaEditDecisionV1; dependencies: string[] }> }; error?: string }>
    runBatchEdit: (input: { plan: unknown; requestId: string; workspaceTaskId?: string }) => Promise<{ success: boolean; requestId?: string; outputs?: string[]; results?: Array<{ id: string; sourceName: string; state: 'succeeded' | 'failed'; outputPath?: string; qualityScore?: number; failure?: { code: string; message: string; retryable: boolean } }>; summary?: string; error?: string }>
    planHistory: (input: { instruction: string; currentPath: string }) => Promise<{ matched: boolean; action?: { action: 'undo' | 'redo'; instruction: string }; error?: string }>
    navigateHistory: (input: { instruction: string; currentPath: string }) => Promise<{ success: boolean; matched?: boolean; action?: 'undo' | 'redo'; currentPath?: string; projectId?: string; versionId?: string; cursor?: number; versionCount?: number; canUndo?: boolean; canRedo?: boolean; summary?: string; error?: string }>
    trim: (input: { instruction: string; sourcePath: string; requestId: string; workspaceTaskId?: string; decision?: MediaEditDecisionV1 }) => Promise<{ success: boolean; matched?: boolean; requestId?: string; cancelled?: boolean; outputPath?: string; outputs?: string[]; previewPath?: string; subtitlePreviewBurnProof?: SubtitlePreviewBurnProofV1; versions?: Array<{ aspect: string; outputPath: string; durationSeconds: number; dimensions: { width: number; height: number } }>; durationSeconds?: number; expectedDurationSeconds?: number; timelineReceipt?: Array<{ operation: string; sourceRange: string; outputRange: string }>; music?: { path: string; volume: number; duck: boolean }; audioMix?: MediaEditDecisionV1['audioMix']; audioMixProof?: { schemaVersion: 1; method: string; verdict: string; tracks: Array<{ id: string; role: string; aligned: boolean }> }; audioRepair?: MediaEditDecisionV1['audioRepair']; audioRepairProof?: { schemaVersion: 1; method: string; denoise: { verdict: string }; dcRemoval: { verdict: string }; silenceRepair: { verdict: string; restoresSpeech: false } }; separationProof?: { schemaVersion: 1; method: string; verdict: string; artifactWarning: string }; rhythmReceipt?: { schemaVersion: 1; strategy: string; pace: string; bpm: number; supportRatio: number; cutTimes: number[] }; beatProof?: { schemaVersion: 1; method: string; visibleCutRatio: number; musicCorrelation: number; highlight: { densityRatio: number; denserThanOutside: boolean }; tail: { audioFaded: boolean; videoFaded: boolean } }; audioExportQc?: AudioExportQualityReceiptV1; professionalSubtitle?: { schemaVersion: 1; strategy: 'acoustic-speaker-karaoke-v1'; speakers: { speakerCount: number; confidence: number; anonymousLabels: true }; wordTiming: { method: string; model: string; wordCount: number; minimumConfidence: number }; karaoke: { mode: 'ass-kf'; tagCount: number }; keywords: { terms: string[]; emphasisCount: number }; safeArea: { strategy: 'frame-band-complexity-v1'; chosenZone: 'top' | 'bottom'; marginV: number }; cues: unknown[] }; professionalSubtitleProof?: { schemaVersion: 1; method: 'professional-subtitle-render-proof-v1'; verdict: 'matched'; speakerEvidence: { method: string; speakerCount: number; confidence: number; anonymousLabels: true }; wordTimingEvidence: { method: string; model: string; wordCount: number; minimumConfidence: number; exactCueAlignment: true }; karaokeEvidence: { mode: 'ass-kf'; tagCount: number; matchedWordCount: number }; keywordEvidence: { terms: string[]; emphasisCount: number }; safeArea: { strategy: string; chosenZone: 'top' | 'bottom'; sampledFrames: number; subtitleInChosenZone: true } }; effectReceipt?: { effectKinds: string[]; inputDurationSeconds: number; outputDurationSeconds: number; outputDimensions: { width: number; height: number }; dimensionMatch: boolean; representativeSample: { sourceSeconds: number; outputSeconds: number; meanAbsDiff: number }; changed: boolean }; trackingReceipt?: { strategy: string; subject: { description: string; observed: string }; frameCount: number; minimumConfidence: number; minimumSubjectCoverage: number; model: { providerId: string; providerName: string; model: string; local: boolean } }; semanticCut?: MediaEditDecisionV1['semanticCut']; semanticLocate?: MediaEditDecisionV1['semanticLocate']; semanticSelect?: MediaEditDecisionV1['semanticSelect']; autoInspection?: MediaEditDecisionV1['autoInspection']; projectCapsule?: { schemaVersion: 1; projectId: string; versionId: string; currentPath: string; cursor: number; versionCount: number; canUndo: boolean; canRedo: boolean }; summary?: string; error?: string }>
    runVersionBundle: (input: { sourcePath: string; plan: LongVideoVersionPlanV1; requestId: string; workspaceTaskId?: string }) => Promise<{ success: boolean; requestId?: string; cancelled?: boolean; outputs?: string[]; versions?: Array<{ id: string; label: string; outputPath: string; durationSeconds: number; targetSeconds?: number }>; summary?: string; error?: string }>
    compress: (input: { sourcePath: string; targetMb?: number; mode?: 'remux' | 'compress'; requestId: string; workspaceTaskId?: string }) => Promise<{ success: boolean; requestId?: string; cancelled?: boolean; outputPath?: string; beforeBytes?: number; afterBytes?: number; mode?: string; error?: string }>
    cancel: (requestId: string) => Promise<boolean>
  }
  personalEditSkills?: {
    plan: (input: { instruction: string }) => Promise<{ matched: boolean; command?: { schemaVersion: 1; action: 'save' | 'list' | 'update' | 'disable' | 'enable'; name?: string; settings?: PersonalEditSkillV1['settings'] } }>
    execute: (input: { instruction: string }) => Promise<{ success: boolean; matched?: boolean; action?: string; skill?: PersonalEditSkillV1; skills?: PersonalEditSkillV1[]; summary?: string; error?: string }>
    list: () => Promise<{ success: boolean; skills: PersonalEditSkillV1[]; active: PersonalEditSkillV1 | null; summary: string }>
  }
  guide?: {
    annotate: (question: string) => Promise<{ success: boolean; steps?: Array<{ text: string; mark: unknown }>; annotated?: boolean; error?: string }>
    askFrame: (input: { question: string; dataUrl?: string }) => Promise<{ success: boolean; answer?: string; error?: string }>
    dismiss: () => Promise<boolean>
  }
  computerUse?: {
    suggest: (task: string, requestId: string) => Promise<{
      requestId: string; mode: 'observe-only'; warning: string;
      observation: { frameId: string; width: number; height: number; dataUrl: string; createdAt: number };
      recommendation: { frameId: string; reason: string; action: { type: string; x?: number; y?: number; button?: string; text?: string; deltaY?: number; key?: string } }
    }>
    cancel: (requestId: string) => Promise<boolean>
    onStatus: (cb: (event: { requestId: string; status: string }) => void) => () => void
  }
  subtitle?: {
    search: (name: string) => Promise<{ success: boolean; data?: Array<{ id: string; fileId: number; fileName: string; language: string; release: string }>; error?: string }>
    download: (fileId: number) => Promise<{ success: boolean; path?: string; fileName?: string; error?: string }>
  }
  xlsx?: {
    preview: (filePath: string) => Promise<{ success: boolean; html?: string; error?: string }>
  }
  docx?: {
    preview: (filePath: string) => Promise<{ success: boolean; html?: string; error?: string }>
  }
  dialog?: {
    openFile: () => Promise<string | null>
    openFolder: () => Promise<string | null>
  }
  system?: {
    openPath: (filePath: string) => Promise<{ success: boolean; error?: string }>
    showInFolder: (filePath: string) => Promise<boolean>
    verifyPaths: (filePaths: string[]) => Promise<Array<{ path: string; exists: boolean; bytes?: number; error?: string }>>
  }
  print?: {
    file: (filePath: string) => Promise<{ success: boolean; action?: string; error?: string }>
    text: (filePath: string) => Promise<{ success: boolean; action?: string; error?: string }>
    html: (html: string) => Promise<{ success: boolean; action?: string; error?: string }>
  }
  files?: {
    scan: (dir?: string) => Promise<Array<{ name: string; path: string; ext: string; size: number }>>
    defaultDir: () => Promise<string>
    stat: (filePath: string) => Promise<{ success: boolean; size?: number; mtimeMs?: number; error?: string }>
    readText: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>
    readDataUrl: (filePath: string) => Promise<{ success: boolean; dataUrl?: string; error?: string }>
    getPathForFile: (file: File) => string
  }
  ai?: {
    chat: (messages: Array<{ role: string; content: string }>, context?: {
      name: string | null
      path: string | null
      currentTime: number
      duration: number
      volume: number
      lastAudibleVolume: number
      playbackRate: number
      pictureMode: 'original' | 'fit' | 'fill' | 'stretch'
      subtitleVisible: boolean
      isFullscreen: boolean
    }, requestId?: string, agentOptions?: { mode?: AgentMode }) => Promise<{
      requestId: string
      text: string
      cancelled?: boolean
      mode?: AgentMode
      toolResults: Array<{
        tool: string
        args: Record<string, unknown>
        result: unknown
      }>
      run?: {
        id: string
        mode: AgentMode
        status: 'running' | 'completed' | 'partial' | 'blocked' | 'failed' | 'cancelled'
        startedAt: number
        completedAt: number | null
        budget: { turns: number; maxTurns: number; toolCalls: number; maxToolCalls: number; elapsedMs: number; maxElapsedMs: number }
        steps: Array<{
          id: string
          tool: string
          label: string
          status: 'running' | 'completed' | 'failed' | 'blocked'
          detail: string
          args: Record<string, unknown>
          startedAt: number
          completedAt: number | null
          evidence: { kind: string; value: string; verified: boolean } | null
        }>
      }
    }>
    cancel: (requestId: string) => Promise<boolean>
    onStream: (cb: (event: { requestId: string; status?: string; delta?: string }) => void) => () => void
  }
}

interface MpvEvent {
  event: string
  data: { name?: string; data?: unknown }
}

interface Window {
  aiPlayer?: AiPlayerAPI
}

interface BundledModelStatus {
  state: 'stopped' | 'verifying' | 'loading' | 'ready' | 'error'
  running: boolean
  assetsPresent: boolean
  assetsLocation?: 'bundled' | 'userData' | null
  modelName: string
  modelSizeMb: number
  providerId: string
  baseUrl: string
  model: string
  idleReleaseMinutes: number
  lastNotice: string
  lastError: string
  hardware: {
    totalMemoryGb: number
    availableMemoryGb: number
    logicalCpus: number
    eligible: boolean
    tier: 'unsupported' | 'limited' | 'recommended'
    reason: string
    contextSize: number
    threads: number
    batchThreads: number
  }
}


interface LocalAiDownloadProgress {
  stage: 'download' | 'verify' | 'extract' | 'done'
  currentFile: string
  fileIndex: number
  fileCount: number
  receivedBytes: number
  totalBytes: number
}

interface ModelRoutingStatus {
  schemaVersion: number
  settings: { mode: 'observe' | 'auto'; objective: 'balanced' | 'quality' | 'speed' | 'economy'; preference: 'smart' | 'local' | 'cloud' }
  totalCalls: number
  totalQualityChecks: number
  models: Array<{
    key: string
    providerId: string
    providerName?: string
    model: string
    localOnly: boolean
    samples: number
    qualitySamples: number
    successRate: number | null
    qualityScore: number | null
    latencyMs: number | null
    cost: { status: string; estimatedUsd: number | null; referenceUsdPer1k: number | null; label: string }
  }>
  candidates: Array<{ providerId: string; providerName: string; model: string; baseUrl: string; localOnly: boolean; configured: boolean; hasApiKey: boolean }>
}

interface LocalAiComponentStatus extends BundledModelStatus {
  download: Partial<LocalAiDownloadProgress> & {
    active: boolean
    installed: boolean
    presentBytes: number
    totalBytes: number
  }
  pack: { tag: string; totalBytes: number; assetCount: number }
}
