<script setup lang="ts">
import { ref, watch, nextTick, onMounted, computed } from 'vue'
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
  IconCircleCheck,
  IconCircleX,
  IconSquare
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

// ─── 状态 ─────────────────────────────────────────────────

const url = ref('')
const loading = ref(false)
const errorMsg = ref('')
const bvid = ref('')
const videoUrl = ref('')
const progressLog = ref<string[]>([])
const timelineChunks = ref<TimelineChunk[]>([])
const activeChunkId = ref('')
const expandedIds = ref<string[]>([])      // 原文记录展开
const expandedCardIds = ref<string[]>([])  // 卡片正文展开
const videoLoaded = ref(false)
const skipVideo = ref(true)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const webviewRef = ref<any>(null)

// Cookie 同步状态
const cookieStatus = ref<'idle' | 'loading' | 'ok' | 'fail'>('idle')
const cookieBrowser = ref('')

// 网页全屏状态：控制遮罩层（隐藏初始加载的非全屏页面）
const isWebFullscreen = ref(false)

// ─── 计算属性 ─────────────────────────────────────────────

const latestProgress = computed(() => {
  for (let i = progressLog.value.length - 1; i >= 0; i--) {
    const line = progressLog.value[i].trim()
    if (line) return line
  }
  return '初始化中...'
})

// Cookie 状态 tooltip 内容（两行：标题 + 说明）
const cookieTooltip = computed((): [string, string] => {
  if (cookieStatus.value === 'ok')
    return [`已用 ${cookieBrowser.value} 账号登录 B 站`, '视频将以最高画质播放，无需手动登录']
  if (cookieStatus.value === 'fail')
    return ['未检测到 B 站登录信息', '请先在 Edge 或 Chrome 中登录 B 站，再重启此应用']
  return ['正在读取浏览器登录状态...', '']
})

// ─── 工具函数 ─────────────────────────────────────────────

function extractBvid(rawUrl: string): string | null {
  const m = rawUrl.match(/BV[a-zA-Z0-9]+/)
  return m ? m[0] : null
}

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

// 注入：劫持 play()，让视频在全屏前保持暂停
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

// 注入：全屏 + 释放播放
function injectWebFullscreen(wv: any): void {
  const fullscreenScript = `
    (function() {
      var selectors = [
        '.bpx-player-ctrl-web',
        '.squirtle-pagefullscreen-icon',
        '[data-key="web-full-screen"]'
      ];
      for (var i = 0; i < selectors.length; i++) {
        var btn = document.querySelector(selectors[i]);
        if (btn) { btn.click(); return true; }
      }
      return false;
    })()
  `
  const releaseScript = `if (window.__vsReleasePlay) window.__vsReleasePlay();`

  const showAndPlay = (): void => {
    isWebFullscreen.value = true
    wv.executeJavaScript(releaseScript).catch(() => {})
  }

  let retries = 0
  const attempt = (): void => {
    wv.executeJavaScript(fullscreenScript)
      .then((ok: boolean) => {
        if (ok) {
          showAndPlay()
        } else if (retries++ < 6) {
          setTimeout(attempt, 1500)
        } else {
          // 超出重试：直接显示并播放（避免永久卡在遮罩）
          showAndPlay()
        }
      })
      .catch(() => showAndPlay())
  }
  setTimeout(attempt, 2000)
}

watch(bvid, async (newVal, oldVal) => {
  if (newVal !== oldVal) {
    isWebFullscreen.value = false
  }
  await nextTick()
  const wv = webviewRef.value
  if (!wv) return
  videoLoaded.value = false
  wv.addEventListener('did-finish-load', () => {
    videoLoaded.value = true
    // 先注入播放拦截，再尝试全屏
    wv.executeJavaScript(HOLD_PLAY_SCRIPT).catch(() => {})
    injectWebFullscreen(wv)
  })
})

// ─── 视频跳转 ─────────────────────────────────────────────

async function seekTo(seconds: number): Promise<void> {
  if (webviewRef.value && videoLoaded.value) {
    try {
      const ok = await webviewRef.value.executeJavaScript(
        `(function(){
          const v = document.querySelector('video');
          if (v) { v.currentTime = ${seconds}; v.play(); return true; }
          return false;
        })()`
      )
      if (ok) return
    } catch {
      // 降级重载
    }
  }
  videoUrl.value = `https://www.bilibili.com/video/${bvid.value}?t=${seconds}`
}

function onChunkClick(chunk: TimelineChunk): void {
  activeChunkId.value = chunk.id
  seekTo(chunk.startSeconds)
}

function onTranscriptLineClick(line: TranscriptLine): void {
  seekTo(line.seconds)
}

// ─── 原文展开/折叠 ───────────────────────────────────────

// 原文折叠
function isExpanded(id: string): boolean {
  return expandedIds.value.includes(id)
}

function toggleTranscript(id: string): void {
  const idx = expandedIds.value.indexOf(id)
  if (idx >= 0) expandedIds.value.splice(idx, 1)
  else expandedIds.value.push(id)
}

// 卡片正文展开
function isCardExpanded(id: string): boolean {
  return expandedCardIds.value.includes(id)
}

function toggleCard(id: string): void {
  const idx = expandedCardIds.value.indexOf(id)
  if (idx >= 0) expandedCardIds.value.splice(idx, 1)
  else expandedCardIds.value.push(id)
}

// ─── 解析视频 ─────────────────────────────────────────────

async function parseVideo(): Promise<void> {
  const id = extractBvid(url.value)
  if (!id) {
    errorMsg.value = '请输入有效的 B 站视频链接（需包含 BV 号）'
    return
  }

  errorMsg.value = ''
  progressLog.value = []
  timelineChunks.value = []
  activeChunkId.value = ''
  expandedIds.value = []
  expandedCardIds.value = []
  loading.value = true
  videoLoaded.value = false
  isWebFullscreen.value = false
  bvid.value = id
  videoUrl.value = `https://www.bilibili.com/video/${id}`

  const unsubscribe = window.api.onParseProgress((line) => {
    progressLog.value.push(line.trimEnd())
    if (progressLog.value.length > 200) progressLog.value.shift()
  })

  try {
    const result = await window.api.parseVideo(url.value, { skipVideo: skipVideo.value })
    if (result.success && result.output) {
      timelineChunks.value = parseMarkdown(result.output)
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

// ─── 自动导入浏览器 Cookie ────────────────────────────────

async function importBrowserCookies(): Promise<void> {
  cookieStatus.value = 'loading'
  const result = await window.api.importBrowserCookies()
  if (result.success && result.browser) {
    cookieStatus.value = 'ok'
    cookieBrowser.value = result.browser === 'edge' ? 'Edge' : 'Chrome'
  } else {
    cookieStatus.value = 'fail'
  }
}

onMounted(() => {
  importBrowserCookies()
})
</script>

<template>
  <div class="h-screen flex flex-col bg-white text-slate-900 select-none overflow-hidden">

    <!-- ── 顶部栏 ── -->
    <header class="shrink-0 flex items-center gap-2.5 px-4 py-2 border-b border-slate-200 bg-white">
      <!-- Logo -->
      <div class="flex items-center gap-1.5 shrink-0">
        <IconVideo class="w-4 h-4 text-blue-500" />
        <span class="text-sm font-semibold text-slate-800">VidStudio</span>
      </div>

      <div class="w-px h-4 bg-slate-200 mx-0.5" />

      <!-- URL 输入框 -->
      <div
        class="flex items-center gap-2 flex-1 bg-slate-50 rounded-lg px-3 py-1.5 border border-slate-200 focus-within:border-blue-400 focus-within:bg-white transition-colors"
      >
        <IconSearch class="w-3.5 h-3.5 text-slate-400 shrink-0" />
        <input
          v-model="url"
          placeholder="粘贴 B 站视频链接..."
          class="flex-1 bg-transparent outline-none text-sm text-slate-800 placeholder:text-slate-400"
          @keydown.enter="parseVideo"
        />
      </div>

      <!-- 分段选择器：解析模式 -->
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

      <!-- 浏览器账号状态：固定尺寸图标 + 自定义 tooltip -->
      <div class="relative group/cookie shrink-0">
        <div class="w-7 h-7 flex items-center justify-center rounded-md bg-slate-50 border border-slate-200 cursor-default transition-colors group-hover/cookie:bg-slate-100">
          <IconLoader2 v-if="cookieStatus === 'loading'" class="w-3.5 h-3.5 text-slate-400 animate-spin" />
          <IconCircleCheck v-else-if="cookieStatus === 'ok'" class="w-3.5 h-3.5 text-emerald-500" />
          <IconCircleX v-else-if="cookieStatus === 'fail'" class="w-3.5 h-3.5 text-amber-400" />
        </div>
        <!-- 自定义 tooltip：hover 显示，向下展开 -->
        <div class="absolute top-full right-0 mt-2 w-max max-w-[260px] px-3 py-2.5 bg-slate-800 rounded-xl shadow-xl opacity-0 group-hover/cookie:opacity-100 transition-opacity duration-150 pointer-events-none z-50">
          <p class="text-xs font-medium text-white leading-snug">{{ cookieTooltip[0] }}</p>
          <p v-if="cookieTooltip[1]" class="text-[11px] text-slate-400 mt-1 leading-snug">{{ cookieTooltip[1] }}</p>
          <!-- 上箭头 -->
          <div class="absolute bottom-full right-2.5 border-[5px] border-transparent border-b-slate-800" />
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
          v-if="bvid"
          ref="webviewRef"
          :src="videoUrl"
          partition="persist:bilibili"
          class="w-full h-full"
          allowpopups="true"
          useragent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0"
        />

        <!-- 空状态（未输入链接） -->
        <div v-if="!bvid" class="text-center pointer-events-none">
          <IconVideo class="w-16 h-16 mx-auto mb-3 text-slate-300" />
          <p class="text-sm font-medium text-slate-400">输入 B 站链接，一键解析</p>
          <p class="text-xs text-slate-300 mt-1">支持 BV 号格式</p>
        </div>

        <!-- 遮罩：隐藏网页全屏激活前的初始加载页面，避免用户看到/交互未全屏内容 -->
        <Transition
          enter-active-class="transition-opacity duration-300"
          leave-active-class="transition-opacity duration-500"
          enter-from-class="opacity-0"
          leave-to-class="opacity-0"
        >
          <div
            v-if="bvid && !isWebFullscreen"
            class="absolute inset-0 bg-slate-100 flex flex-col items-center justify-center gap-3 z-10"
          >
            <div class="w-9 h-9 rounded-full border-[2.5px] border-slate-200 border-t-blue-400 animate-spin" />
            <p class="text-sm text-slate-500 font-medium">正在加载视频...</p>
          </div>
        </Transition>
      </div>

      <!-- 右：知识时间轴 -->
      <aside class="w-[380px] shrink-0 flex flex-col border-l border-slate-200 bg-slate-50">
        <!-- 标题栏 -->
        <div class="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-slate-200 bg-white">
          <IconListDetails class="w-4 h-4 text-blue-500" />
          <span class="text-sm font-semibold text-slate-700">知识时间轴</span>
          <span
            v-if="timelineChunks.length"
            class="ml-auto text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full"
          >
            {{ timelineChunks.length }} 片段
          </span>
        </div>

        <!-- 空状态 -->
        <div
          v-if="!loading && !timelineChunks.length"
          class="flex-1 flex flex-col items-center justify-center gap-2"
        >
          <IconClock class="w-10 h-10 text-slate-200" />
          <p class="text-sm text-slate-400">解析后将显示结构化时间轴</p>
          <p class="text-xs text-slate-300">点击时间点可跳转到视频对应位置</p>
        </div>

        <!-- 解析中：Apple 风格 — 默认简洁，悬停展开完整日志 -->
        <div
          v-else-if="loading && !timelineChunks.length"
          class="group flex-1 relative overflow-hidden cursor-default"
        >
          <!-- 默认视图：居中 spinner + 最新进度 -->
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

          <!-- 悬停视图：完整日志从下方滑入 -->
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

        <!-- 时间轴列表 -->
        <div v-else class="flex-1 overflow-y-auto">
          <div class="px-3 py-3 space-y-2">
            <div
              v-for="chunk in timelineChunks"
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

                <!-- 标题（折叠时最多 2 行） -->
                <h3
                  class="text-sm font-semibold leading-snug mb-1.5 cursor-pointer"
                  :class="[
                    activeChunkId === chunk.id ? 'text-blue-700' : 'text-slate-800',
                    isCardExpanded(chunk.id) ? '' : 'line-clamp-2'
                  ]"
                  @click="onChunkClick(chunk)"
                >{{ chunk.title }}</h3>

                <!-- 一句话总结（折叠时最多 2 行） -->
                <p
                  v-if="chunk.summary"
                  class="text-xs text-slate-500 mb-2 leading-relaxed"
                  :class="isCardExpanded(chunk.id) ? '' : 'line-clamp-2'"
                >{{ chunk.summary }}</p>

                <!-- 核心观点（折叠时最多 3 条且每条 1 行） -->
                <ul v-if="chunk.keyPoints.length" class="space-y-1 mb-2">
                  <li
                    v-for="(pt, i) in (isCardExpanded(chunk.id) ? chunk.keyPoints : chunk.keyPoints.slice(0, 3))"
                    :key="i"
                    class="flex items-start gap-1.5 text-xs text-slate-500"
                  >
                    <span class="text-blue-400 mt-0.5 shrink-0 leading-none">·</span>
                    <span class="leading-snug" :class="isCardExpanded(chunk.id) ? '' : 'line-clamp-1'">{{ pt }}</span>
                  </li>
                </ul>

                <!-- 标签 -->
                <div v-if="chunk.tags.length" class="flex flex-wrap gap-1 mb-2">
                  <span
                    v-for="tag in chunk.tags.slice(0, 4)"
                    :key="tag"
                    class="text-[10px] px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-400 border border-slate-200"
                  >{{ tag }}</span>
                </div>

                <!-- 展开 / 收起（居中） -->
                <div class="flex justify-center mt-1">
                  <button
                    class="text-[11px] text-blue-500 hover:text-blue-700 transition-colors"
                    @click.stop="toggleCard(chunk.id)"
                  >
                    {{ isCardExpanded(chunk.id) ? '收起 ↑' : '展开全文 ↓' }}
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
      </aside>
    </main>
  </div>
</template>
