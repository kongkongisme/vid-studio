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

// 弹幕数据结构
interface DanmakuData {
  platform: string
  total_count: number
  word_freq: [string, number][]
  density_bins: [number, number, number][]
  chunk_top: Record<string, string[]>
}

// 记录当前解析进程，用于停止
let currentParseProc: ChildProcess | null = null

ipcMain.handle('parse-video', async (event, url: string, options: ParseOptions = {}) => {
  const outputPath = join(tmpdir(), `vid-studio-${Date.now()}.txt`)
  const args = ['main.py', url, '-o', outputPath]
  if (options.skipVideo !== false) args.push('--skip-video')

  return new Promise<{ success: boolean; output?: string; danmaku?: DanmakuData | null; error?: string }>((resolve) => {
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
          const output = await readFile(outputPath, 'utf-8')
          let danmaku: DanmakuData | null = null
          try {
            const raw = await readFile(`${outputPath}.danmaku.json`, 'utf-8')
            danmaku = JSON.parse(raw) as DanmakuData
          } catch {
            // 弹幕数据可选，获取失败静默忽略
          }
          resolve({ success: true, output, danmaku })
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

// ─── IPC：LLM 对话（流式，支持 Tavily 互联网搜索工具） ────

interface ApiChatMessage {
  role: string
  content: string
}

// 内部消息类型，支持 tool_calls / tool role
interface InternalMessage {
  role: string
  content: string | null
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

ipcMain.handle('chat-with-video', async (event, messages: ApiChatMessage[]) => {
  const apiKey = await readEnvKey('DEEPSEEK_API_KEY')
  if (!apiKey) {
    return { success: false, error: '未配置 DEEPSEEK_API_KEY，请在 vid-engine/.env 中设置' }
  }

  const tavilyKey = await readEnvKey('TAVILY_API_KEY')

  // 工具定义（仅在配置了 Tavily API Key 时启用）
  const tools = tavilyKey
    ? [
        {
          type: 'function',
          function: {
            name: 'web_search',
            description:
              '搜索互联网获取实时信息。仅当以下情况才调用：(1) 需要视频发布后的最新动态；(2) 需要具体数字/日期/事实且无法从视频内容或已有知识确认；(3) 用户明确要求搜索。若视频内容或模型已有知识已足够回答，不得调用此工具。',
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string', description: '搜索关键词' }
              },
              required: ['query']
            }
          }
        }
      ]
    : null

  // 流式调用 DeepSeek，同时检测工具调用
  const streamLLM = async (
    msgs: InternalMessage[],
    noTools = false
  ): Promise<{ content: string; toolCall?: { id: string; name: string; args: string } }> => {
    const body: Record<string, unknown> = {
      model: 'deepseek-chat',
      messages: msgs,
      temperature: 0.7,
      max_tokens: 2000,
      stream: true
    }
    if (tools && !noTools) {
      body.tools = tools
      body.tool_choice = 'auto'
    }

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    })

    if (!response.ok) {
      throw new Error(`API 错误: ${response.status} ${await response.text()}`)
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error('无法读取响应流')

    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    let toolCallId = ''
    let toolCallName = ''
    let toolCallArgs = ''
    let finishReason = ''

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
            choices: {
              delta: {
                content?: string
                tool_calls?: {
                  index: number
                  id?: string
                  function?: { name?: string; arguments?: string }
                }[]
              }
              finish_reason: string | null
            }[]
          }
          const choice = parsed.choices[0]
          if (!choice) continue
          if (choice.finish_reason) finishReason = choice.finish_reason
          const delta = choice.delta
          if (delta.content) {
            content += delta.content
            event.sender.send('chat-stream-chunk', delta.content)
          }
          const tc = delta.tool_calls?.[0]
          if (tc) {
            if (tc.id) toolCallId = tc.id
            if (tc.function?.name) toolCallName += tc.function.name
            if (tc.function?.arguments) toolCallArgs += tc.function.arguments
          }
        } catch {
          // 跳过解析失败的行
        }
      }
    }

    if (finishReason === 'tool_calls' && toolCallName) {
      return { content, toolCall: { id: toolCallId, name: toolCallName, args: toolCallArgs } }
    }
    return { content }
  }

  try {
    const internalMessages: InternalMessage[] = messages.map((m) => ({
      role: m.role,
      content: m.content
    }))

    // 第一轮：LLM 响应（配置了 Tavily 时携带工具定义）
    const phase1 = await streamLLM(internalMessages)

    if (!phase1.toolCall) {
      // 无工具调用，直接结束
      return { success: true }
    }

    // 处理 web_search 工具调用
    const { id, name, args } = phase1.toolCall
    if (name === 'web_search' && tavilyKey) {
      let searchResult = '搜索未返回有效结果'
      try {
        const parsedArgs = JSON.parse(args) as { query: string }
        const query = parsedArgs.query

        // 通知渲染层搜索关键词（独立事件，不污染消息正文）
        event.sender.send('chat-search-query', query)

        const tavilyResp = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: tavilyKey,
            query,
            search_depth: 'basic',
            max_results: 5,
            include_answer: true
          })
        })

        if (tavilyResp.ok) {
          const tavilyData = (await tavilyResp.json()) as {
            answer?: string
            results?: { title: string; url: string; content: string }[]
          }
          const parts: string[] = []
          if (tavilyData.answer) parts.push(`摘要：${tavilyData.answer}`)
          if (tavilyData.results?.length) {
            parts.push(
              tavilyData.results
                .map((r) => `标题：${r.title}\n链接：${r.url}\n内容：${r.content}`)
                .join('\n---\n')
            )
          }
          searchResult = parts.join('\n\n') || searchResult
        } else {
          searchResult = `搜索请求失败（HTTP ${tavilyResp.status}）`
        }
      } catch (e) {
        searchResult = `搜索出错：${String(e)}`
      }

      // 组装含工具结果的消息，发起第二轮对话
      const msgsWithTool: InternalMessage[] = [
        ...internalMessages,
        {
          role: 'assistant',
          content: phase1.content || null,
          tool_calls: [{ id, type: 'function', function: { name, arguments: args } }]
        },
        { role: 'tool', content: searchResult, tool_call_id: id }
      ]

      // noTools=true，避免第二轮再次触发搜索
      await streamLLM(msgsWithTool, true)
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
  } catch (e) {
    console.error('[main] get-cache 失败:', e)
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
  } catch (e) {
    console.error('[main] delete-cache 失败:', e)
  }
})

ipcMain.handle('get-cached-urls', () => {
  try {
    return getCachedUrls()
  } catch (e) {
    console.error('[main] get-cached-urls 失败:', e)
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
