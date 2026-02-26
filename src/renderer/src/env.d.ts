/// <reference types="vite/client" />

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
  }
}
