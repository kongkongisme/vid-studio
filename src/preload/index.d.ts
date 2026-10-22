import type { AnnotationInput, ChunkAnnotation } from '../shared/annotations'
import type { HistoryItem } from '../shared/history'
import type { SettingsSnapshot, SettingsUpdate, DiagnosticReport } from '../shared/settings'
import type { ChatRequest, ChatResult, ChatEvent, ChatMessage } from '../shared/chat'
import type { LibraryQuery, LibraryResult } from '../shared/library'
import type { TimelineExportPayload, TextExportFormat } from '../shared/export'
import type { ReadingPosition, ReadingPositionInput } from '../shared/reading-position'
import { ElectronAPI } from '@electron-toolkit/preload'

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

interface ParseOptions {
  skipVideo?: boolean
  skipDanmaku?: boolean
  llmProvider?: LlmProvider
}

interface DanmakuData {
  platform: string
  total_count: number
  word_freq: [string, number][]
  density_bins: [number, number, number][]
  chunk_top: Record<string, string[]>
}

interface CookieImportResult {
  success: boolean
  browser?: string
  count?: number
  error?: string
}

interface LocalPlaybackProgress {
  filePath: string
  status: 'converting' | 'ready' | 'error'
  progress: number
  message: string
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      getReadingPosition: (key: string) => Promise<ReadingPosition | null>
      saveReadingPosition: (input: ReadingPositionInput) => Promise<ReadingPosition>
      getSettings: () => Promise<SettingsSnapshot>
      saveSettings: (update: SettingsUpdate) => Promise<SettingsSnapshot>
      choosePython: () => Promise<string | null>
      diagnoseEnvironment: () => Promise<DiagnosticReport>
      openDataDirectory: () => Promise<string>
      importBrowserCookies: () => Promise<CookieImportResult>
      importYoutubeCookies: () => Promise<CookieImportResult>
      parseVideo: (
        url: string,
        options?: ParseOptions
      ) => Promise<{
        success: boolean
        output?: string
        danmaku?: DanmakuData | null
        llmReceipt?: LlmCallReceipt
        error?: string
      }>
      parseLocalVideo?: (
        filePath: string,
        options?: ParseOptions
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
      stopParse: () => Promise<void>
      onParseProgress: (callback: (line: string) => void) => () => void
      chatWithVideo: (request: ChatRequest) => Promise<ChatResult>
      stopChat: (requestId: string) => Promise<void>
      onChatEvent: (callback: (event: ChatEvent) => void) => () => void
      getConversation: (sourceKey: string) => Promise<ChatMessage[]>
      saveConversation: (sourceKey: string, messages: ChatMessage[]) => Promise<void>
      exportConversation: (
        sourceKey: string,
        title: string,
        messages: ChatMessage[]
      ) => Promise<{ success: boolean; path?: string; canceled?: boolean; error?: string }>
      getAnnotations: (sourceKey: string) => Promise<ChunkAnnotation[]>
      saveAnnotation: (input: AnnotationInput) => Promise<ChunkAnnotation>
      // 历史管理
      getHistory: () => Promise<HistoryItem[]>
      searchLibrary: (query: LibraryQuery) => Promise<LibraryResult>
      renameHistory: (id: string, title: string) => Promise<void>
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
      exportTimelineText: (
        payload: TimelineExportPayload,
        format: TextExportFormat
      ) => Promise<{
        success: boolean
        path?: string
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
}

export {}
