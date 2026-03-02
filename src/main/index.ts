import { app, shell, BrowserWindow, ipcMain, session } from 'electron'
import { getHistory, addHistory, toggleFavorite, deleteHistory } from './history'
import { getCachedContent, setCachedContent, deleteCachedContent, getCachedUrls } from './cache'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { spawn, execSync, type ChildProcess } from 'child_process'
import { readFile } from 'fs/promises'
import { tmpdir } from 'os'
import icon from '../../resources/icon.png?asset'

const pythonBin = process.platform === 'win32' ? 'python' : 'python3'

const vidEnginePath = is.dev
  ? join(process.cwd(), 'vid-engine')
  : join(process.resourcesPath, 'vid-engine')

// ─── 代理检测：将系统代理注入 Python 子进程 ────────────────
// Electron webview 会自动走系统代理，但 spawn 出的子进程不会，需手动传入。

function detectSystemProxy(): string | null {
  // 1. 优先沿用已有的代理环境变量
  for (const key of ['https_proxy', 'http_proxy', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY']) {
    if (process.env[key]) return process.env[key]!
  }
  // 2. macOS：从 System Preferences 读取
  if (process.platform === 'darwin') {
    try {
      const out = execSync('scutil --proxy', { timeout: 3000 }).toString()
      // 优先 HTTPS 代理
      if (/HTTPSEnable\s*:\s*1/.test(out)) {
        const host = out.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1]
        const port = out.match(/HTTPSPort\s*:\s*(\d+)/)?.[1]
        if (host && port) return `http://${host}:${port}`
      }
      // 其次 HTTP 代理
      if (/HTTPEnable\s*:\s*1/.test(out)) {
        const host = out.match(/HTTPProxy\s*:\s*(\S+)/)?.[1]
        const port = out.match(/HTTPPort\s*:\s*(\d+)/)?.[1]
        if (host && port) return `http://${host}:${port}`
      }
    } catch { /* 无代理或命令不可用，静默忽略 */ }
  }
  return null
}

// 启动时检测一次，避免每次 spawn 重复调用
const PROXY_URL = detectSystemProxy()

function buildSpawnEnv(): NodeJS.ProcessEnv {
  if (!PROXY_URL) return process.env
  return {
    ...process.env,
    http_proxy: PROXY_URL,
    https_proxy: PROXY_URL,
    HTTP_PROXY: PROXY_URL,
    HTTPS_PROXY: PROXY_URL,
  }
}

// ─── 工具：读取 .env key / 运行 Python 脚本 ──────────────

async function readEnvKey(key: string): Promise<string> {
  try {
    const content = await readFile(join(vidEnginePath, '.env'), 'utf-8')
    const match = content.match(new RegExp(`^${key}=(.+)$`, 'm'))
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : ''
  } catch {
    return ''
  }
}

// ─── 工具：运行 Python 脚本并收集 stdout ──────────────────
function runPython(scriptName: string, args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    const proc = spawn(pythonBin, [scriptName, ...args], { cwd: vidEnginePath, env: buildSpawnEnv() })
    proc.stdout.on('data', (d: Buffer) => (out += d.toString()))
    proc.on('close', () => resolve(out))
    proc.on('error', reject)
  })
}

// ─── 窗口创建 ────────────────────────────────────────────
function createWindow(): void {
  const mainWindow = new BrowserWindow({
    title: 'VidStudio - 视析工作站',
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webviewTag: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ─── IPC：从浏览器导入 B 站 cookies ──────────────────────
ipcMain.handle('import-browser-cookies', async () => {
  try {
    const raw = await runPython('extract_cookies.py')
    const result = JSON.parse(raw.trim()) as {
      success: boolean
      browser?: string
      count?: number
      cookies?: Electron.CookiesSetDetails[]
      error?: string
    }

    if (!result.success || !result.cookies?.length) {
      return { success: false, error: result.error }
    }

    // 注入到 webview 使用的持久化 session
    const biliSession = session.fromPartition('persist:bilibili')
    let imported = 0
    for (const cookie of result.cookies) {
      try {
        await biliSession.cookies.set(cookie)
        imported++
      } catch {
        // 跳过格式异常的 cookie
      }
    }

    return { success: true, browser: result.browser, count: imported }
  } catch (e) {
    return { success: false, error: String(e) }
  }
})

// ─── IPC：从浏览器导入 YouTube cookies ───────────────────
ipcMain.handle('import-youtube-cookies', async () => {
  try {
    const raw = await runPython('extract_cookies.py', ['--site', 'youtube'])
    const result = JSON.parse(raw.trim()) as {
      success: boolean
      browser?: string
      count?: number
      cookies?: Electron.CookiesSetDetails[]
      error?: string
    }

    if (!result.success || !result.cookies?.length) {
      return { success: false, error: result.error }
    }

    const ytSession = session.fromPartition('persist:youtube')
    let imported = 0
    for (const cookie of result.cookies) {
      try {
        await ytSession.cookies.set(cookie)
        imported++
      } catch {
        // 跳过格式异常的 cookie
      }
    }

    return { success: true, browser: result.browser, count: imported }
  } catch (e) {
    return { success: false, error: String(e) }
  }
})

// ─── IPC：解析视频 ────────────────────────────────────────
interface ParseOptions {
  skipVideo?: boolean
}

// 记录当前解析进程，用于停止
let currentParseProc: ChildProcess | null = null

ipcMain.handle('parse-video', async (event, url: string, options: ParseOptions = {}) => {
  const outputPath = join(tmpdir(), `vid-studio-${Date.now()}.txt`)
  const args = ['main.py', url, '-o', outputPath]
  if (options.skipVideo !== false) args.push('--skip-video')

  return new Promise<{ success: boolean; output?: string; error?: string }>((resolve) => {
    const proc = spawn(pythonBin, args, { cwd: vidEnginePath, env: buildSpawnEnv() })
    currentParseProc = proc

    proc.stdout.on('data', (d: Buffer) => event.sender.send('parse-progress', d.toString()))
    proc.stderr.on('data', (d: Buffer) => event.sender.send('parse-progress', d.toString()))

    proc.on('close', async (code, signal) => {
      currentParseProc = null
      // 用户主动停止
      if (signal) {
        resolve({ success: false, error: '已停止解析' })
        return
      }
      if (code === 0) {
        try {
          resolve({ success: true, output: await readFile(outputPath, 'utf-8') })
        } catch {
          resolve({ success: false, error: '读取输出文件失败' })
        }
      } else {
        resolve({ success: false, error: `解析进程异常退出（code: ${code}）` })
      }
    })

    proc.on('error', (err: NodeJS.ErrnoException) => {
      currentParseProc = null
      resolve({
        success: false,
        error: err.code === 'ENOENT' ? '未找到 Python 环境，请确认已安装 python3' : err.message
      })
    })
  })
})

// ─── IPC：停止解析 ────────────────────────────────────────
ipcMain.handle('stop-parse', () => {
  if (currentParseProc) {
    currentParseProc.kill()
    currentParseProc = null
  }
})

// ─── IPC：LLM 对话（流式） ────────────────────────────────

interface ApiChatMessage {
  role: string
  content: string
}

ipcMain.handle('chat-with-video', async (event, messages: ApiChatMessage[]) => {
  const apiKey = await readEnvKey('DEEPSEEK_API_KEY')
  if (!apiKey) {
    return { success: false, error: '未配置 DEEPSEEK_API_KEY，请在 vid-engine/.env 中设置' }
  }

  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages,
        temperature: 0.7,
        max_tokens: 2000,
        stream: true
      })
    })

    if (!response.ok) {
      return { success: false, error: `API 错误: ${response.status} ${await response.text()}` }
    }

    const reader = response.body?.getReader()
    if (!reader) return { success: false, error: '无法读取响应流' }

    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') continue
        try {
          const parsed = JSON.parse(data) as {
            choices: { delta: { content?: string }; finish_reason: string | null }[]
          }
          const delta = parsed.choices[0]?.delta?.content
          if (delta) event.sender.send('chat-stream-chunk', delta)
        } catch {
          // 跳过解析失败的行
        }
      }
    }

    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
})

// ─── IPC：历史管理 ────────────────────────────────────────

ipcMain.handle('get-history', async () => {
  try {
    return await getHistory()
  } catch {
    return []
  }
})

ipcMain.handle('add-history', async (_, item) => {
  try {
    console.log('[main] add-history 收到请求:', item)
    await addHistory(item)
  } catch (e) {
    console.error('[main] add-history 失败:', e)
    throw e
  }
})

ipcMain.handle('toggle-favorite', async (_, id) => {
  try {
    await toggleFavorite(id)
  } catch {
    // 静默失败
  }
})

ipcMain.handle('delete-history', async (_, id) => {
  try {
    await deleteHistory(id)
  } catch {
    // 静默失败
  }
})

ipcMain.handle('read-file', async (_, filePath: string) => {
  try {
    return await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
})

// ─── IPC：解析内容缓存 ────────────────────────────────────────

ipcMain.handle('get-cache', (_, url: string) => {
  try {
    return getCachedContent(url)
  } catch {
    return null
  }
})

ipcMain.handle('set-cache', (_, url: string, content: string) => {
  try {
    setCachedContent(url, content)
  } catch (e) {
    console.error('[main] set-cache 失败:', e)
  }
})

ipcMain.handle('delete-cache', (_, url: string) => {
  try {
    deleteCachedContent(url)
  } catch {
    // 静默失败
  }
})

ipcMain.handle('get-cached-urls', () => {
  try {
    return getCachedUrls()
  } catch {
    return []
  }
})

// ─── 应用生命周期 ────────────────────────────────────────
app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.vidstudio')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
