/// <reference types="vite/client" />

declare const __APP_VERSION__: string

type LlmProvider = 'deepseek' | 'gpt-5.6-sol'

interface LlmCallReceipt {
  purpose: string
  provider: LlmProvider
  requestedModel: string
  responseModel?: string
  endpoint: string
  requestId?: string
  timestamp: string
  durationMs: number
  reasoningEffort?: string
  status: 'success' | 'fallback'
  error?: string
}

interface DanmakuData {
  platform: string
  total_count: number
  word_freq: [string, number][]
  density_bins: [number, number, number][]
  chunk_top: Record<string, string[]>
}

interface HistoryItem {
  id: string
  url: string
  title: string
  platform: 'bilibili' | 'youtube' | 'local'
  thumbnail?: string
  mode: 'asr' | 'visual'
  createdAt: number
  favorited: boolean
  outputPath?: string
  duration?: number
  filePath?: string
}

interface LocalPlaybackProgress {
  filePath: string
  status: 'converting' | 'ready' | 'error'
  progress: number
  message: string
}

interface TimelineExportChunk {
  startTime: string
  endTime: string
  title: string
  summary: string
  keyPoints: string[]
  tags: string[]
  transcript: { time: string; text: string }[]
}

interface TimelineExportPayload {
  title: string
  sourceLabel: string
  modeLabel: string
  exportedAt: string
  highlightTerm?: string
  includeTranscript: boolean
  llmProvider: LlmProvider
  llmReceipt?: LlmCallReceipt
  chunks: TimelineExportChunk[]
}

interface Window {
  api: {
    stopParse: () => Promise<void>
    importBrowserCookies: () => Promise<{
      success: boolean
      browser?: string
      count?: number
      error?: string
    }>
    importYoutubeCookies: () => Promise<{
      success: boolean
      browser?: string
      count?: number
      error?: string
    }>
    parseVideo: (
      url: string,
      options?: { skipVideo?: boolean; skipDanmaku?: boolean; llmProvider?: LlmProvider }
    ) => Promise<{
      success: boolean
      output?: string
      danmaku?: DanmakuData | null
      llmReceipt?: LlmCallReceipt
      error?: string
    }>
    parseLocalVideo?: (
      filePath: string,
      options?: { skipVideo?: boolean; skipDanmaku?: boolean; llmProvider?: LlmProvider }
    ) => Promise<{
      success: boolean
      output?: string
      danmaku?: DanmakuData | null
      llmReceipt?: LlmCallReceipt
      error?: string
    }>
    getPathForFile?: (file: File) => string
    prepareLocalVideoPlayback?: (
      filePath: string,
      forceProxy?: boolean
    ) => Promise<{
      success: boolean
      url?: string
      needsProxy?: boolean
      message?: string
      error?: string
    }>
    onLocalPlaybackProgress?: (callback: (progress: LocalPlaybackProgress) => void) => () => void
    onParseProgress: (callback: (line: string) => void) => () => void
    chatWithVideo: (
      messages: { role: string; content: string }[],
      provider: LlmProvider
    ) => Promise<{ success: boolean; llmReceipt?: LlmCallReceipt; error?: string }>
    onChatStreamChunk: (callback: (delta: string) => void) => () => void
    onChatSearchQuery: (callback: (query: string) => void) => () => void
    // 历史管理
    getHistory: () => Promise<HistoryItem[]>
    addHistory: (item: Omit<HistoryItem, 'id' | 'createdAt'>) => Promise<void>
    toggleFavorite: (id: string) => Promise<void>
    deleteHistory: (id: string) => Promise<void>
    readFile: (path: string) => Promise<string | null>
    exportTimelineDocument?: (payload: TimelineExportPayload) => Promise<{
      success: boolean
      path?: string
      title?: string
      llmReceipt?: LlmCallReceipt
      canceled?: boolean
      error?: string
    }>
    // 缓存管理
    setCache: (url: string, output: string) => Promise<void>
    getCache: (url: string) => Promise<string | null>
    deleteCache: (url: string) => Promise<void>
    getCachedUrls: () => Promise<string[]>
  }
}
