import { ElectronAPI } from '@electron-toolkit/preload'

interface ParseOptions {
  skipVideo?: boolean
}

interface CookieImportResult {
  success: boolean
  browser?: string
  count?: number
  error?: string
}

interface ApiChatMessage {
  role: string
  content: string
}

interface HistoryItem {
  id: string
  url: string
  title: string
  platform: 'bilibili' | 'youtube'
  thumbnail?: string
  mode: 'asr' | 'visual'
  createdAt: number
  favorited: boolean
  outputPath?: string
  duration?: number
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      importBrowserCookies: () => Promise<CookieImportResult>
      importYoutubeCookies: () => Promise<CookieImportResult>
      parseVideo: (
        url: string,
        options?: ParseOptions
      ) => Promise<{ success: boolean; output?: string; error?: string }>
      stopParse: () => Promise<void>
      onParseProgress: (callback: (line: string) => void) => () => void
      chatWithVideo: (
        messages: ApiChatMessage[]
      ) => Promise<{ success: boolean; error?: string }>
      onChatStreamChunk: (callback: (delta: string) => void) => () => void
      // 历史管理
      getHistory: () => Promise<HistoryItem[]>
      addHistory: (item: Omit<HistoryItem, 'id' | 'createdAt'>) => Promise<void>
      toggleFavorite: (id: string) => Promise<void>
      deleteHistory: (id: string) => Promise<void>
      readFile: (path: string) => Promise<string | null>
      // 缓存管理
      setCache: (url: string, output: string) => Promise<void>
      getCache: (url: string) => Promise<string | null>
      deleteCache: (url: string) => Promise<void>
      getCachedUrls: () => Promise<string[]>
    }
  }
}

export {}
