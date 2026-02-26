/// <reference types="vite/client" />

declare const __APP_VERSION__: string

interface Window {
  api: {
    stopParse: () => Promise<void>
    importBrowserCookies: () => Promise<{
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
  }
}
