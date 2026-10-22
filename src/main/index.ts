import { app, shell, BrowserWindow, ipcMain, session, dialog, safeStorage } from 'electron'
import { getHistory, addHistory, toggleFavorite, deleteHistory, renameHistory } from './history'
import {
  getCachedContent,
  setCachedContent,
  deleteCachedContent,
  getCachedUrls,
  getAnnotationStore,
  getLibraryIndex,
  getChatStore,
  getReadingStore
} from './cache'
import type { LibraryQuery } from '../shared/library'
import {
  validateChatRequest,
  validateConversation,
  MAX_CHAT_CHARACTERS,
  conversationMarkdown,
  type ChatRequest,
  type ChatMessage,
  type ChatResult
} from '../shared/chat'
import { ChatRequests } from './chat-requests'
import { readChatStream, type StreamToolCall } from './chat-stream'
import { buildTimelineExportHtml, type TimelineExportPayload } from './timeline-export'
import { exportTimelinePdf } from './pdf-export'
import { buildTextExport, EXPORT_FORMATS, safeExportFilename } from '../shared/timeline-formats'
import type { TextExportFormat } from '../shared/export'
import { extname, join, resolve } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { execSync, type ChildProcess } from 'child_process'
import { ManagedProcesses } from './managed-processes'
import { PlaybackRequests, type PlaybackRequest } from './playback-requests'
import { writeStagedOutput } from './staged-output'
import { existsSync, mkdirSync, statSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { StringDecoder } from 'string_decoder'
import { pathToFileURL } from 'url'
import icon from '../../resources/icon.png?asset'
import { SettingsStore } from './settings-store'
import { PythonRuntime, pythonCandidates, PYTHON_MODULES } from './python-runtime'
import { buildDiagnosticReport, engineAvailable, probeMediaTool } from './diagnostics'
import type { SettingsUpdate } from '../shared/settings'
import type { ReadingPositionInput } from '../shared/reading-position'

if (process.env.VID_STUDIO_DATA_DIR) {
  const dataDirectory = resolve(process.env.VID_STUDIO_DATA_DIR)
  mkdirSync(dataDirectory, { recursive: true })
  app.setPath('userData', dataDirectory)
}

const vidEnginePath = is.dev
  ? join(process.cwd(), 'vid-engine')
  : join(process.resourcesPath, 'vid-engine')

const backgroundProcesses = new ManagedProcesses()
const playbackRequests = new PlaybackRequests(backgroundProcesses)

let settingsStore: SettingsStore | null = null
function getSettingsStore(): SettingsStore {
  settingsStore ??= new SettingsStore(
    join(app.getPath('userData'), 'settings.json'),
    process.env.VID_STUDIO_ENV_FILE || join(vidEnginePath, '.env'),
    {
      available: () =>
        safeStorage.isEncryptionAvailable() &&
        (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(value)
    }
  )
  return settingsStore
}

const pythonRuntime = new PythonRuntime(async () => {
  const settings = await getSettingsStore().snapshot()
  return pythonCandidates(vidEnginePath, settings.preferences.pythonPath)
})

async function requirePython(modules = PYTHON_MODULES): Promise<string> {
  const probe = await pythonRuntime.resolve()
  if (!probe.supported)
    throw new Error('需要 Python 3.10 或更新版本。请打开「设置与诊断」检查环境。')
  const missing = modules.filter(
    (name) => !probe.modules.some((module) => module.name === name && module.available)
  )
  if (missing.length)
    throw new Error(`Python 缺少或无法加载依赖：${missing.join('、')}。请打开「设置与诊断」修复。`)
  return probe.command
}

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
    } catch {
      /* 无代理或命令不可用，静默忽略 */
    }
  }
  return null
}

// 启动时检测一次，避免每次 spawn 重复调用
const PROXY_URL = detectSystemProxy()

async function buildSpawnEnv(): Promise<NodeJS.ProcessEnv> {
  const configured = await getSettingsStore().values()
  const env = {
    ...process.env,
    ...configured,
    VID_CACHE_DIR: configured.VID_CACHE_DIR || join(app.getPath('userData'), 'engine-cache'),
    PYTHONUNBUFFERED: '1'
  }
  if (!PROXY_URL) return env
  return {
    ...env,
    http_proxy: PROXY_URL,
    https_proxy: PROXY_URL,
    HTTP_PROXY: PROXY_URL,
    HTTPS_PROXY: PROXY_URL
  }
}

// ─── 工具：读取 .env key / 运行 Python 脚本 ──────────────

async function readEnvKey(key: string): Promise<string> {
  return (await getSettingsStore().values())[key] ?? ''
}

type LlmProvider = 'deepseek' | 'gpt-5.6-sol'

interface LlmConnection {
  provider: LlmProvider
  label: string
  apiKey: string
  baseUrl: string
  model: string
  reasoningEffort?: string
}

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

function normalizeLlmProvider(provider?: string): LlmProvider {
  return provider === 'gpt-5.6-sol' ? 'gpt-5.6-sol' : 'deepseek'
}

function getChatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '')
  return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`
}

async function resolveLlmConnection(provider?: string): Promise<LlmConnection> {
  const normalized = normalizeLlmProvider(provider)
  const configuration = await getSettingsStore().values()
  if (normalized === 'gpt-5.6-sol') {
    const [apiKey, baseUrl, model, reasoningEffort] = [
      'GPT_API_KEY',
      'GPT_BASE_URL',
      'GPT_MODEL',
      'GPT_REASONING_EFFORT'
    ].map((key) => configuration[key] ?? '')
    if (!apiKey) {
      throw new Error('未配置兼容接口的 API Key，请打开「设置与诊断」填写')
    }
    return {
      provider: normalized,
      label: '自定义接口',
      apiKey,
      baseUrl: baseUrl || 'https://api.openai.com/v1',
      model: model || 'gpt-5.6-sol',
      reasoningEffort: reasoningEffort === 'omit' ? undefined : reasoningEffort || 'high'
    }
  }

  const [apiKey, baseUrl, model] = ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL'].map(
    (key) => configuration[key] ?? ''
  )
  if (!apiKey) {
    throw new Error('未配置 DeepSeek API Key，请打开「设置与诊断」填写')
  }
  return {
    provider: normalized,
    label: 'DeepSeek',
    apiKey,
    baseUrl: baseUrl || 'https://api.deepseek.com',
    model: model || 'deepseek-chat'
  }
}

function applyModelTuning(
  body: Record<string, unknown>,
  connection: LlmConnection,
  temperature: number
): void {
  if (connection.reasoningEffort) {
    body.reasoning_effort = connection.reasoningEffort
  } else {
    body.temperature = temperature
  }
}

function getResponseRequestId(headers: Headers): string | undefined {
  return (
    headers.get('x-request-id') ||
    headers.get('openai-request-id') ||
    headers.get('request-id') ||
    undefined
  )
}

function createLlmCallReceipt(
  connection: LlmConnection,
  purpose: string,
  startedAt: number,
  options: {
    responseModel?: string
    requestId?: string
    status?: 'success' | 'fallback'
    error?: string
  } = {}
): LlmCallReceipt {
  return {
    purpose,
    provider: connection.provider,
    requestedModel: connection.model,
    responseModel: options.responseModel,
    endpoint: getChatCompletionsUrl(connection.baseUrl),
    requestId: options.requestId,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    reasoningEffort: connection.reasoningEffort,
    status: options.status ?? 'success',
    error: options.error
  }
}

// ─── 工具：运行 Python 脚本并收集 stdout ──────────────────
async function runPython(scriptName: string, args: string[] = []): Promise<string> {
  const pythonBin = await requirePython(['yt_dlp'])
  const env = await buildSpawnEnv()
  return new Promise((resolve, reject) => {
    let out = ''
    const proc = backgroundProcesses.spawn(pythonBin, [scriptName, ...args], {
      cwd: vidEnginePath,
      env
    })
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
    if (/^https?:\/\//i.test(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    event.preventDefault()
    if (/^https?:\/\//i.test(targetUrl)) void shell.openExternal(targetUrl)
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
  skipDanmaku?: boolean
  llmProvider?: LlmProvider
}

// 弹幕数据结构
interface DanmakuData {
  platform: string
  total_count: number
  word_freq: [string, number][]
  density_bins: [number, number, number][]
  chunk_top: Record<string, string[]>
}

interface ParseResult {
  success: boolean
  output?: string
  danmaku?: DanmakuData | null
  llmReceipt?: LlmCallReceipt
  error?: string
}

interface LocalPlaybackProgress {
  filePath: string
  requestId: string
  status: 'converting' | 'ready' | 'error'
  progress: number
  message: string
}

const directPlaybackExtensions = new Set(['.mp4', '.m4v', '.mov', '.webm'])

function canUseOriginalForPlayback(filePath: string): boolean {
  return directPlaybackExtensions.has(extname(filePath).toLowerCase())
}

function getPlaybackProxyPath(filePath: string): string {
  const stat = statSync(filePath)
  const key = `complete-preview-v2:${filePath}:${stat.size}:${stat.mtimeMs}`
  const id = createHash('sha256').update(key).digest('hex').slice(0, 18)
  const dir = join(tmpdir(), 'vid-studio-playback')
  mkdirSync(dir, { recursive: true })
  return join(dir, `${id}.mp4`)
}

function sendPlaybackProgress(
  event: Electron.IpcMainInvokeEvent,
  request: PlaybackRequest,
  progress: LocalPlaybackProgress
): void {
  if (request.signal.aborted || event.sender.isDestroyed()) return
  event.sender.send('local-playback-progress', progress)
}

function parseFfmpegTimeMs(line: string): number | null {
  if (!line.startsWith('out_time_ms=')) return null
  const raw = Number(line.split('=', 2)[1])
  return Number.isFinite(raw) ? raw : null
}

function probeDurationSeconds(filePath: string, request: PlaybackRequest): Promise<number> {
  return new Promise((resolve) => {
    const args = [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath
    ]
    const proc = request.spawn('ffprobe', args)
    let out = ''
    proc.stdout.on('data', (d: Buffer) => {
      out += d.toString()
    })
    proc.on('close', () => {
      const duration = Number.parseFloat(out.trim())
      resolve(Number.isFinite(duration) && duration > 0 ? duration : 0)
    })
    proc.on('error', () => resolve(0))
  })
}

async function runPlaybackTranscode(
  event: Electron.IpcMainInvokeEvent,
  request: PlaybackRequest,
  requestId: string,
  filePath: string,
  outputPath: string,
  durationSeconds: number
): Promise<void> {
  request.signal.throwIfAborted()
  await writeStagedOutput(
    outputPath,
    (temporaryPath) =>
      new Promise<void>((resolve, reject) => {
        const args = [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-fflags',
          '+genpts',
          '-i',
          filePath,
          '-map',
          '0:v:0',
          '-map',
          '0:a:0?',
          '-vf',
          "scale='min(1280,iw)':-2",
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '28',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-movflags',
          '+faststart',
          '-progress',
          'pipe:1',
          '-nostats',
          temporaryPath
        ]

        const proc = request.spawn('ffmpeg', args)
        const total = Math.max(durationSeconds, 1)
        let lastProgress = -5
        let errorText = ''

        sendPlaybackProgress(event, request, {
          filePath,
          requestId,
          status: 'converting',
          progress: 0,
          message: '正在生成可播放预览'
        })

        proc.stdout.on('data', (d: Buffer) => {
          for (const rawLine of d.toString().split(/\r?\n/)) {
            const timeMs = parseFfmpegTimeMs(rawLine.trim())
            if (timeMs === null) continue
            const progress = Math.min(
              99,
              Math.max(0, Math.floor((timeMs / 1_000_000 / total) * 100))
            )
            if (progress >= lastProgress + 5) {
              lastProgress = progress
              sendPlaybackProgress(event, request, {
                filePath,
                requestId,
                status: 'converting',
                progress,
                message: `正在生成可播放预览 ${progress}%`
              })
            }
          }
        })

        proc.stderr.on('data', (d: Buffer) => {
          errorText += d.toString()
        })

        proc.on('close', (code, signal) => {
          if (signal || request.signal.aborted) {
            reject(new Error('已取消生成播放预览'))
            return
          }
          if (code === 0 && existsSync(temporaryPath)) {
            resolve()
            return
          }
          reject(new Error(errorText.trim() || `ffmpeg 退出码 ${code}`))
        })

        proc.on('error', (err: NodeJS.ErrnoException) => {
          reject(new Error(err.code === 'ENOENT' ? '未找到 ffmpeg，请先安装 ffmpeg' : err.message))
        })
      })
  )
  request.signal.throwIfAborted()
  sendPlaybackProgress(event, request, {
    filePath,
    requestId,
    status: 'ready',
    progress: 100,
    message: '播放预览已就绪'
  })
}

function cleanGeneratedTitle(value: string): string {
  return value
    .split(/\r?\n/)[0]
    .replace(/^\s*(?:标题|文档标题)\s*[：:]\s*/, '')
    .replace(/^[#*\s"'“”‘’《》]+|[#*\s"'“”‘’《》]+$/g, '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
}

async function generateSummaryDocumentTitle(
  payload: TimelineExportPayload
): Promise<{ title: string; receipt: LlmCallReceipt }> {
  const fallback = payload.title.trim() || '视频解析文档'
  const startedAt = Date.now()
  let connection: LlmConnection | null = null
  try {
    connection = await resolveLlmConnection(payload.llmProvider)
    const outline = payload.chunks
      .slice(0, 24)
      .map(
        (chunk, index) => `${index + 1}. ${chunk.title}${chunk.summary ? `：${chunk.summary}` : ''}`
      )
      .join('\n')
      .slice(0, 6000)
    const body: Record<string, unknown> = {
      model: connection.model,
      messages: [
        {
          role: 'system',
          content:
            '你是专业中文编辑。请根据视频全片提纲生成一个总结性的文档标题，准确概括主题与价值。只输出标题，不要解释，不要使用书名号、引号或 Markdown。标题控制在 12-28 个汉字。'
        },
        {
          role: 'user',
          content: `参考标题：${payload.title}\n全片提纲：\n${outline}`
        }
      ],
      max_tokens: 120,
      stream: false
    }
    applyModelTuning(body, connection, 0.3)

    const response = await fetch(getChatCompletionsUrl(connection.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${connection.apiKey}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    })
    if (!response.ok) throw new Error(`标题生成失败（HTTP ${response.status}）`)

    const data = (await response.json()) as {
      model?: string
      choices?: { message?: { content?: string } }[]
    }
    return {
      title: cleanGeneratedTitle(data.choices?.[0]?.message?.content ?? '') || fallback,
      receipt: createLlmCallReceipt(connection, '导出标题生成', startedAt, {
        responseModel: data.model,
        requestId: getResponseRequestId(response.headers)
      })
    }
  } catch (error) {
    console.warn('[main] 生成总结性文档标题失败，使用本地标题:', error)
    const fallbackConnection =
      connection ??
      ({
        provider: normalizeLlmProvider(payload.llmProvider),
        label: payload.llmProvider === 'gpt-5.6-sol' ? '自定义接口' : 'DeepSeek',
        apiKey: '',
        baseUrl: '',
        model: payload.llmProvider === 'gpt-5.6-sol' ? 'gpt-5.6-sol' : 'deepseek-chat'
      } satisfies LlmConnection)
    return {
      title: fallback,
      receipt: {
        ...createLlmCallReceipt(fallbackConnection, '导出标题生成', startedAt, {
          status: 'fallback',
          error: String(error)
        }),
        endpoint: connection ? getChatCompletionsUrl(connection.baseUrl) : ''
      }
    }
  }
}

// 记录当前解析进程，用于停止
let currentParseProc: ChildProcess | null = null
let parsePreparing = false
let parseStopping = false
let parseGeneration = 0

async function runParseProcess(
  event: Electron.IpcMainInvokeEvent,
  args: string[],
  outputPath: string
): Promise<ParseResult> {
  if (currentParseProc || parsePreparing || parseStopping)
    return { success: false, error: '已有解析任务正在运行，请先停止。' }
  const generation = ++parseGeneration
  parsePreparing = true
  let pythonBin: string
  let env: NodeJS.ProcessEnv
  try {
    ;[pythonBin, env] = await Promise.all([requirePython(), buildSpawnEnv()])
  } catch (error) {
    if (generation === parseGeneration) parsePreparing = false
    return { success: false, error: String(error) }
  }
  if (generation !== parseGeneration) return { success: false, error: '已停止解析' }
  parsePreparing = false
  return new Promise<ParseResult>((resolve) => {
    const proc = backgroundProcesses.spawn(pythonBin, args, { cwd: vidEnginePath, env })
    currentParseProc = proc
    const receiptPrefix = '__VID_STUDIO_LLM_RECEIPT__'
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    let stdoutBuffer = ''
    let llmReceipt: LlmCallReceipt | undefined
    const recentLines: string[] = []

    const rememberLine = (line: string): void => {
      const clean = line
        .replaceAll(String.fromCharCode(27), '')
        .replace(/\[[0-9;]*m/g, '')
        .trim()
      if (!clean) return
      recentLines.push(clean)
      if (recentLines.length > 40) recentLines.shift()
    }

    const processStdout = (text: string, flush = false): void => {
      if (generation !== parseGeneration || event.sender.isDestroyed()) return
      stdoutBuffer += text
      const lines = stdoutBuffer.split('\n')
      const remainder = lines.pop() ?? ''
      stdoutBuffer = flush ? '' : remainder
      if (flush && remainder) lines.push(remainder)

      for (const rawLine of lines) {
        const line = rawLine.trimEnd()
        if (!line) continue
        if (line.startsWith(receiptPrefix)) {
          try {
            llmReceipt = JSON.parse(line.slice(receiptPrefix.length)) as LlmCallReceipt
          } catch (error) {
            console.warn('[main] 无法解析 Python 模型调用凭证:', error)
          }
          continue
        }
        rememberLine(line)
        event.sender.send('parse-progress', `${line}\n`)
      }
    }

    const processStderr = (text: string): void => {
      if (generation !== parseGeneration || event.sender.isDestroyed()) return
      for (const line of text.split(/\r?\n/)) rememberLine(line)
      event.sender.send('parse-progress', text)
    }

    proc.stdout.on('data', (d: Buffer) => processStdout(stdoutDecoder.write(d)))
    proc.stderr.on('data', (d: Buffer) => processStderr(stderrDecoder.write(d)))

    proc.on('close', async (code, signal) => {
      processStdout(stdoutDecoder.end(), true)
      processStderr(stderrDecoder.end())
      if (currentParseProc === proc) currentParseProc = null
      // 用户主动停止
      if (signal || generation !== parseGeneration) {
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
          resolve({ success: true, output, danmaku, llmReceipt })
        } catch {
          resolve({ success: false, error: '读取输出文件失败' })
        }
      } else {
        const detail =
          [...recentLines].reverse().find((line) => line.startsWith('错误：')) ??
          [...recentLines]
            .reverse()
            .find((line) => /(?:Error|错误|失败|not found|No module named)/i.test(line))
        resolve({
          success: false,
          error: detail ?? `解析进程异常退出（code: ${code}）`
        })
      }
    })

    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (currentParseProc === proc) currentParseProc = null
      resolve({
        success: false,
        error: err.code === 'ENOENT' ? '未找到 Python 环境，请确认已安装 python3' : err.message
      })
    })
  })
}

ipcMain.handle('parse-video', async (event, url: string, options: ParseOptions = {}) => {
  const outputPath = join(tmpdir(), `vid-studio-${Date.now()}.txt`)
  const args = ['main.py', url, '-o', outputPath]
  if (options.skipVideo !== false) args.push('--skip-video')
  if (options.skipDanmaku) args.push('--skip-danmaku')
  args.push('--llm-provider', normalizeLlmProvider(options.llmProvider))

  return runParseProcess(event, args, outputPath)
})

ipcMain.handle('parse-local-video', async (event, filePath: string, options: ParseOptions = {}) => {
  const outputPath = join(tmpdir(), `vid-studio-${Date.now()}.txt`)
  const args = ['main.py', filePath, '--local-file', '-o', outputPath]
  if (options.skipVideo !== false) args.push('--skip-video')
  if (options.skipDanmaku) args.push('--skip-danmaku')
  args.push('--llm-provider', normalizeLlmProvider(options.llmProvider))

  return runParseProcess(event, args, outputPath)
})

ipcMain.handle(
  'prepare-local-video-playback',
  async (event, filePath: string, forceProxy = false, requestId = '') => {
    const request = playbackRequests.begin()
    try {
      await request.ready
      request.signal.throwIfAborted()
      if (!existsSync(filePath)) {
        return { success: false, error: `本地视频文件不存在：${filePath}` }
      }

      if (!forceProxy && canUseOriginalForPlayback(filePath)) {
        return {
          success: true,
          url: pathToFileURL(filePath).toString(),
          needsProxy: false,
          message: '使用原始视频播放'
        }
      }

      const proxyPath = getPlaybackProxyPath(filePath)
      if (existsSync(proxyPath)) {
        sendPlaybackProgress(event, request, {
          filePath,
          requestId,
          status: 'ready',
          progress: 100,
          message: '播放预览已就绪'
        })
        return {
          success: true,
          url: pathToFileURL(proxyPath).toString(),
          needsProxy: true,
          message: '使用已生成的播放预览'
        }
      }

      const duration = await probeDurationSeconds(filePath, request)
      request.signal.throwIfAborted()
      await runPlaybackTranscode(event, request, requestId, filePath, proxyPath, duration)
      request.signal.throwIfAborted()

      return {
        success: true,
        url: pathToFileURL(proxyPath).toString(),
        needsProxy: true,
        message: '播放预览已就绪'
      }
    } catch (e) {
      if (request.signal.aborted) return { success: false, canceled: true }
      sendPlaybackProgress(event, request, {
        filePath,
        requestId,
        status: 'error',
        progress: 0,
        message: String(e)
      })
      return { success: false, error: String(e) }
    }
  }
)

ipcMain.handle('cancel-local-video-playback', () => playbackRequests.cancel())

ipcMain.handle(
  'export-timeline-text',
  async (_, payload: TimelineExportPayload, format: TextExportFormat) => {
    try {
      if (!Object.hasOwn(EXPORT_FORMATS, format) || !payload?.chunks?.length) {
        return { success: false, error: '请选择有效格式和需要导出的片段' }
      }
      const content = buildTextExport(payload, format)
      const info = EXPORT_FORMATS[format]
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: `导出${info.label}`,
        defaultPath: `${safeExportFilename(payload.title)}.${info.extension}`,
        filters: [{ name: info.label, extensions: [info.extension] }]
      })
      if (canceled || !filePath) return { success: false, canceled: true }
      await writeFile(filePath, content, 'utf-8')
      return { success: true, path: filePath }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }
)

ipcMain.handle('export-timeline-document', (_, payload: TimelineExportPayload) =>
  exportTimelinePdf(payload, {
    chooseFile: async (filename) => {
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: '导出时间轴文档',
        defaultPath: filename,
        filters: [{ name: 'PDF 文档', extensions: ['pdf'] }]
      })
      return canceled ? null : (filePath ?? null)
    },
    suggestTitle: generateSummaryDocumentTitle,
    writePdf: async (document, filePath) => {
      const html = buildTimelineExportHtml(document)
      const printWindow = new BrowserWindow({
        width: 900,
        height: 1200,
        show: false,
        webPreferences: {
          sandbox: true,
          nodeIntegration: false,
          contextIsolation: true
        }
      })
      try {
        await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
        const pdf = await printWindow.webContents.printToPDF({
          printBackground: true,
          preferCSSPageSize: true,
          generateTaggedPDF: true,
          generateDocumentOutline: true
        })
        await writeFile(filePath, pdf)
      } finally {
        printWindow.close()
      }
    }
  })
)

// ─── IPC：停止解析 ────────────────────────────────────────
ipcMain.handle('stop-parse', async () => {
  parseGeneration++
  parsePreparing = false
  if (currentParseProc) {
    const proc = currentParseProc
    parseStopping = true
    try {
      await backgroundProcesses.stop(proc)
      if (currentParseProc === proc) currentParseProc = null
    } finally {
      parseStopping = false
    }
  }
})

// ─── IPC：LLM 对话（流式，支持 Tavily 互联网搜索工具） ────

interface InternalMessage {
  role: string
  content: string | null
  tool_calls?: StreamToolCall[]
  tool_call_id?: string
}

const chatRequests = new ChatRequests()

ipcMain.handle('stop-chat', (event, requestId: string) =>
  chatRequests.cancel(event.sender.id, requestId)
)
ipcMain.handle('get-conversation', (_, sourceKey: string) => getChatStore().load(sourceKey))
ipcMain.handle('save-conversation', (_, sourceKey: string, messages: ChatMessage[]) =>
  getChatStore().save(sourceKey, messages)
)
ipcMain.handle(
  'export-conversation',
  async (_, sourceKey: string, title: string, input: ChatMessage[]) => {
    try {
      const messages = validateConversation(sourceKey, input, MAX_CHAT_CHARACTERS * 2)
      if (typeof title !== 'string' || title.length > 1000) throw new Error('对话标题无效')
      if (!messages.length) throw new Error('当前没有可导出的对话')
      const destination = await dialog.showSaveDialog({
        title: '导出对话记录',
        defaultPath: `${safeExportFilename(title)}-对话.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      })
      if (destination.canceled || !destination.filePath) return { success: false, canceled: true }
      await writeFile(destination.filePath, conversationMarkdown(title, messages), 'utf8')
      return { success: true, path: destination.filePath }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }
)

ipcMain.handle('chat-with-video', async (event, request: ChatRequest): Promise<ChatResult> => {
  try {
    validateChatRequest(request)
  } catch (error) {
    return { success: false, error: String(error) }
  }
  const owner = event.sender.id
  const { signal, finish } = chatRequests.begin(owner, request.requestId)
  const abortOnClose = (): void => chatRequests.cancel(owner, request.requestId)
  event.sender.once('destroyed', abortOnClose)
  const send = (type: 'delta' | 'search', text: string): void => {
    if (!signal.aborted && !event.sender.isDestroyed())
      event.sender.send('chat-event', { requestId: request.requestId, type, text })
  }
  try {
    const connection = await resolveLlmConnection(request.provider)
    const tavilyKey = await readEnvKey('TAVILY_API_KEY')
    signal.throwIfAborted()
    const searchTool = {
      type: 'function',
      function: {
        name: 'web_search',
        description:
          '搜索互联网获取实时信息。仅在需要最新动态、无法从视频与已有知识确认的具体事实，或用户明确要求搜索时调用。优先使用视频内容。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '搜索关键词' } },
          required: ['query']
        }
      }
    }
    const streamLLM = async (
      messages: InternalMessage[],
      noTools = false
    ): Promise<{
      content: string
      receipt: LlmCallReceipt
      toolCalls: StreamToolCall[]
      finishReason: string
    }> => {
      signal.throwIfAborted()
      const startedAt = Date.now()
      const body: Record<string, unknown> = {
        model: connection.model,
        messages,
        max_tokens: 2000,
        stream: true
      }
      applyModelTuning(body, connection, 0.7)
      if (tavilyKey && !noTools) {
        body.tools = [searchTool]
        body.tool_choice = 'auto'
      }
      const response = await fetch(getChatCompletionsUrl(connection.baseUrl), {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${connection.apiKey}`
        },
        body: JSON.stringify(body)
      })
      if (!response.ok)
        throw new Error(`模型服务返回 HTTP ${response.status}，请检查模型设置或稍后重试。`)
      const streamed = await readChatStream(response, signal, (delta) => send('delta', delta))
      const receipt = createLlmCallReceipt(connection, '视频对话', startedAt, {
        responseModel: streamed.responseModel,
        requestId: getResponseRequestId(response.headers)
      })
      return { ...streamed, receipt }
    }
    const internalMessages: InternalMessage[] = request.messages.map((message) => ({ ...message }))
    const phase1 = await streamLLM(internalMessages)
    let final = phase1
    if (phase1.toolCalls.length) {
      const toolResults: InternalMessage[] = []
      for (const call of phase1.toolCalls) {
        signal.throwIfAborted()
        let content = '此搜索工具不可用。请基于现有资料回答，并说明资料不足之处。'
        if (call.function.name === 'web_search' && tavilyKey) {
          try {
            const args = JSON.parse(call.function.arguments) as { query: string }
            if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 1000)
              throw new Error('搜索关键词无效')
            send('search', args.query)
            const response = await fetch('https://api.tavily.com/search', {
              method: 'POST',
              signal,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                api_key: tavilyKey,
                query: args.query,
                search_depth: 'basic',
                max_results: 5,
                include_answer: true
              })
            })
            if (!response.ok) throw new Error(`搜索请求失败（HTTP ${response.status}）`)
            const found = (await response.json()) as {
              answer?: string
              results?: { title: string; url: string; content: string }[]
            }
            content =
              [
                found.answer ?? '',
                ...(found.results ?? [])
                  .slice(0, 5)
                  .map((item) => `标题：${item.title}\n链接：${item.url}\n内容：${item.content}`)
              ]
                .join('\n\n')
                .slice(0, 12000) || '搜索未返回有效结果'
          } catch (error) {
            signal.throwIfAborted()
            content = `搜索未完成：${String(error)}。请明确说明这一限制。`
          }
        }
        toolResults.push({ role: 'tool', content, tool_call_id: call.id })
      }
      final = await streamLLM(
        [
          ...internalMessages,
          { role: 'assistant', content: phase1.content || null, tool_calls: phase1.toolCalls },
          ...toolResults
        ],
        true
      )
    }
    if (final.toolCalls.length) throw new Error('模型未能完成搜索后的回答，请重试。')
    if (final.finishReason === 'length')
      return {
        success: false,
        llmReceipt: final.receipt,
        error: '回答达到长度上限，已保留内容。可以发送「继续」接着提问。'
      }
    return { success: true, llmReceipt: final.receipt }
  } catch (error) {
    if (signal.aborted) {
      if (signal.reason?.name === 'TimeoutError')
        return { success: false, error: '回答超过 3 分钟，已停止请求。请重试或缩小问题范围。' }
      return { success: false, canceled: true }
    }
    return { success: false, error: String(error).slice(0, 2000) }
  } finally {
    event.sender.removeListener('destroyed', abortOnClose)
    finish()
  }
})

// ─── IPC：设置与本地诊断 ──────────────────────────────────
ipcMain.handle('get-settings', () => getSettingsStore().snapshot())
ipcMain.handle('save-settings', async (_, update: SettingsUpdate) => {
  await getSettingsStore().save(update)
  pythonRuntime.invalidate()
  return getSettingsStore().snapshot()
})
ipcMain.handle('choose-python', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择 Python 程序',
    properties: ['openFile']
  })
  return result.canceled ? null : (result.filePaths[0] ?? null)
})
ipcMain.handle('open-data-directory', () => shell.openPath(app.getPath('userData')))
ipcMain.handle('diagnose-environment', async () => {
  const [settings, python, present, ffmpeg, ffprobe] = await Promise.all([
    getSettingsStore().snapshot(),
    pythonRuntime.resolve(true),
    engineAvailable(vidEnginePath),
    probeMediaTool('ffmpeg'),
    probeMediaTool('ffprobe')
  ])
  return buildDiagnosticReport({
    appVersion: app.getVersion(),
    platform: process.platform,
    settings,
    python,
    enginePresent: present,
    ffmpeg,
    ffprobe
  })
})

// ─── IPC：历史管理 ────────────────────────────────────────

ipcMain.handle('get-history', () => getHistory())
ipcMain.handle('search-library', async (_, query: LibraryQuery) =>
  getLibraryIndex().search(await getHistory(), query)
)
ipcMain.handle('rename-history', (_, id: string, title: string) => renameHistory(id, title))

ipcMain.handle('add-history', async (_, item) => {
  try {
    console.log('[main] add-history 收到请求:', item)
    await addHistory(item)
  } catch (e) {
    console.error('[main] add-history 失败:', e)
    throw e
  }
})

ipcMain.handle('toggle-favorite', (_, id: string) => toggleFavorite(id))
ipcMain.handle('delete-history', (_, id: string) => deleteHistory(id))

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
    throw e
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

ipcMain.handle('get-annotations', (_, sourceKey: string) => getAnnotationStore().list(sourceKey))
ipcMain.handle('save-annotation', (_, input) => getAnnotationStore().save(input))
ipcMain.handle('get-reading-position', (_, key: string) => getReadingStore().load(key))
ipcMain.handle('save-reading-position', (_, input: ReadingPositionInput) =>
  getReadingStore().save(input)
)

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

let shuttingDown = false
let readyToQuit = false
app.on('before-quit', (event) => {
  if (readyToQuit) return
  event.preventDefault()
  if (shuttingDown) return
  shuttingDown = true
  parseGeneration++
  void backgroundProcesses
    .shutdown()
    .catch((error) => console.error('[main] 关闭后台任务失败:', error))
    .finally(() => {
      readyToQuit = true
      app.quit()
    })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
