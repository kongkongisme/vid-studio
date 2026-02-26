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

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      importBrowserCookies: () => Promise<CookieImportResult>
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
    }
  }
}
