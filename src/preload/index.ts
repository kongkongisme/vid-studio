import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

interface ParseOptions {
  skipVideo?: boolean
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

const api = {
  // 启动时从 Edge/Chrome 导入 B 站 cookies
  importBrowserCookies: (): Promise<CookieImportResult> =>
    ipcRenderer.invoke('import-browser-cookies'),

  // 停止正在进行的解析
  stopParse: (): Promise<void> => ipcRenderer.invoke('stop-parse'),

  // 解析视频，返回结构化 Markdown
  parseVideo: (
    url: string,
    options?: ParseOptions
  ): Promise<{ success: boolean; output?: string; error?: string }> =>
    ipcRenderer.invoke('parse-video', url, options),

  // 订阅解析进度流，返回取消函数
  onParseProgress: (callback: (line: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, line: string): void => callback(line)
    ipcRenderer.on('parse-progress', handler)
    return () => ipcRenderer.removeListener('parse-progress', handler)
  },

  // 启动流式对话（调用 DeepSeek），完成后 resolve
  chatWithVideo: (
    messages: ApiChatMessage[]
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('chat-with-video', messages),

  // 订阅流式 chunk，返回取消函数
  onChatStreamChunk: (callback: (delta: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, delta: string): void => callback(delta)
    ipcRenderer.on('chat-stream-chunk', handler)
    return () => ipcRenderer.removeListener('chat-stream-chunk', handler)
  }
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
