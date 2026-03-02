/// <reference types="vite/client" />

declare const __APP_VERSION__: string

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
      options?: { skipVideo?: boolean }
    ) => Promise<{ success: boolean; output?: string; error?: string }>
    onParseProgress: (callback: (line: string) => void) => () => void
    chatWithVideo: (
      messages: { role: string; content: string }[]
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
