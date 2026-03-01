<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onUnmounted, computed } from 'vue'
import {
  type Platform,
  detectPlatform,
  extractVideoId,
  validateUrl,
  getWebviewUrl,
  getWebviewSession,
  getFullscreenScript,
  getSeekScript,
  getSeekFallbackUrl,
} from './platform'
import { marked } from 'marked'

// 配置 marked：启用换行符转 <br>，禁用 mangle/headerIds（避免警告）
marked.use({ breaks: true, gfm: true })
import {
  IconSearch,
  IconPlayerPlay,
  IconClock,
  IconListDetails,
  IconLoader2,
  IconAlertCircle,
  IconVideo,
  IconChevronRight,
  IconFileText,
  IconChevronDown,
  IconChevronUp,
  IconBolt,
  IconEye,
  IconSquare,
  IconMessage,
  IconCornerDownRight,
  IconTrash,
  IconSend,
  IconX,
  IconSparkles,
  IconClipboard,
  IconHistory,
  IconStar
} from '@tabler/icons-vue'

// ─── 类型定义 ─────────────────────────────────────────────

interface TranscriptLine {
  time: string
  seconds: number
  text: string
}

interface TimelineChunk {
  id: string
  startTime: string
  endTime: string
  startSeconds: number
  endSeconds: number
  title: string
  summary: string
  keyPoints: string[]
  tags: string[]
  transcript: TranscriptLine[]
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  quotedChunk?: TimelineChunk
  streaming?: boolean
}

// ─── 应用版本 ─────────────────────────────────────────────

const appVersion = __APP_VERSION__

// ─── 状态 ─────────────────────────────────────────────────

const url = ref('')
const loading = ref(false)
const errorMsg = ref('')
const videoId = ref('')
const currentPlatform = ref<Platform | null>(null)
const videoUrl = ref('')
const progressLog = ref<string[]>([])
const timelineChunks = ref<TimelineChunk[]>([])
const activeChunkId = ref('')
const expandedIds = ref<string[]>([])
const expandedCardIds = ref<string[]>([])
const videoLoaded = ref(false)
const skipVideo = ref(true)

// ─── Phase 1: 智能 URL 检测 ────────────────────────────────

const clipboardDetectedUrl = ref('')
const showClipboardToast = ref(false)
let clipboardCheckTimer: number | null = null
let clipboardToastTimer: number | null = null

// ─── Phase 2: 历史管理 ────────────────────────────────────

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

const historyList = ref<HistoryItem[]>([])
const showHistoryPanel = ref(false)
const historySearch = ref('')

// ─── Phase 3: 时间轴搜索 ───────────────────────────────────

const searchQuery = ref('')
const searchInputRef = ref<HTMLInputElement | null>(null)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const webviewRef = ref<any>(null)

// Cookie 同步状态
const cookieStatus = ref<'idle' | 'loading' | 'ok' | 'fail'>('idle')
const cookieBrowser = ref('')

// YouTube Cookie 同步状态
const cookieYtStatus = ref<'idle' | 'loading' | 'ok' | 'fail'>('idle')
const cookieYtBrowser = ref('')

// 网页全屏状态
const isWebFullscreen = ref(false)

// 右侧面板 tab
const activeTab = ref<'timeline' | 'chat'>('timeline')

// 对话状态
const chatMessages = ref<ChatMessage[]>([])
const chatInput = ref('')
const chatLoading = ref(false)
const quotedChunk = ref<TimelineChunk | null>(null)
const chatScrollRef = ref<HTMLElement | null>(null)
const chatInputRef = ref<HTMLTextAreaElement | null>(null)

// ─── 计算属性 ─────────────────────────────────────────────

// 视频未解析完成时禁止对话
const chatDisabled = computed(() => !timelineChunks.value.length)

const latestProgress = computed(() => {
  for (let i = progressLog.value.length - 1; i >= 0; i--) {
    const line = progressLog.value[i].trim()
    if (line) return line
  }
  return '初始化中...'
})

const webviewSession = computed(() =>
  currentPlatform.value ? getWebviewSession(currentPlatform.value) : 'persist:bilibili'
)

const cookieCombinedStatus = computed(() => {
  if (cookieStatus.value === 'loading' || cookieYtStatus.value === 'loading') return 'loading'
  if (cookieStatus.value === 'ok' && cookieYtStatus.value === 'ok') return 'ok'
  if (cookieStatus.value === 'fail' || cookieYtStatus.value === 'fail') return 'warn'
  return 'idle'
})


// ─── 工具函数 ─────────────────────────────────────────────

function timeToSeconds(time: string): number {
  const parts = time.split(':').map(Number)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return 0
}

// ─── Markdown 解析器 ──────────────────────────────────────

function parseMarkdown(md: string): TimelineChunk[] {
  const chunks: TimelineChunk[] = []
  const lines = md.split('\n')
  let cur: Partial<TimelineChunk> | null = null
  let inKeyPoints = false
  let inTranscript = false

  const flush = (): void => {
    if (cur?.startTime) chunks.push(cur as TimelineChunk)
    cur = null
    inKeyPoints = false
    inTranscript = false
  }

  for (const line of lines) {
    const hm = line.match(/^## (\d{1,2}:\d{2}) - (\d{1,2}:\d{2}) \| (.+)$/)
    if (hm) {
      flush()
      cur = {
        id: `${hm[1]}-${hm[2]}`,
        startTime: hm[1],
        endTime: hm[2],
        startSeconds: timeToSeconds(hm[1]),
        endSeconds: timeToSeconds(hm[2]),
        title: hm[3].trim(),
        summary: '',
        keyPoints: [],
        tags: [],
        transcript: []
      }
      continue
    }

    if (!cur) continue

    const sm = line.match(/^\*\*一句话总结\*\*[：:](.+)$/)
    if (sm) {
      cur.summary = sm[1].trim()
      inKeyPoints = false
      inTranscript = false
      continue
    }

    if (line.startsWith('**核心观点**')) {
      inKeyPoints = true
      inTranscript = false
      continue
    }
    if (inKeyPoints && line.startsWith('- ')) {
      cur.keyPoints!.push(line.substring(2).trim())
      continue
    }

    const tm = line.match(/^\*\*标签\*\*[：:](.+)$/)
    if (tm) {
      cur.tags = (tm[1].match(/#[\w\u4e00-\u9fa5]+/g) ?? []).map((t) => t.slice(1))
      inKeyPoints = false
      inTranscript = false
      continue
    }

    if (line.startsWith('**原文记录**')) {
      inTranscript = true
      inKeyPoints = false
      continue
    }
    if (inTranscript) {
      const lm = line.match(/^\[(\d{1,2}:\d{2})\]\s+(.+)$/)
      if (lm) {
        cur.transcript!.push({
          time: lm[1],
          seconds: timeToSeconds(lm[1]),
          text: lm[2].trim()
        })
      }
      continue
    }

    if (line.startsWith('**') && inKeyPoints) {
      inKeyPoints = false
    }
  }

  flush()
  return chunks
}

// ─── webview：自动网页全屏 + 遮罩控制 ───────────────────

const HOLD_PLAY_SCRIPT = `
  (function() {
    if (window.__vsHoldActive) return;
    window.__vsHoldActive = true;
    const orig = HTMLMediaElement.prototype.play;
    window.__vsReleasePlay = function() {
      HTMLMediaElement.prototype.play = orig;
      window.__vsHoldActive = false;
      document.querySelectorAll('video').forEach(function(v) {
        orig.call(v).catch(function(){});
      });
    };
    HTMLMediaElement.prototype.play = function() { return Promise.resolve(); };
    document.querySelectorAll('video').forEach(function(v) { v.pause(); });
  })();
`

function injectWebFullscreen(wv: any): void {
  if (!currentPlatform.value) return

  const releaseScript = `if (window.__vsReleasePlay) window.__vsReleasePlay();`

  const showAndPlay = (): void => {
    isWebFullscreen.value = true
    if (currentPlatform.value === 'bilibili') {
      wv.executeJavaScript(releaseScript).catch(() => {})
    }
  }

  // 两平台统一：重试点击全屏/影院模式按钮
  const script = getFullscreenScript(currentPlatform.value)
  let retries = 0
  const attempt = (): void => {
    wv.executeJavaScript(script)
      .then((ok: boolean) => {
        if (ok) {
          showAndPlay()
        } else if (retries++ < 6) {
          setTimeout(attempt, 1500)
        } else {
          showAndPlay()
        }
      })
      .catch(() => showAndPlay())
  }
  setTimeout(attempt, 2000)
}

watch(videoId, async (newVal, oldVal) => {
  if (newVal !== oldVal) {
    isWebFullscreen.value = false
  }
  await nextTick()
  const wv = webviewRef.value
  if (!wv) return
  videoLoaded.value = false
  wv.addEventListener('did-finish-load', () => {
    videoLoaded.value = true
    // B 站需要先 hold 再全屏；YouTube watch 页由 injectWebFullscreen 直接处理
    if (currentPlatform.value === 'bilibili') {
      wv.executeJavaScript(HOLD_PLAY_SCRIPT).catch(() => {})
    }
    injectWebFullscreen(wv)
  }, { once: true })
})

// ─── 视频跳转 ─────────────────────────────────────────────

async function seekTo(seconds: number): Promise<void> {
  if (webviewRef.value && videoLoaded.value) {
    try {
      const ok = await webviewRef.value.executeJavaScript(getSeekScript(seconds))
      if (ok) return
    } catch {
      // 降级重载
    }
  }
  if (videoId.value && currentPlatform.value) {
    videoUrl.value = getSeekFallbackUrl(videoId.value, currentPlatform.value, seconds)
  }
}

function onChunkClick(chunk: TimelineChunk): void {
  activeChunkId.value = chunk.id
  seekTo(chunk.startSeconds)
}

function onTranscriptLineClick(line: TranscriptLine): void {
  seekTo(line.seconds)
}

// ─── 时间轴卡片展开/折叠 ─────────────────────────────────

function isExpanded(id: string): boolean {
  return expandedIds.value.includes(id)
}

function toggleTranscript(id: string): void {
  const idx = expandedIds.value.indexOf(id)
  if (idx >= 0) expandedIds.value.splice(idx, 1)
  else expandedIds.value.push(id)
}

function isCardExpanded(id: string): boolean {
  return expandedCardIds.value.includes(id)
}

function toggleCard(id: string): void {
  const idx = expandedCardIds.value.indexOf(id)
  if (idx >= 0) expandedCardIds.value.splice(idx, 1)
  else expandedCardIds.value.push(id)
}

// ─── 对话：辅助函数 ───────────────────────────────────────

async function scrollChatToBottom(): Promise<void> {
  await nextTick()
  if (chatScrollRef.value) {
    chatScrollRef.value.scrollTop = chatScrollRef.value.scrollHeight
  }
}

function autoResizeTextarea(e: Event): void {
  const el = e.target as HTMLTextAreaElement
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 112)}px` // max-h-28
}

function buildSystemPrompt(): string {
  if (!timelineChunks.value.length) {
    return '你是一个视频内容助手，帮助用户理解和分析视频内容。请用中文简洁回答。'
  }
  const chunks = timelineChunks.value
  const chunkSummaries = chunks
    .map((c) => `[${c.startTime}-${c.endTime}] ${c.title}：${c.summary}`)
    .join('\n')
  return `你是一个视频内容助手，帮助用户理解和分析当前视频内容。

视频时间轴（共 ${chunks.length} 个片段）：
${chunkSummaries}

请基于以上视频内容回答用户的问题，可以引用时间戳。如用户引用了特定片段，优先围绕该片段展开分析。回答请用中文，保持简洁准确。`
}

// ─── 对话：引用片段 ───────────────────────────────────────

function quoteChunk(chunk: TimelineChunk): void {
  quotedChunk.value = chunk
  activeTab.value = 'chat'
  nextTick(() => chatInputRef.value?.focus())
}

// ─── 对话：清空 ───────────────────────────────────────────

function clearChat(confirm = false): void {
  if (confirm && !window.confirm('确定清空全部对话记录？')) return
  chatMessages.value = []
  quotedChunk.value = null
}

// ─── Markdown 渲染 ────────────────────────────────────────

function renderMarkdown(content: string, streaming = false): string {
  if (!content) return ''
  let html = (marked.parse(content) as string).trim()
  if (streaming) {
    // 在最后一个 </p> 前插入光标，使其显示在段落文字末尾
    const lastP = html.lastIndexOf('</p>')
    const cursor = '<span class="md-cursor">▌</span>'
    html = lastP !== -1
      ? html.slice(0, lastP) + cursor + html.slice(lastP)
      : html + cursor
  }
  return html
}

// 构建引用片段的 LLM 上下文（含标题、总结、核心观点、原文片段）
function buildQuotedContent(chunk: TimelineChunk, userText: string): string {
  const lines: string[] = [
    `[引用片段 ${chunk.startTime}-${chunk.endTime}: ${chunk.title}]`
  ]
  if (chunk.summary) lines.push(`总结：${chunk.summary}`)
  if (chunk.keyPoints.length) lines.push(`核心观点：${chunk.keyPoints.join('；')}`)
  const transcriptPreview = chunk.transcript
    .slice(0, 5)
    .map((t) => `[${t.time}] ${t.text}`)
    .join('\n')
  if (transcriptPreview) lines.push(`原文片段：\n${transcriptPreview}`)
  lines.push('', userText)
  return lines.join('\n')
}

// ─── 对话：发送消息 ───────────────────────────────────────

async function sendChat(): Promise<void> {
  const text = chatInput.value.trim()
  if (!text || chatLoading.value || chatDisabled.value) return

  chatInput.value = ''
  const quoted = quotedChunk.value
  quotedChunk.value = null

  // 重置 textarea 高度
  if (chatInputRef.value) chatInputRef.value.style.height = 'auto'

  chatMessages.value.push({ role: 'user', content: text, quotedChunk: quoted ?? undefined })
  await scrollChatToBottom()

  chatLoading.value = true

  // 构建发给 API 的消息列表
  const apiMessages: { role: string; content: string }[] = [
    { role: 'system', content: buildSystemPrompt() },
    ...chatMessages.value.slice(0, -1).map((m) => ({
      role: m.role,
      content:
        m.role === 'user' && m.quotedChunk
          ? buildQuotedContent(m.quotedChunk, m.content)
          : m.content
    })),
    {
      role: 'user',
      content: quoted
        ? buildQuotedContent(quoted, text)
        : text
    }
  ]

  // 添加空助手消息，流式填充
  chatMessages.value.push({ role: 'assistant', content: '', streaming: true })
  const assistantIdx = chatMessages.value.length - 1
  await scrollChatToBottom()

  // 订阅流式 chunk，接近底部时自动跟随滚动
  const unsubscribeStream = window.api.onChatStreamChunk((delta) => {
    chatMessages.value[assistantIdx].content += delta
    if (chatScrollRef.value) {
      const el = chatScrollRef.value
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
        el.scrollTop = el.scrollHeight
      }
    }
  })

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (window.api as any).chatWithVideo !== 'function') {
      throw new Error('对话 API 不可用，请重启应用（执行 npm run dev 重新启动）')
    }
    const result = await window.api.chatWithVideo(apiMessages)
    // 流未收到任何内容才显示错误（如 API Key 无效）
    if (!result.success && result.error && !chatMessages.value[assistantIdx].content) {
      chatMessages.value[assistantIdx].content = `错误：${result.error}`
    }
  } catch (e) {
    if (!chatMessages.value[assistantIdx].content) {
      chatMessages.value[assistantIdx].content = `错误：${String(e)}`
    }
  } finally {
    unsubscribeStream()
    chatMessages.value[assistantIdx].streaming = false
    chatLoading.value = false
    await scrollChatToBottom()
  }
}

// ─── 解析视频 ─────────────────────────────────────────────

async function parseVideo(): Promise<void> {
  const validationError = validateUrl(url.value)
  if (validationError) {
    errorMsg.value = validationError
    return
  }
  const platform = detectPlatform(url.value.trim())!
  const id = extractVideoId(url.value.trim(), platform)!

  errorMsg.value = ''
  progressLog.value = []
  timelineChunks.value = []
  activeChunkId.value = ''
  expandedIds.value = []
  expandedCardIds.value = []
  loading.value = true

  // 先销毁当前 webview，停止后台播放
  videoId.value = ''
  videoUrl.value = ''
  videoLoaded.value = false
  isWebFullscreen.value = false
  await nextTick()

  currentPlatform.value = platform
  videoId.value = id
  videoUrl.value = getWebviewUrl(id, platform)

  // 解析新视频时自动清空对话
  clearChat()

  const unsubscribe = window.api.onParseProgress((line) => {
    progressLog.value.push(line.trimEnd())
    if (progressLog.value.length > 200) progressLog.value.shift()
  })

  try {
    const result = await window.api.parseVideo(videoUrl.value, { skipVideo: skipVideo.value })
    if (result.success && result.output) {
      timelineChunks.value = parseMarkdown(result.output)
      // 保存到历史记录
      await saveHistory(result.output)
    } else {
      errorMsg.value = result.error ?? '解析失败，请检查网络或 API Key 配置'
    }
  } catch (e) {
    errorMsg.value = String(e)
  } finally {
    loading.value = false
    unsubscribe()
  }
}

// ─── 停止解析 ─────────────────────────────────────────────

async function stopParse(): Promise<void> {
  await window.api.stopParse()
  loading.value = false
}

// ─── 剪贴板快速解析 ───────────────────────────────────────

async function pasteAndParse(): Promise<void> {
  let text = ''
  try {
    text = await navigator.clipboard.readText()
  } catch {
    errorMsg.value = '无法读取剪贴板，请手动粘贴链接'
    return
  }
  const validationError = validateUrl(text)
  if (validationError) {
    errorMsg.value = validationError
    return
  }
  url.value = text.trim()
  await parseVideo()
}

// ─── 阻止 webview 自动跳转到下一个视频 ───────────────────

// 层 1：普通导航拦截（外链、手动点击其他视频）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function preventAutoNext(e: any): void {
  if (!currentPlatform.value) return
  const targetId = extractVideoId(e.url ?? '', currentPlatform.value)
  if (targetId && targetId !== videoId.value) {
    e.preventDefault()
  }
}

// 层 2：SPA 内部跳转兜底（B 站连播通过 history.pushState 换视频）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function onWebviewNavigateInPage(e: any): void {
  if (!e.isMainFrame || currentPlatform.value !== 'bilibili') return
  const targetId = extractVideoId(e.url ?? '', 'bilibili')
  if (targetId && targetId !== videoId.value) {
    webviewRef.value?.loadURL(videoUrl.value)
  }
}

// 层 3：注入 JS，监听连播倒计时 DOM 出现后立即关闭
function onWebviewDomReady(): void {
  if (!webviewRef.value || currentPlatform.value !== 'bilibili') return
  webviewRef.value.executeJavaScript(`
    (function () {
      const CLOSE_SELECTORS = [
        '.bpx-player-follow-jump-close',
        '.bpx-player-ending-content-close',
        '.bpx-player-auto-next-container [class*="close"]',
        '.bpx-player-follow-jump [class*="cancel"]'
      ]
      new MutationObserver(() => {
        CLOSE_SELECTORS.forEach(sel => {
          const el = document.querySelector(sel)
          if (el && el.getBoundingClientRect().width > 0) el.click()
        })
      }).observe(document.body, { childList: true, subtree: true })
    })()
  `)
}

// ─── 历史管理 ──────────────────────────────────────────────

async function loadHistory(): Promise<void> {
  try {
    historyList.value = await window.api.getHistory()
  } catch {
    // 静默失败
  }
}

async function saveHistory(_output: string): Promise<void> {
  if (!currentPlatform.value || !videoId.value) return

  const title = timelineChunks.value[0]?.title || '未命名视频'
  try {
    await window.api.addHistory({
      url: url.value,
      title,
      platform: currentPlatform.value,
      mode: skipVideo.value ? 'asr' : 'visual',
      favorited: false
    })
    await loadHistory()
  } catch {
    // 静默失败
  }
}

async function toggleFavoriteHistory(id: string): Promise<void> {
  try {
    await window.api.toggleFavorite(id)
    await loadHistory()
  } catch {
    // 静默失败
  }
}

async function deleteHistoryItem(id: string): Promise<void> {
  try {
    await window.api.deleteHistory(id)
    await loadHistory()
  } catch {
    // 静默失败
  }
}

async function loadHistoryItem(item: HistoryItem): Promise<void> {
  url.value = item.url
  skipVideo.value = item.mode === 'asr'
  showHistoryPanel.value = false

  // 尝试加载已保存的输出文件
  if (item.outputPath) {
    try {
      const output = await window.api.readFile(item.outputPath)
      if (output) {
        timelineChunks.value = parseMarkdown(output)
        // 设置平台
        currentPlatform.value = item.platform
        videoId.value = extractVideoId(item.url, item.platform) || ''
        videoUrl.value = getWebviewUrl(videoId.value, item.platform)
        return
      }
    } catch {
      // 文件读取失败，重新解析
    }
  }

  // 没有缓存或读取失败，重新解析
  await parseVideo()
}

const filteredHistory = computed(() => {
  if (!historySearch.value.trim()) {
    return historyList.value
  }
  const query = historySearch.value.toLowerCase()
  return historyList.value.filter(
    (h) => h.title.toLowerCase().includes(query) || h.url.toLowerCase().includes(query)
  )
})

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))

  if (diffDays === 0) {
    return `今天 ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`
  }
  if (diffDays === 1) return '昨天'
  if (diffDays < 7) return `${diffDays} 天前`
  return `${date.getMonth() + 1}/${date.getDate()}`
}

function getPlatformIcon(platform: string): string {
  return platform === 'bilibili'
    ? 'https://www.bilibili.com/favicon.ico'
    : 'https://www.youtube.com/s/desktop/28b67e7f/img/favicon.ico'
}

// ─── 时间轴搜索 ────────────────────────────────────────────

const filteredChunks = computed(() => {
  if (!searchQuery.value.trim()) {
    return timelineChunks.value
  }

  const query = searchQuery.value.toLowerCase()

  return timelineChunks.value
    .filter((chunk) => {
      if (chunk.title.toLowerCase().includes(query)) return true
      if (chunk.summary.toLowerCase().includes(query)) return true
      if (chunk.keyPoints.some((kp) => kp.toLowerCase().includes(query))) return true
      if (chunk.transcript.some((t) => t.text.toLowerCase().includes(query))) return true
      if (chunk.tags.some((t) => t.toLowerCase().includes(query))) return true
      return false
    })
    .sort((a, b) => {
      // 按匹配度排序：标题 > 标签 > 核心观点 > 总结 > 原文
      const scoreA = calculateMatchScore(a, query)
      const scoreB = calculateMatchScore(b, query)
      return scoreB - scoreA
    })
})

function calculateMatchScore(chunk: TimelineChunk, query: string): number {
  let score = 0
  if (chunk.title.toLowerCase().includes(query)) score += 10
  if (chunk.tags.some((t) => t.toLowerCase().includes(query))) score += 8
  if (chunk.keyPoints.some((kp) => kp.toLowerCase().includes(query))) score += 5
  if (chunk.summary.toLowerCase().includes(query)) score += 3
  score += chunk.transcript.filter((t) => t.text.toLowerCase().includes(query)).length * 0.5
  return score
}

function highlightText(text: string, query: string): string {
  if (!query.trim()) return text
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`(${escaped})`, 'gi')
  return text.replace(regex, '<mark class="bg-yellow-200 rounded px-0.5">$1</mark>')
}

// ─── 自动导入浏览器 Cookie ────────────────────────────────

function getBrowserDisplayName(browser: string): string {
  const map: Record<string, string> = { edge: 'Edge', chrome: 'Chrome', firefox: 'Firefox', safari: 'Safari' }
  return map[browser] ?? browser
}

async function importBrowserCookies(): Promise<void> {
  cookieStatus.value = 'loading'
  const result = await window.api.importBrowserCookies()
  if (result.success && result.browser) {
    cookieStatus.value = 'ok'
    cookieBrowser.value = getBrowserDisplayName(result.browser)
  } else {
    cookieStatus.value = 'fail'
  }
}

async function importYoutubeCookies(): Promise<void> {
  cookieYtStatus.value = 'loading'
  const result = await window.api.importYoutubeCookies()
  if (result.success && result.browser) {
    cookieYtStatus.value = 'ok'
    cookieYtBrowser.value = getBrowserDisplayName(result.browser)
  } else {
    cookieYtStatus.value = 'fail'
  }
}

onMounted(() => {
  // 读取用户偏好
  const savedMode = localStorage.getItem('preferredParseMode')
  if (savedMode === 'visual') {
    skipVideo.value = false
  }

  // 启动剪贴板检测
  checkClipboard()
  clipboardCheckTimer = window.setInterval(checkClipboard, 1000)

  // 加载历史记录
  loadHistory()

  // 绑定拖拽事件
  window.addEventListener('dragover', handleDragOver)
  window.addEventListener('drop', handleDrop)

  // 绑定快捷键
  window.addEventListener('keydown', handleGlobalKeydown)

  importBrowserCookies()
  importYoutubeCookies()
})

onUnmounted(() => {
  if (clipboardCheckTimer) {
    clearInterval(clipboardCheckTimer)
  }
  if (clipboardToastTimer) {
    clearTimeout(clipboardToastTimer)
  }
  window.removeEventListener('dragover', handleDragOver)
  window.removeEventListener('drop', handleDrop)
  window.removeEventListener('keydown', handleGlobalKeydown)
})

// ─── 偏好记忆持久化 ────────────────────────────────────────

watch(skipVideo, (newVal) => {
  localStorage.setItem('preferredParseMode', newVal ? 'asr' : 'visual')
})

// ─── 智能 URL 检测 ─────────────────────────────────────────

async function checkClipboard(): Promise<void> {
  if (loading.value || showClipboardToast.value) return

  try {
    const text = await navigator.clipboard.readText()
    const trimmed = text.trim()

    // 已输入或已显示的链接不再提示
    if (trimmed === url.value || trimmed === clipboardDetectedUrl.value) return

    // 验证是否为有效视频链接（validateUrl 返回 null 表示验证通过）
    if (!validateUrl(trimmed)) {
      clipboardDetectedUrl.value = trimmed
      showClipboardToast.value = true

      // 5 秒后自动隐藏
      if (clipboardToastTimer) clearTimeout(clipboardToastTimer)
      clipboardToastTimer = window.setTimeout(() => {
        if (clipboardDetectedUrl.value === trimmed) {
          showClipboardToast.value = false
        }
      }, 5000)
    }
  } catch {
    // 剪贴板权限被拒绝，静默忽略
  }
}

async function acceptClipboardUrl(): Promise<void> {
  url.value = clipboardDetectedUrl.value
  showClipboardToast.value = false
  await parseVideo()
}

// ─── 拖拽支持 ──────────────────────────────────────────────

function handleDragOver(e: DragEvent): void {
  e.preventDefault()
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'copy'
  }
}

async function handleDrop(e: DragEvent): Promise<void> {
  e.preventDefault()
  const text = e.dataTransfer?.getData('text')
  if (text) {
    const trimmed = text.trim()
    if (!validateUrl(trimmed)) {
      errorMsg.value = '拖拽的内容不是有效的视频链接'
      return
    }
    url.value = trimmed
    await parseVideo()
  }
}

// ─── 全局快捷键 ────────────────────────────────────────────

function handleGlobalKeydown(e: KeyboardEvent): void {
  // / 键聚焦搜索（不在输入框时）
  if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) {
    e.preventDefault()
    searchInputRef.value?.focus()
  }
  // ESC 清除搜索
  if (e.key === 'Escape' && searchQuery.value) {
    searchQuery.value = ''
  }
}
</script>

<template>
  <div class="h-screen flex flex-col bg-white text-slate-900 select-none overflow-hidden">

    <!-- ── 顶部栏 ── -->
    <header class="shrink-0 flex items-center gap-2.5 px-4 py-2 border-b border-slate-200 bg-white">
      <!-- Logo -->
      <div class="flex items-center gap-1.5 shrink-0">
        <IconVideo class="w-4 h-4 text-blue-500" />
        <div class="flex flex-col leading-none">
          <span class="text-sm font-bold text-slate-800 tracking-tight">VidStudio</span>
          <div class="flex items-baseline gap-1">
            <span class="text-[10px] text-slate-400 tracking-wide">视析工作站</span>
            <span class="text-[9px] text-slate-300">v{{ appVersion }}</span>
          </div>
        </div>
      </div>

      <div class="w-px h-4 bg-slate-200 mx-0.5" />

      <!-- URL 输入框 -->
      <div
        class="flex items-center gap-2 flex-1 bg-slate-50 rounded-lg px-3 py-1.5 border border-slate-200 focus-within:border-blue-400 focus-within:bg-white transition-colors"
      >
        <IconSearch class="w-3.5 h-3.5 text-slate-400 shrink-0" />
        <input
          v-model="url"
          placeholder="粘贴 B 站 / YouTube 视频链接..."
          class="flex-1 bg-transparent outline-none text-sm text-slate-800 placeholder:text-slate-400"
          @keydown.enter="parseVideo"
        />
      </div>

      <!-- 解析模式选择器 -->
      <div class="shrink-0 flex bg-slate-100 rounded-lg p-[3px] gap-[2px]">
        <button
          @click="skipVideo = true"
          :class="skipVideo ? 'bg-white shadow-sm text-slate-800 font-medium' : 'text-slate-400 hover:text-slate-600'"
          class="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs transition-all duration-150"
          title="仅通过字幕/语音转文字解析，速度快"
        >
          <IconBolt class="w-3.5 h-3.5" :class="skipVideo ? 'text-blue-500' : ''" />
          仅 ASR 解读
        </button>
        <button
          @click="skipVideo = false"
          :class="!skipVideo ? 'bg-white shadow-sm text-slate-800 font-medium' : 'text-slate-400 hover:text-slate-600'"
          class="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs transition-all duration-150"
          title="额外使用 GLM-4V 对视频画面逐帧理解，更准确但耗时更长"
        >
          <IconEye class="w-3.5 h-3.5" :class="!skipVideo ? 'text-amber-500' : ''" />
          视觉精析
        </button>
      </div>

      <!-- 浏览器账号状态（B站 + YouTube 合并） -->
      <div class="relative group/cookie shrink-0">
        <div class="w-7 h-7 flex items-center justify-center rounded-md bg-slate-50 border border-slate-200 cursor-default transition-colors group-hover/cookie:bg-slate-100">
          <!-- 加载中：统一转圈 -->
          <IconLoader2 v-if="cookieCombinedStatus === 'loading'" class="w-3.5 h-3.5 text-slate-400 animate-spin" />
          <!-- 加载完成：B站 和 YouTube 各一个状态点 -->
          <div v-else class="flex flex-col gap-[3px]">
            <div class="flex items-center gap-[3px]">
              <span class="text-[6px] font-bold text-slate-400 leading-none w-[7px]">B</span>
              <div
                class="w-[6px] h-[6px] rounded-full"
                :class="cookieStatus === 'ok' ? 'bg-emerald-500' : cookieStatus === 'fail' ? 'bg-amber-400' : 'bg-slate-300'"
              />
            </div>
            <div class="flex items-center gap-[3px]">
              <span class="text-[6px] font-bold text-slate-400 leading-none w-[7px]">Y</span>
              <div
                class="w-[6px] h-[6px] rounded-full"
                :class="cookieYtStatus === 'ok' ? 'bg-emerald-500' : cookieYtStatus === 'fail' ? 'bg-amber-400' : 'bg-slate-300'"
              />
            </div>
          </div>
        </div>
        <div class="absolute top-full right-0 mt-2 w-max max-w-[300px] px-3 py-2.5 bg-slate-800 rounded-xl shadow-xl opacity-0 group-hover/cookie:opacity-100 transition-opacity duration-150 pointer-events-none z-50">
          <p class="text-xs font-medium text-white leading-snug mb-1.5">浏览器账号</p>
          <div class="flex flex-col gap-1">
            <div class="flex items-center gap-1.5">
              <div class="w-1.5 h-1.5 rounded-full flex-shrink-0" :class="cookieStatus === 'ok' ? 'bg-emerald-500' : cookieStatus === 'fail' ? 'bg-amber-400' : 'bg-slate-500'" />
              <span class="text-[11px] leading-snug" :class="cookieStatus === 'ok' ? 'text-slate-200' : 'text-slate-400'">
                B站：{{ cookieStatus === 'ok' ? `已登录（${cookieBrowser}）` : cookieStatus === 'fail' ? '未检测到账号' : '检测中...' }}
              </span>
            </div>
            <div class="flex items-center gap-1.5">
              <div class="w-1.5 h-1.5 rounded-full flex-shrink-0" :class="cookieYtStatus === 'ok' ? 'bg-emerald-500' : cookieYtStatus === 'fail' ? 'bg-amber-400' : 'bg-slate-500'" />
              <span class="text-[11px] leading-snug" :class="cookieYtStatus === 'ok' ? 'text-slate-200' : 'text-slate-400'">
                YouTube：{{ cookieYtStatus === 'ok' ? `已登录（${cookieYtBrowser}）` : cookieYtStatus === 'fail' ? '未检测到账号' : '检测中...' }}
              </span>
            </div>
          </div>
          <p v-if="cookieStatus === 'fail' || cookieYtStatus === 'fail'" class="text-[10px] text-slate-500 mt-1.5 leading-snug">
            请先在 Edge / Chrome / Firefox / Safari 中登录
          </p>
          <div class="absolute bottom-full right-2.5 border-[5px] border-transparent border-b-slate-800" />
        </div>
      </div>

      <!-- 历史记录按钮 -->
      <div class="relative shrink-0">
        <button
          @click="showHistoryPanel = !showHistoryPanel"
          class="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg border border-slate-200 text-slate-400 hover:text-blue-500 hover:bg-blue-50 transition-colors"
          :class="showHistoryPanel ? 'text-blue-500 bg-blue-50 border-blue-200' : ''"
          title="解析历史"
        >
          <IconHistory class="w-4 h-4" />
        </button>

        <!-- 历史下拉面板 -->
        <div
          v-if="showHistoryPanel"
          class="absolute top-full right-0 mt-2 w-80 max-h-96 bg-white rounded-xl shadow-xl border border-slate-200 z-50 overflow-hidden flex flex-col"
        >
          <!-- 搜索框 -->
          <div class="p-2 border-b border-slate-100">
            <div class="relative">
              <IconSearch class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
              <input
                v-model="historySearch"
                placeholder="搜索历史..."
                class="w-full pl-8 pr-3 py-1.5 bg-slate-50 rounded-lg text-sm outline-none focus:bg-slate-100"
              />
            </div>
          </div>

          <!-- 历史列表 -->
          <div class="flex-1 overflow-y-auto p-1">
            <div
              v-for="item in filteredHistory"
              :key="item.id"
              @click="loadHistoryItem(item)"
              class="flex items-center gap-2 p-2 rounded-lg hover:bg-slate-50 cursor-pointer group"
            >
              <!-- 平台图标 -->
              <img
                :src="getPlatformIcon(item.platform)"
                class="w-5 h-5 rounded"
                @error="(e) => { const t = e.target as HTMLImageElement; if (t) t.style.display='none' }"
              />

              <!-- 信息 -->
              <div class="flex-1 min-w-0">
                <p class="text-sm text-slate-800 truncate">{{ item.title }}</p>
                <div class="flex items-center gap-1.5 text-xs text-slate-400">
                  <span>{{ formatTime(item.createdAt) }}</span>
                  <span class="text-slate-200">·</span>
                  <span :class="item.mode === 'asr' ? 'text-blue-400' : 'text-amber-400'">
                    {{ item.mode === 'asr' ? 'ASR' : '视觉' }}
                  </span>
                </div>
              </div>

              <!-- 操作按钮 -->
              <button
                @click.stop="toggleFavoriteHistory(item.id)"
                class="opacity-0 group-hover:opacity-100 p-1 transition-opacity"
              >
                <IconStar
                  :class="item.favorited ? 'text-amber-400 fill-current' : 'text-slate-300'"
                  class="w-4 h-4"
                />
              </button>
              <button
                @click.stop="deleteHistoryItem(item.id)"
                class="opacity-0 group-hover:opacity-100 p-1 text-slate-300 hover:text-red-400 transition-opacity"
              >
                <IconTrash class="w-4 h-4" />
              </button>
            </div>

            <!-- 空状态 -->
            <div v-if="filteredHistory.length === 0" class="p-4 text-center">
              <p class="text-sm text-slate-400">暂无历史记录</p>
            </div>
          </div>
        </div>
      </div>

      <!-- 解析 / 停止 按钮 -->
      <button
        v-if="!loading"
        @click="parseVideo"
        class="shrink-0 flex items-center gap-1.5 px-4 py-1.5 bg-blue-500 hover:bg-blue-600 active:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors shadow-sm"
      >
        <IconPlayerPlay class="w-4 h-4" />
        一键解析
      </button>
      <button
        v-else
        @click="stopParse"
        class="shrink-0 flex items-center gap-1.5 px-4 py-1.5 bg-red-500 hover:bg-red-600 active:bg-red-700 text-white text-sm font-medium rounded-lg transition-colors shadow-sm"
      >
        <IconSquare class="w-4 h-4" />
        停止解析
      </button>

      <!-- 剪贴板快速解析 -->
      <button
        @click="pasteAndParse"
        :disabled="loading"
        class="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg border border-slate-200 transition-colors"
        :class="loading ? 'text-slate-200 cursor-not-allowed' : 'text-slate-400 hover:text-blue-500 hover:bg-blue-50'"
        title="从剪贴板粘贴链接并解析"
      >
        <IconClipboard class="w-4 h-4" />
      </button>
    </header>

    <!-- ── 错误提示 ── -->
    <div
      v-if="errorMsg"
      class="shrink-0 flex items-center gap-2 px-4 py-2 bg-red-50 text-red-600 text-sm border-b border-red-200"
    >
      <IconAlertCircle class="w-4 h-4 shrink-0" />
      {{ errorMsg }}
    </div>

    <!-- ── 主体 ── -->
    <main class="flex-1 flex overflow-hidden">

      <!-- 左：视频播放器 -->
      <div class="flex-1 bg-slate-100 flex items-center justify-center relative min-w-0 overflow-hidden">
        <webview
          v-if="videoId"
          ref="webviewRef"
          :src="videoUrl"
          :partition="webviewSession"
          class="w-full h-full"
          allowpopups="true"
          useragent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0"
          @will-navigate="preventAutoNext"
          @did-navigate-in-page="onWebviewNavigateInPage"
          @dom-ready="onWebviewDomReady"
        />

        <!-- 空状态 -->
        <div v-if="!videoId" class="text-center pointer-events-none">
          <IconVideo class="w-16 h-16 mx-auto mb-3 text-slate-300" />
          <p class="text-sm font-medium text-slate-400">输入 B 站 / YouTube 链接，一键解析</p>
          <p class="text-xs text-slate-300 mt-1">支持 B 站 BV 号 · YouTube 视频链接</p>
        </div>

        <!-- 遮罩：全屏激活前隐藏初始加载页面 -->
        <Transition
          enter-active-class="transition-opacity duration-300"
          leave-active-class="transition-opacity duration-500"
          enter-from-class="opacity-0"
          leave-to-class="opacity-0"
        >
          <div
            v-if="videoId && !isWebFullscreen"
            class="absolute inset-0 bg-slate-100 flex flex-col items-center justify-center gap-3 z-10"
          >
            <div class="w-9 h-9 rounded-full border-[2.5px] border-slate-200 border-t-blue-400 animate-spin" />
            <p class="text-sm text-slate-500 font-medium">正在加载视频...</p>
          </div>
        </Transition>
      </div>

      <!-- 右：时间轴 / 对话 -->
      <aside class="w-[380px] shrink-0 flex flex-col border-l border-slate-200 bg-slate-50">

        <!-- Tab 标题栏 -->
        <div class="shrink-0 flex items-center border-b border-slate-200 bg-white">
          <button
            @click="activeTab = 'timeline'"
            class="flex items-center gap-1.5 px-4 py-2.5 text-sm border-b-2 transition-colors"
            :class="activeTab === 'timeline'
              ? 'border-blue-500 text-blue-600 font-medium'
              : 'border-transparent text-slate-400 hover:text-slate-600'"
          >
            <IconListDetails class="w-4 h-4" />
            时间轴
            <span
              v-if="timelineChunks.length"
              class="text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded-full"
            >{{ timelineChunks.length }}</span>
          </button>

          <button
            @click="activeTab = 'chat'"
            class="flex items-center gap-1.5 px-4 py-2.5 text-sm border-b-2 transition-colors"
            :class="activeTab === 'chat'
              ? 'border-blue-500 text-blue-600 font-medium'
              : 'border-transparent text-slate-400 hover:text-slate-600'"
          >
            <IconMessage class="w-4 h-4" />
            对话
            <span
              v-if="chatMessages.length"
              class="text-[10px] bg-blue-500 text-white px-1.5 py-0.5 rounded-full min-w-[18px] text-center"
            >{{ chatMessages.length }}</span>
          </button>

          <!-- 清空对话按钮（仅对话 tab 且有消息时显示） -->
          <button
            v-if="activeTab === 'chat' && chatMessages.length"
            @click="clearChat(true)"
            class="ml-auto mr-3 p-1.5 text-slate-300 hover:text-red-400 hover:bg-red-50 rounded-md transition-colors"
            title="清空对话"
          >
            <IconTrash class="w-3.5 h-3.5" />
          </button>
        </div>

        <!-- ── 时间轴面板 ── -->
        <div v-show="activeTab === 'timeline'" class="flex-1 flex flex-col overflow-hidden">

          <!-- 空状态 -->
          <div
            v-if="!loading && !timelineChunks.length"
            class="flex-1 flex flex-col items-center justify-center gap-2"
          >
            <IconClock class="w-10 h-10 text-slate-200" />
            <p class="text-sm text-slate-400">解析后将显示结构化时间轴</p>
            <p class="text-xs text-slate-300">点击时间点可跳转到视频对应位置</p>
          </div>

          <!-- 解析中：默认简洁，悬停展开完整日志 -->
          <div
            v-else-if="loading && !timelineChunks.length"
            class="group flex-1 relative overflow-hidden cursor-default"
          >
            <div
              class="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 transition-all duration-200 group-hover:opacity-0 group-hover:scale-95 pointer-events-none"
            >
              <div class="w-8 h-8 rounded-full border-[2.5px] border-slate-200 border-t-blue-400 animate-spin" />
              <div class="text-center space-y-1.5">
                <p class="text-sm font-medium text-slate-700">正在解析视频内容</p>
                <p class="text-xs text-slate-400 max-w-[200px] truncate">{{ latestProgress }}</p>
              </div>
              <p class="text-[10px] text-slate-300 mt-1">悬停查看详细进度</p>
            </div>
            <div
              class="absolute inset-0 flex flex-col opacity-0 group-hover:opacity-100 translate-y-3 group-hover:translate-y-0 transition-all duration-200 ease-out bg-slate-50"
            >
              <div class="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-slate-200 bg-white">
                <div class="w-3 h-3 rounded-full border-[1.5px] border-slate-200 border-t-blue-400 animate-spin shrink-0" />
                <span class="text-xs font-medium text-slate-600">解析进度</span>
                <span class="ml-auto text-[10px] text-slate-400">{{ progressLog.length }} 行</span>
              </div>
              <div class="flex-1 overflow-y-auto px-4 py-3 font-mono text-[10px] leading-5 text-slate-400 space-y-0.5">
                <div
                  v-for="(line, i) in progressLog"
                  :key="i"
                  class="break-all whitespace-pre-wrap"
                  :class="i === progressLog.length - 1 ? 'text-slate-700 font-medium' : ''"
                >{{ line }}</div>
                <div class="h-4" />
              </div>
            </div>
          </div>

          <!-- 搜索框 -->
          <div
            v-if="timelineChunks.length"
            class="shrink-0 px-3 py-2 border-b border-slate-200 bg-white"
          >
            <div class="relative">
              <IconSearch class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
              <input
                ref="searchInputRef"
                v-model="searchQuery"
                placeholder="搜索时间轴（/ 快捷键）..."
                class="w-full pl-8 pr-7 py-1.5 bg-slate-50 rounded-lg text-sm outline-none focus:bg-slate-100 transition-colors"
              />
              <button
                v-if="searchQuery"
                @click="searchQuery = ''"
                class="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <IconX class="w-3.5 h-3.5" />
              </button>
            </div>
            <div v-if="searchQuery" class="mt-1.5 text-xs text-slate-400">
              找到 {{ filteredChunks.length }} 个结果
            </div>
          </div>

          <!-- 时间轴列表 -->
          <div v-else class="flex-1 overflow-y-auto">
            <div class="px-3 py-3 space-y-2">
              <div
                v-for="chunk in filteredChunks"
                :key="chunk.id"
                class="rounded-xl border overflow-hidden bg-white transition-all"
                :class="
                  activeChunkId === chunk.id
                    ? 'border-blue-300 shadow-sm shadow-blue-100'
                    : 'border-slate-200 hover:border-slate-300 hover:shadow-sm'
                "
              >
                <!-- 卡片主体 -->
                <div class="p-3">
                  <!-- 时间戳行（点击跳转） -->
                  <div
                    class="flex items-center gap-1.5 mb-1.5 cursor-pointer group"
                    @click="onChunkClick(chunk)"
                  >
                    <div
                      class="w-1.5 h-1.5 rounded-full shrink-0"
                      :class="activeChunkId === chunk.id ? 'bg-blue-500' : 'bg-slate-300'"
                    />
                    <span
                      class="text-[11px] font-mono"
                      :class="activeChunkId === chunk.id ? 'text-blue-500' : 'text-slate-400'"
                    >{{ chunk.startTime }} → {{ chunk.endTime }}</span>
                    <IconChevronRight class="w-3 h-3 text-slate-300 ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>

                  <!-- 标题 -->
                  <h3
                    class="text-sm font-semibold leading-snug mb-1.5 cursor-pointer"
                    :class="[
                      activeChunkId === chunk.id ? 'text-blue-700' : 'text-slate-800',
                      isCardExpanded(chunk.id) ? '' : 'line-clamp-2'
                    ]"
                    @click="onChunkClick(chunk)"
                    v-html="highlightText(chunk.title, searchQuery)"
                  />

                  <!-- 一句话总结 -->
                  <p
                    v-if="chunk.summary"
                    class="text-xs text-slate-500 mb-2 leading-relaxed"
                    :class="isCardExpanded(chunk.id) ? '' : 'line-clamp-2'"
                    v-html="highlightText(chunk.summary, searchQuery)"
                  />

                  <!-- 核心观点 -->
                  <ul v-if="chunk.keyPoints.length" class="space-y-1 mb-2">
                    <li
                      v-for="(pt, i) in (isCardExpanded(chunk.id) ? chunk.keyPoints : chunk.keyPoints.slice(0, 3))"
                      :key="i"
                      class="flex items-start gap-1.5 text-xs text-slate-500"
                    >
                      <span class="text-blue-400 mt-0.5 shrink-0 leading-none">·</span>
                      <span
                        class="leading-snug"
                        :class="isCardExpanded(chunk.id) ? '' : 'line-clamp-1'"
                        v-html="highlightText(pt, searchQuery)"
                      />
                    </li>
                  </ul>

                  <!-- 标签 -->
                  <div v-if="chunk.tags.length" class="flex flex-wrap gap-1 mb-2">
                    <span
                      v-for="tag in chunk.tags.slice(0, 4)"
                      :key="tag"
                      class="text-[10px] px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-400 border border-slate-200"
                      v-html="highlightText(tag, searchQuery)"
                    />
                  </div>

                  <!-- 底部操作行：展开 + 引用 -->
                  <div class="flex items-center justify-between mt-1">
                    <button
                      class="text-[11px] text-blue-500 hover:text-blue-700 transition-colors"
                      @click.stop="toggleCard(chunk.id)"
                    >
                      {{ isCardExpanded(chunk.id) ? '收起 ↑' : '展开全文 ↓' }}
                    </button>
                    <button
                      class="flex items-center gap-1 text-[11px] text-slate-400 hover:text-blue-500 transition-colors"
                      title="引用此片段到对话"
                      @click.stop="quoteChunk(chunk)"
                    >
                      <IconCornerDownRight class="w-3 h-3" />
                      引用
                    </button>
                  </div>
                </div>

                <!-- 原文记录折叠 -->
                <div v-if="chunk.transcript.length">
                  <button
                    class="w-full flex items-center gap-1.5 px-3 py-2 text-[11px] text-slate-400 hover:text-slate-600 border-t border-slate-100 hover:bg-slate-50 transition-colors"
                    @click.stop="toggleTranscript(chunk.id)"
                  >
                    <IconFileText class="w-3 h-3 shrink-0" />
                    <span>原文记录（{{ chunk.transcript.length }} 句）</span>
                    <IconChevronDown v-if="!isExpanded(chunk.id)" class="w-3 h-3 ml-auto" />
                    <IconChevronUp v-else class="w-3 h-3 ml-auto" />
                  </button>

                  <div
                    v-if="isExpanded(chunk.id)"
                    class="border-t border-slate-100 bg-slate-50/80 max-h-52 overflow-y-auto"
                  >
                    <div
                      v-for="(line, i) in chunk.transcript"
                      :key="i"
                      class="flex items-start gap-2 px-3 py-1.5 hover:bg-slate-100 cursor-pointer group/line transition-colors"
                      @click.stop="onTranscriptLineClick(line)"
                    >
                      <span class="text-[10px] font-mono text-blue-400/70 group-hover/line:text-blue-500 shrink-0 mt-0.5 transition-colors">
                        {{ line.time }}
                      </span>
                      <span class="text-[11px] text-slate-500 leading-relaxed">{{ line.text }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- ── 对话面板 ── -->
        <div v-show="activeTab === 'chat'" class="flex-1 flex flex-col overflow-hidden">

          <!-- 消息列表 -->
          <div ref="chatScrollRef" class="flex-1 overflow-y-auto px-3 py-3 space-y-3">

            <!-- 空状态 -->
            <div
              v-if="!chatMessages.length && !chatLoading"
              class="h-full flex flex-col items-center justify-center gap-2 min-h-[200px]"
            >
              <IconMessage class="w-10 h-10 text-slate-200" />
              <template v-if="loading">
                <p class="text-sm text-slate-400">视频解析中...</p>
                <p class="text-xs text-slate-300">解析完成后即可与内容对话</p>
              </template>
              <template v-else-if="chatDisabled">
                <p class="text-sm text-slate-400">请先解析视频</p>
                <p class="text-xs text-slate-300">解析完成后可与内容对话</p>
              </template>
              <template v-else>
                <p class="text-sm text-slate-400">与视频内容对话</p>
                <p class="text-xs text-slate-300">在时间轴中点击「引用」可带入片段上下文</p>
              </template>
            </div>

            <!-- 消息气泡 -->
            <div
              v-for="(msg, i) in chatMessages"
              :key="i"
              class="flex gap-2"
              :class="msg.role === 'user' ? 'justify-end' : 'justify-start'"
            >
              <!-- 助手头像 -->
              <div
                v-if="msg.role === 'assistant'"
                class="w-6 h-6 rounded-full bg-blue-50 flex items-center justify-center shrink-0 mt-0.5"
              >
                <IconSparkles class="w-3.5 h-3.5 text-blue-400" />
              </div>

              <div class="max-w-[85%]">
                <!-- 引用片段标注 -->
                <div
                  v-if="msg.quotedChunk"
                  class="mb-1 px-2.5 py-2 bg-blue-50 border-l-2 border-blue-300 rounded-r-lg"
                >
                  <p class="text-[10px] text-blue-400 font-mono mb-0.5">{{ msg.quotedChunk.startTime }} - {{ msg.quotedChunk.endTime }}</p>
                  <p class="text-[11px] text-blue-700 font-semibold leading-snug">{{ msg.quotedChunk.title }}</p>
                  <p v-if="msg.quotedChunk.summary" class="text-[10px] text-blue-600/70 mt-0.5 leading-relaxed line-clamp-2">{{ msg.quotedChunk.summary }}</p>
                  <ul v-if="msg.quotedChunk.keyPoints.length" class="mt-1 space-y-0.5">
                    <li
                      v-for="(pt, i) in msg.quotedChunk.keyPoints.slice(0, 2)"
                      :key="i"
                      class="text-[10px] text-blue-500/70 leading-snug line-clamp-1"
                    >· {{ pt }}</li>
                  </ul>
                </div>

                <!-- 气泡 -->
                <!-- 用户消息：纯文本 -->
                <div
                  v-if="msg.role === 'user'"
                  class="px-3 py-2 text-sm leading-relaxed bg-blue-500 text-white rounded-2xl rounded-tr-sm"
                >
                  <p class="whitespace-pre-wrap">{{ msg.content }}</p>
                </div>
                <!-- 助手消息：Markdown 渲染 + 流式光标 -->
                <div
                  v-else
                  class="px-3 py-2 text-sm bg-white text-slate-700 border border-slate-200 rounded-2xl rounded-tl-sm"
                >
                  <!-- 等待第一个 chunk 时显示三点动画 -->
                  <div v-if="msg.streaming && !msg.content" class="flex items-center gap-1.5 py-0.5">
                    <div class="w-1.5 h-1.5 rounded-full bg-slate-300 animate-bounce [animation-delay:0ms]" />
                    <div class="w-1.5 h-1.5 rounded-full bg-slate-300 animate-bounce [animation-delay:150ms]" />
                    <div class="w-1.5 h-1.5 rounded-full bg-slate-300 animate-bounce [animation-delay:300ms]" />
                  </div>
                  <!-- 有内容时渲染 Markdown（流式状态带光标） -->
                  <div
                    v-else
                    class="markdown-body"
                    v-html="renderMarkdown(msg.content, msg.streaming)"
                  />
                </div>
              </div>
            </div>

          </div>

          <!-- 引用预览（输入框上方） -->
          <div
            v-if="quotedChunk"
            class="shrink-0 mx-3 mb-2 px-3 py-2.5 bg-blue-50 rounded-xl border border-blue-100"
          >
            <div class="flex items-start gap-2">
              <div class="flex-1 min-w-0">
                <p class="text-[10px] text-blue-400 font-mono mb-0.5">{{ quotedChunk.startTime }} - {{ quotedChunk.endTime }}</p>
                <p class="text-xs text-blue-700 font-semibold leading-snug">{{ quotedChunk.title }}</p>
                <p v-if="quotedChunk.summary" class="text-[11px] text-blue-600/80 mt-1 leading-relaxed line-clamp-2">{{ quotedChunk.summary }}</p>
                <ul v-if="quotedChunk.keyPoints.length" class="mt-1 space-y-0.5">
                  <li
                    v-for="(pt, i) in quotedChunk.keyPoints.slice(0, 2)"
                    :key="i"
                    class="text-[10px] text-blue-500/70 leading-snug line-clamp-1"
                  >· {{ pt }}</li>
                </ul>
              </div>
              <button
                @click="quotedChunk = null"
                class="shrink-0 text-blue-300 hover:text-blue-500 transition-colors"
              >
                <IconX class="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <!-- 输入区 -->
          <div class="shrink-0 p-3 border-t border-slate-200 bg-white">
            <div
              class="flex items-end gap-2 rounded-xl border px-3 py-2.5 transition-colors"
              :class="chatDisabled
                ? 'bg-slate-50 border-slate-200'
                : 'bg-slate-50 border-slate-200 focus-within:border-blue-400 focus-within:bg-white'"
            >
              <textarea
                ref="chatInputRef"
                v-model="chatInput"
                :placeholder="loading ? '视频解析中，请稍候...' : chatDisabled ? '请先解析视频' : '询问视频内容...'"
                :disabled="chatDisabled"
                rows="2"
                class="flex-1 bg-transparent outline-none text-sm resize-none max-h-28 leading-relaxed"
                :class="chatDisabled
                  ? 'text-slate-300 placeholder:text-slate-300 cursor-not-allowed'
                  : 'text-slate-800 placeholder:text-slate-400'"
                @keydown.enter.exact.prevent="sendChat"
                @input="autoResizeTextarea"
              />
              <button
                @click="sendChat"
                :disabled="!chatInput.trim() || chatLoading || chatDisabled"
                class="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg transition-colors"
                :class="
                  chatInput.trim() && !chatLoading && !chatDisabled
                    ? 'bg-blue-500 hover:bg-blue-600 text-white'
                    : 'bg-slate-200 text-slate-400 cursor-not-allowed'
                "
              >
                <IconSend class="w-3.5 h-3.5" />
              </button>
            </div>
            <p class="text-[10px] text-slate-300 mt-1.5 text-center">Enter 发送 · Shift+Enter 换行</p>
          </div>
        </div>

      </aside>
    </main>

    <!-- 剪贴板检测 Toast -->
    <Transition
      enter-from-class="opacity-0 translate-x-4"
      enter-active-class="transition duration-300"
      leave-to-class="opacity-0 translate-x-4"
      leave-active-class="transition duration-200"
    >
      <div
        v-if="showClipboardToast"
        class="fixed top-4 right-4 z-50 flex items-center gap-3 px-4 py-3 bg-slate-800 text-white rounded-lg shadow-xl"
      >
        <IconClipboard class="w-4 h-4 text-blue-400" />
        <div class="flex flex-col">
          <span class="text-sm font-medium">检测到视频链接</span>
          <span class="text-xs text-slate-400 truncate max-w-[200px]">{{ clipboardDetectedUrl }}</span>
        </div>
        <button
          @click="acceptClipboardUrl"
          class="ml-2 px-3 py-1.5 bg-blue-500 hover:bg-blue-600 rounded text-xs font-medium transition-colors"
        >
          立即解析
        </button>
        <button
          @click="showClipboardToast = false"
          class="p-1 text-slate-400 hover:text-white transition-colors"
        >
          <IconX class="w-4 h-4" />
        </button>
      </div>
    </Transition>
  </div>
</template>

<style>
/* ── 助手消息 Markdown 样式（v-html 内容不受 scoped 限制） ── */
.markdown-body { font-size: 0.875rem; line-height: 1.625; word-break: break-word; }
.markdown-body > *:first-child { margin-top: 0 !important; }
.markdown-body > *:last-child { margin-bottom: 0 !important; }
.markdown-body p { margin: 0 0 0.5em; }
.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4 {
  font-weight: 600; line-height: 1.3; margin: 0.75em 0 0.3em;
}
.markdown-body h1 { font-size: 1.1em; }
.markdown-body h2 { font-size: 1.05em; }
.markdown-body h3, .markdown-body h4 { font-size: 1em; }
.markdown-body ul, .markdown-body ol { padding-left: 1.4em; margin: 0.4em 0; }
.markdown-body li { margin: 0.2em 0; }
.markdown-body li > p { margin: 0; }
.markdown-body code {
  background: rgba(0, 0, 0, 0.07); padding: 0.15em 0.35em;
  border-radius: 4px; font-size: 0.82em; font-family: ui-monospace, 'Cascadia Code', monospace;
}
.markdown-body pre {
  background: rgba(0, 0, 0, 0.06); padding: 0.75em 1em;
  border-radius: 8px; overflow-x: auto; margin: 0.5em 0;
}
.markdown-body pre code { background: none; padding: 0; font-size: 0.83em; }
.markdown-body blockquote {
  border-left: 3px solid #94a3b8; padding-left: 0.75em;
  color: #64748b; margin: 0.5em 0;
}
.markdown-body blockquote > p { margin: 0; }
.markdown-body a { color: #3b82f6; text-decoration: underline; }
.markdown-body hr { border: none; border-top: 1px solid #e2e8f0; margin: 0.75em 0; }
.markdown-body table { border-collapse: collapse; width: 100%; margin: 0.5em 0; font-size: 0.85em; }
.markdown-body th, .markdown-body td { border: 1px solid #e2e8f0; padding: 0.35em 0.6em; text-align: left; }
.markdown-body th { background: rgba(0, 0, 0, 0.04); font-weight: 600; }
.markdown-body strong { font-weight: 600; }
.markdown-body em { font-style: italic; }

/* 流式光标 */
.md-cursor { animation: md-cursor-blink 0.8s step-end infinite; }
@keyframes md-cursor-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
</style>
