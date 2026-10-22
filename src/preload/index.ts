import type { AnnotationInput, ChunkAnnotation } from '../shared/annotations'
import type { HistoryItem } from '../shared/history'
import type { ChatRequest, ChatResult, ChatEvent, ChatMessage } from '../shared/chat'
import type { LibraryQuery, LibraryResult } from '../shared/library'
import type { TimelineExportPayload, TextExportFormat } from '../shared/export'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

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

const api = {
  // 启动时从 Edge/Chrome 导入 B 站 cookies
  importBrowserCookies: (): Promise<CookieImportResult> =>
    ipcRenderer.invoke('import-browser-cookies'),

  // 从 Edge/Chrome 导入 YouTube cookies
  importYoutubeCookies: (): Promise<CookieImportResult> =>
    ipcRenderer.invoke('import-youtube-cookies'),

  // 停止正在进行的解析
  stopParse: (): Promise<void> => ipcRenderer.invoke('stop-parse'),

  // 解析视频，返回结构化 Markdown
  parseVideo: (
    url: string,
    options?: ParseOptions
  ): Promise<{
    success: boolean
    output?: string
    danmaku?: DanmakuData | null
    llmReceipt?: LlmCallReceipt
    error?: string
  }> => ipcRenderer.invoke('parse-video', url, options),

  // 解析本地视频文件
  parseLocalVideo: (
    filePath: string,
    options?: ParseOptions
  ): Promise<{
    success: boolean
    output?: string
    danmaku?: DanmakuData | null
    llmReceipt?: LlmCallReceipt
    error?: string
  }> => ipcRenderer.invoke('parse-local-video', filePath, options),

  // 从 File 对象读取 Electron 可访问的真实本地路径
  getPathForFile: (file: Parameters<typeof webUtils.getPathForFile>[0]): string =>
    webUtils.getPathForFile(file),

  prepareLocalVideoPlayback: (
    filePath: string,
    forceProxy = false
  ): Promise<{
    success: boolean
    url?: string
    needsProxy?: boolean
    message?: string
    error?: string
  }> => ipcRenderer.invoke('prepare-local-video-playback', filePath, forceProxy),

  onLocalPlaybackProgress: (callback: (progress: LocalPlaybackProgress) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, progress: LocalPlaybackProgress): void =>
      callback(progress)
    ipcRenderer.on('local-playback-progress', handler)
    return () => ipcRenderer.removeListener('local-playback-progress', handler)
  },

  // 订阅解析进度流，返回取消函数
  onParseProgress: (callback: (line: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, line: string): void => callback(line)
    ipcRenderer.on('parse-progress', handler)
    return () => ipcRenderer.removeListener('parse-progress', handler)
  },

  chatWithVideo: (request: ChatRequest): Promise<ChatResult> =>
    ipcRenderer.invoke('chat-with-video', request),
  stopChat: (requestId: string): Promise<void> => ipcRenderer.invoke('stop-chat', requestId),
  onChatEvent: (callback: (event: ChatEvent) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, event: ChatEvent): void => callback(event)
    ipcRenderer.on('chat-event', handler)
    return () => ipcRenderer.removeListener('chat-event', handler)
  },
  getConversation: (sourceKey: string): Promise<ChatMessage[]> =>
    ipcRenderer.invoke('get-conversation', sourceKey),
  saveConversation: (sourceKey: string, messages: ChatMessage[]): Promise<void> =>
    ipcRenderer.invoke('save-conversation', sourceKey, messages),
  exportConversation: (
    sourceKey: string,
    title: string,
    messages: ChatMessage[]
  ): Promise<{ success: boolean; path?: string; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('export-conversation', sourceKey, title, messages),

  getAnnotations: (sourceKey: string): Promise<ChunkAnnotation[]> =>
    ipcRenderer.invoke('get-annotations', sourceKey),
  saveAnnotation: (input: AnnotationInput): Promise<ChunkAnnotation> =>
    ipcRenderer.invoke('save-annotation', input),

  // 历史管理
  getHistory: (): Promise<HistoryItem[]> => ipcRenderer.invoke('get-history'),
  searchLibrary: (query: LibraryQuery): Promise<LibraryResult> =>
    ipcRenderer.invoke('search-library', query),
  renameHistory: (id: string, title: string): Promise<void> =>
    ipcRenderer.invoke('rename-history', id, title),

  addHistory: (item: Omit<HistoryItem, 'id' | 'createdAt'>): Promise<void> =>
    ipcRenderer.invoke('add-history', item),

  toggleFavorite: (id: string): Promise<void> => ipcRenderer.invoke('toggle-favorite', id),

  deleteHistory: (id: string): Promise<void> => ipcRenderer.invoke('delete-history', id),

  readFile: (path: string): Promise<string | null> => ipcRenderer.invoke('read-file', path),

  exportTimelineDocument: (
    payload: TimelineExportPayload
  ): Promise<{
    success: boolean
    path?: string
    title?: string
    llmReceipt?: LlmCallReceipt
    canceled?: boolean
    error?: string
  }> => ipcRenderer.invoke('export-timeline-document', payload),

  exportTimelineText: (
    payload: TimelineExportPayload,
    format: TextExportFormat
  ): Promise<{
    success: boolean
    path?: string
    canceled?: boolean
    error?: string
  }> => ipcRenderer.invoke('export-timeline-text', payload, format),

  // 解析内容缓存
  getCache: (url: string): Promise<string | null> => ipcRenderer.invoke('get-cache', url),
  setCache: (url: string, content: string): Promise<void> =>
    ipcRenderer.invoke('set-cache', url, content),
  deleteCache: (url: string): Promise<void> => ipcRenderer.invoke('delete-cache', url),
  getCachedUrls: (): Promise<string[]> => ipcRenderer.invoke('get-cached-urls')
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
