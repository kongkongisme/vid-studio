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

interface ApiChatMessage {
  role: string
  content: string
}

interface CookieImportResult {
  success: boolean
  browser?: string
  count?: number
  error?: string
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

  // 启动流式对话（调用当前选择的模型），完成后 resolve
  chatWithVideo: (
    messages: ApiChatMessage[],
    provider: LlmProvider
  ): Promise<{ success: boolean; llmReceipt?: LlmCallReceipt; error?: string }> =>
    ipcRenderer.invoke('chat-with-video', messages, provider),

  // 订阅流式 chunk，返回取消函数
  onChatStreamChunk: (callback: (delta: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, delta: string): void => callback(delta)
    ipcRenderer.on('chat-stream-chunk', handler)
    return () => ipcRenderer.removeListener('chat-stream-chunk', handler)
  },

  // 订阅搜索关键词事件（LLM 调用 Tavily 时触发），返回取消函数
  onChatSearchQuery: (callback: (query: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, query: string): void => callback(query)
    ipcRenderer.on('chat-search-query', handler)
    return () => ipcRenderer.removeListener('chat-search-query', handler)
  },

  // 历史管理
  getHistory: (): Promise<HistoryItem[]> => ipcRenderer.invoke('get-history'),

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
