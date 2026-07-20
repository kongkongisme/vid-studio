import { app, shell, BrowserWindow, ipcMain, session, dialog } from 'electron'
import { getHistory, addHistory, toggleFavorite, deleteHistory } from './history'
import { getCachedContent, setCachedContent, deleteCachedContent, getCachedUrls } from './cache'
import { extname, join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { spawn, execSync, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, statSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { StringDecoder } from 'string_decoder'
import { pathToFileURL } from 'url'
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
    } catch {
      /* 无代理或命令不可用，静默忽略 */
    }
  }
  return null
}

// 启动时检测一次，避免每次 spawn 重复调用
const PROXY_URL = detectSystemProxy()

function buildSpawnEnv(): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
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
  try {
    const content = await readFile(join(vidEnginePath, '.env'), 'utf-8')
    const match = content.match(new RegExp(`^${key}=(.+)$`, 'm'))
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : ''
  } catch {
    return ''
  }
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
  if (normalized === 'gpt-5.6-sol') {
    const [apiKey, baseUrl, model, reasoningEffort] = await Promise.all([
      readEnvKey('GPT_API_KEY'),
      readEnvKey('GPT_BASE_URL'),
      readEnvKey('GPT_MODEL'),
      readEnvKey('GPT_REASONING_EFFORT')
    ])
    if (!apiKey) {
      throw new Error('未配置 GPT_API_KEY，请在 vid-engine/.env 中设置')
    }
    return {
      provider: normalized,
      label: 'GPT-5.6 Sol',
      apiKey,
      baseUrl: baseUrl || 'https://api.openai.com/v1',
      model: model || 'gpt-5.6-sol',
      reasoningEffort: reasoningEffort || 'high'
    }
  }

  const [apiKey, baseUrl, model] = await Promise.all([
    readEnvKey('DEEPSEEK_API_KEY'),
    readEnvKey('DEEPSEEK_BASE_URL'),
    readEnvKey('DEEPSEEK_MODEL')
  ])
  if (!apiKey) {
    throw new Error('未配置 DEEPSEEK_API_KEY，请在 vid-engine/.env 中设置')
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
function runPython(scriptName: string, args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    const proc = spawn(pythonBin, [scriptName, ...args], {
      cwd: vidEnginePath,
      env: buildSpawnEnv()
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

const directPlaybackExtensions = new Set(['.mp4', '.m4v', '.mov', '.webm'])

function canUseOriginalForPlayback(filePath: string): boolean {
  return directPlaybackExtensions.has(extname(filePath).toLowerCase())
}

function getPlaybackProxyPath(filePath: string): string {
  const stat = statSync(filePath)
  const key = `${filePath}:${stat.size}:${stat.mtimeMs}`
  const id = createHash('sha256').update(key).digest('hex').slice(0, 18)
  const dir = join(tmpdir(), 'vid-studio-playback')
  mkdirSync(dir, { recursive: true })
  return join(dir, `${id}.mp4`)
}

function sendPlaybackProgress(
  event: Electron.IpcMainInvokeEvent,
  progress: LocalPlaybackProgress
): void {
  event.sender.send('local-playback-progress', progress)
}

function parseFfmpegTimeMs(line: string): number | null {
  if (!line.startsWith('out_time_ms=')) return null
  const raw = Number(line.split('=', 2)[1])
  return Number.isFinite(raw) ? raw : null
}

function probeDurationSeconds(filePath: string): Promise<number> {
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
    const proc = spawn('ffprobe', args)
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

function runPlaybackTranscode(
  event: Electron.IpcMainInvokeEvent,
  filePath: string,
  outputPath: string,
  durationSeconds: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (currentPlaybackProc) {
      currentPlaybackProc.kill()
      currentPlaybackProc = null
    }

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
      outputPath
    ]

    const proc = spawn('ffmpeg', args)
    currentPlaybackProc = proc
    const total = Math.max(durationSeconds, 1)
    let lastProgress = -5
    let errorText = ''

    sendPlaybackProgress(event, {
      filePath,
      status: 'converting',
      progress: 0,
      message: '正在生成可播放预览'
    })

    proc.stdout.on('data', (d: Buffer) => {
      for (const rawLine of d.toString().split(/\r?\n/)) {
        const timeMs = parseFfmpegTimeMs(rawLine.trim())
        if (timeMs === null) continue
        const progress = Math.min(99, Math.max(0, Math.floor((timeMs / 1_000_000 / total) * 100)))
        if (progress >= lastProgress + 5) {
          lastProgress = progress
          sendPlaybackProgress(event, {
            filePath,
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
      if (currentPlaybackProc === proc) currentPlaybackProc = null
      if (signal) {
        reject(new Error('已取消生成播放预览'))
        return
      }
      if (code === 0 && existsSync(outputPath)) {
        sendPlaybackProgress(event, {
          filePath,
          status: 'ready',
          progress: 100,
          message: '播放预览已就绪'
        })
        resolve()
        return
      }
      reject(new Error(errorText.trim() || `ffmpeg 退出码 ${code}`))
    })

    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (currentPlaybackProc === proc) currentPlaybackProc = null
      reject(new Error(err.code === 'ENOENT' ? '未找到 ffmpeg，请先安装 ffmpeg' : err.message))
    })
  })
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function renderHighlightedText(value: string, highlightTerm = ''): string {
  const escaped = escapeHtml(value)
  const term = highlightTerm.trim()
  if (!term) return escaped
  return escaped.replace(new RegExp(`(${escapeRegExp(escapeHtml(term))})`, 'gi'), '<mark>$1</mark>')
}

function buildFallbackDocumentTitle(payload: TimelineExportPayload): string {
  const topic = payload.chunks
    .map((chunk) => chunk.title.replace(/^[^：:]{1,12}[：:]/, '').trim())
    .find(Boolean)
  const base = topic || payload.title.trim() || '视频内容'
  return `${base.slice(0, 36)}：核心观点与知识脉络`
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
  const fallback = buildFallbackDocumentTitle(payload)
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
      body: JSON.stringify(body)
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
        label: payload.llmProvider === 'gpt-5.6-sol' ? 'GPT-5.6 Sol' : 'DeepSeek',
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

function buildTimelineExportHtml(payload: TimelineExportPayload): string {
  const title = payload.title.trim() || '视频解析文档'
  const highlightTerm = payload.highlightTerm?.trim() ?? ''
  const receipt = payload.llmReceipt
  const receiptHtml = receipt
    ? `<section class="receipt">
        <div class="receipt-title">模型调用凭证 <span class="receipt-status ${receipt.status}">${receipt.status === 'success' ? '接口已响应' : '已降级'}</span></div>
        <div class="receipt-grid">
          <div><b>用途</b><p>${escapeHtml(receipt.purpose)}</p></div>
          <div><b>请求模型</b><p>${escapeHtml(receipt.requestedModel)}</p></div>
          <div><b>响应模型</b><p>${escapeHtml(receipt.responseModel || '接口未返回')}</p></div>
          <div><b>耗时</b><p>${receipt.durationMs} ms</p></div>
          <div class="wide"><b>Endpoint</b><p>${escapeHtml(receipt.endpoint || '未建立模型连接')}</p></div>
          <div class="wide"><b>Request ID</b><p>${escapeHtml(receipt.requestId || '接口未提供')}</p></div>
        </div>
        <p class="receipt-note">该凭证记录应用实际发送的模型参数及接口自报信息；第三方代理是否运行对应底层模型，仍需服务商日志或签名证明。</p>
      </section>`
    : ''
  const chunks = payload.chunks
    .map((chunk, index) => {
      const keyPoints = chunk.keyPoints
        .map((point) => `<li>${renderHighlightedText(point, highlightTerm)}</li>`)
        .join('')
      const tags = chunk.tags
        .map((tag) => `<span>${renderHighlightedText(tag, highlightTerm)}</span>`)
        .join('')
      const transcript = payload.includeTranscript
        ? chunk.transcript
            .map(
              (line) =>
                `<div class="transcript-line"><b>${escapeHtml(line.time)}</b><p>${renderHighlightedText(
                  line.text,
                  highlightTerm
                )}</p></div>`
            )
            .join('')
        : ''

      return `
        <section class="chunk${transcript ? ' with-transcript' : ''}">
          <div class="chunk-index">${String(index + 1).padStart(2, '0')}</div>
          <div class="chunk-body">
            <div class="time">${escapeHtml(chunk.startTime)} - ${escapeHtml(chunk.endTime)}</div>
            <h2>${renderHighlightedText(chunk.title, highlightTerm)}</h2>
            ${chunk.summary ? `<p class="summary">${renderHighlightedText(chunk.summary, highlightTerm)}</p>` : ''}
            ${keyPoints ? `<ul>${keyPoints}</ul>` : ''}
            ${tags ? `<div class="tags">${tags}</div>` : ''}
            ${transcript ? `<div class="transcript"><div class="transcript-title">原文记录</div>${transcript}</div>` : ''}
          </div>
        </section>`
    })
    .join('')

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    @page { size: A4; margin: 20mm 18mm 22mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: #172033;
      font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      background: #f8fafc;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    body::before {
      content: "视析工作站";
      position: fixed;
      inset: 0;
      z-index: 0;
      color: rgba(15, 23, 42, 0.055);
      font-size: 54px;
      font-weight: 700;
      letter-spacing: 0.18em;
      display: grid;
      place-items: center;
      transform: rotate(-28deg);
      pointer-events: none;
    }
    main { position: relative; z-index: 1; background: white; padding: 28px 30px 34px; }
    header {
      border-bottom: 1px solid #dbe3ef;
      padding-bottom: 18px;
      margin-bottom: 20px;
    }
    .brand { color: #2563eb; font-size: 13px; font-weight: 700; letter-spacing: 0.16em; }
    h1 { margin: 8px 0 12px; font-size: 30px; line-height: 1.25; letter-spacing: 0; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; color: #64748b; font-size: 12px; }
    .meta span {
      border: 1px solid #dbe3ef;
      border-radius: 999px;
      padding: 5px 10px;
      background: #f8fafc;
    }
    .notice {
      margin-top: 14px;
      border-left: 3px solid #2563eb;
      padding: 8px 12px;
      color: #475569;
      background: #eff6ff;
      font-size: 12px;
      line-height: 1.6;
    }
    .chunk { display: grid; grid-template-columns: 44px 1fr; gap: 14px; padding: 18px 0; break-inside: avoid; }
    .chunk + .chunk { border-top: 1px solid #e2e8f0; }
    .chunk-index {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      color: #2563eb;
      background: #eff6ff;
      font-weight: 700;
      font-size: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .time {
      color: #2563eb;
      font-size: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      margin-bottom: 5px;
    }
    h2 { margin: 0 0 8px; font-size: 18px; line-height: 1.4; letter-spacing: 0; }
    .summary { margin: 0 0 10px; color: #475569; font-size: 13px; line-height: 1.75; }
    ul { margin: 8px 0 10px; padding-left: 18px; }
    li { margin: 5px 0; color: #334155; font-size: 13px; line-height: 1.65; }
    .tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .tags span {
      color: #475569;
      background: #f1f5f9;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 3px 7px;
      font-size: 11px;
    }
    .chunk.with-transcript { break-inside: auto; }
    .transcript {
      margin-top: 12px;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      background: #f8fafc;
      padding: 9px 11px;
      break-inside: auto;
    }
    .transcript-title { color: #64748b; font-size: 12px; font-weight: 600; }
    .transcript-line { display: grid; grid-template-columns: 52px 1fr; gap: 8px; margin-top: 8px; }
    .transcript-line b {
      color: #2563eb;
      font-size: 10px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-weight: 600;
    }
    .transcript-line p { margin: 0; color: #475569; font-size: 11px; line-height: 1.55; }
    .receipt {
      margin: 0 0 18px;
      border: 1px solid #bfdbfe;
      border-radius: 10px;
      background: #f8fbff;
      padding: 12px 14px;
      break-inside: avoid;
    }
    .receipt-title { color: #1e3a8a; font-size: 13px; font-weight: 700; }
    .receipt-status {
      margin-left: 6px;
      border-radius: 999px;
      padding: 2px 7px;
      font-size: 10px;
    }
    .receipt-status.success { color: #166534; background: #dcfce7; }
    .receipt-status.fallback { color: #92400e; background: #fef3c7; }
    .receipt-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; margin-top: 10px; }
    .receipt-grid .wide { grid-column: 1 / -1; }
    .receipt-grid b { color: #64748b; font-size: 10px; font-weight: 600; }
    .receipt-grid p { margin: 2px 0 0; color: #1e293b; font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }
    .receipt-note { margin: 10px 0 0; color: #64748b; font-size: 10px; line-height: 1.5; }
    mark { background: #fef08a; color: inherit; padding: 0 2px; border-radius: 2px; }
    footer {
      margin-top: 22px;
      padding-top: 12px;
      border-top: 1px solid #e2e8f0;
      color: #94a3b8;
      font-size: 11px;
      text-align: center;
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="brand">VIDSTUDIO · 视析工作站</div>
      <h1>${escapeHtml(title)}</h1>
      <div class="meta">
        <span>${escapeHtml(payload.sourceLabel)}</span>
        <span>${escapeHtml(payload.modeLabel)}</span>
        <span>${escapeHtml(payload.exportedAt)}</span>
        <span>共 ${payload.chunks.length} 个片段</span>
      </div>
      <div class="notice">本文档由视析工作站根据视频解析内容生成，${payload.includeTranscript ? '包含原文记录，' : '未包含原文记录，'}导出为 PDF 以便查阅和归档。页面已添加水印，请勿篡改原始内容。</div>
    </header>
    ${receiptHtml}
    ${chunks}
    <footer>视析工作站 · VidStudio</footer>
  </main>
</body>
</html>`
}

// 记录当前解析进程，用于停止
let currentParseProc: ChildProcess | null = null
let currentPlaybackProc: ChildProcess | null = null

function runParseProcess(
  event: Electron.IpcMainInvokeEvent,
  args: string[],
  outputPath: string
): Promise<ParseResult> {
  return new Promise<ParseResult>((resolve) => {
    const proc = spawn(pythonBin, args, { cwd: vidEnginePath, env: buildSpawnEnv() })
    currentParseProc = proc
    const receiptPrefix = '__VID_STUDIO_LLM_RECEIPT__'
    const stdoutDecoder = new StringDecoder('utf8')
    let stdoutBuffer = ''
    let llmReceipt: LlmCallReceipt | undefined

    const processStdout = (text: string, flush = false): void => {
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
        event.sender.send('parse-progress', `${line}\n`)
      }
    }

    proc.stdout.on('data', (d: Buffer) => processStdout(stdoutDecoder.write(d)))
    proc.stderr.on('data', (d: Buffer) => event.sender.send('parse-progress', d.toString()))

    proc.on('close', async (code, signal) => {
      processStdout(stdoutDecoder.end(), true)
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
          resolve({ success: true, output, danmaku, llmReceipt })
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
  async (event, filePath: string, forceProxy = false) => {
    try {
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
        sendPlaybackProgress(event, {
          filePath,
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

      const duration = await probeDurationSeconds(filePath)
      await runPlaybackTranscode(event, filePath, proxyPath, duration)

      return {
        success: true,
        url: pathToFileURL(proxyPath).toString(),
        needsProxy: true,
        message: '播放预览已就绪'
      }
    } catch (e) {
      sendPlaybackProgress(event, {
        filePath,
        status: 'error',
        progress: 0,
        message: String(e)
      })
      return { success: false, error: String(e) }
    }
  }
)

ipcMain.handle('export-timeline-document', async (_, payload: TimelineExportPayload) => {
  try {
    if (!payload.chunks.length) {
      return { success: false, error: '没有可导出的时间轴内容' }
    }

    const titleResult = await generateSummaryDocumentTitle(payload)
    const exportPayload = {
      ...payload,
      title: titleResult.title,
      llmReceipt: titleResult.receipt
    }
    const safeTitle = titleResult.title
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出时间轴文档',
      defaultPath: `${safeTitle || '视频解析文档'}.pdf`,
      filters: [{ name: 'PDF 文档', extensions: ['pdf'] }]
    })

    if (canceled || !filePath) {
      return { success: false, canceled: true }
    }

    const html = buildTimelineExportHtml(exportPayload)
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
        preferCSSPageSize: true
      })
      await writeFile(filePath, pdf)
    } finally {
      printWindow.close()
    }

    return {
      success: true,
      path: filePath,
      title: titleResult.title,
      llmReceipt: titleResult.receipt
    }
  } catch (e) {
    return { success: false, error: String(e) }
  }
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

ipcMain.handle(
  'chat-with-video',
  async (event, messages: ApiChatMessage[], provider: LlmProvider = 'deepseek') => {
    let connection: LlmConnection
    try {
      connection = await resolveLlmConnection(provider)
    } catch (error) {
      return { success: false, error: String(error) }
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
                '搜索互联网获取实时信息。仅当以下情况才调用：(1) 需要视频发布后的最新动态；(2) 需要具体数字/日期/事实且无法从视频内容或已有知识确认；(3) 用户明确要求搜索。若视频内容或模型已有知识已足够回答，不得调用此工具。判断需要搜索时直接调用，不要询问用户。',
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

    // 流式调用当前模型，同时检测工具调用
    const streamLLM = async (
      msgs: InternalMessage[],
      noTools = false
    ): Promise<{
      content: string
      receipt: LlmCallReceipt
      toolCall?: { id: string; name: string; args: string }
    }> => {
      const startedAt = Date.now()
      const body: Record<string, unknown> = {
        model: connection.model,
        messages: msgs,
        max_tokens: 2000,
        stream: true
      }
      applyModelTuning(body, connection, 0.7)
      if (tools && !noTools) {
        body.tools = tools
        body.tool_choice = 'auto'
      }

      const response = await fetch(getChatCompletionsUrl(connection.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${connection.apiKey}`
        },
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
      let responseModel = ''

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
              model?: string
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
            if (parsed.model) responseModel = parsed.model
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

      const receipt = createLlmCallReceipt(connection, '视频对话', startedAt, {
        responseModel,
        requestId: getResponseRequestId(response.headers)
      })
      if (finishReason === 'tool_calls' && toolCallName) {
        return {
          content,
          receipt,
          toolCall: { id: toolCallId, name: toolCallName, args: toolCallArgs }
        }
      }
      return { content, receipt }
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
        return { success: true, llmReceipt: phase1.receipt }
      }

      let finalReceipt = phase1.receipt

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
        const phase2 = await streamLLM(msgsWithTool, true)
        finalReceipt = phase2.receipt
      }

      return { success: true, llmReceipt: finalReceipt }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }
)

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
