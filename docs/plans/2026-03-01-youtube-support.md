# YouTube 视频链接支持实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为 vid-studio 添加 YouTube 视频链接支持，含 webview 嵌入播放、Cookie 导入、自动语言检测字幕。

**Architecture:** 新建 `platform.ts` 平台工具模块集中管理所有平台差异（URL 校验、webview URL、session、注入脚本），App.vue 调用统一接口；后端 downloader 根据 yt-dlp 返回的视频语言动态构建字幕优先列表；`extract_cookies.py` 增加 `--site` 参数支持提取 YouTube Cookie。

**Tech Stack:** Electron + Vue 3 + TypeScript（前端）；Python 3 + yt-dlp（后端）

---

## Task 1：后端 — extract_cookies.py 增加 --site 参数

**Files:**
- Modify: `vid-engine/extract_cookies.py`

**Step 1: 替换域名过滤逻辑**

将 `BILIBILI_DOMAINS` 常量替换为 `SITE_DOMAINS` 字典，并更新过滤和 CLI URL：

```python
# 删除：
BILIBILI_DOMAINS = ('bilibili', 'bilivideo', 'hdslb', 'biliimg')

def _is_bilibili(domain: str) -> bool:
    return any(d in domain for d in BILIBILI_DOMAINS)

# 新增：
SITE_DOMAINS = {
    'bilibili': ('bilibili', 'bilivideo', 'hdslb', 'biliimg'),
    'youtube': ('youtube', 'ytimg', 'googlevideo', 'yt'),
}

SITE_SEED_URLS = {
    'bilibili': 'https://www.bilibili.com/',
    'youtube': 'https://www.youtube.com/',
}

def _is_target_site(domain: str, site: str) -> bool:
    return any(d in domain for d in SITE_DOMAINS[site])
```

**Step 2: 更新 extract_via_api 和 extract_via_cli**

`extract_via_api` 签名改为 `extract_via_api(browser: str, site: str) -> list`，过滤行改为：
```python
cookies = [_cookie_to_dict(c) for c in ydl.cookiejar if _is_target_site(c.domain, site)]
```

`extract_via_cli` 签名改为 `extract_via_cli(browser: str, site: str) -> list`，CLI 调用中的 seed URL 改为：
```python
SITE_SEED_URLS[site],
```
过滤行改为：
```python
return [_cookie_to_dict(c) for c in jar if _is_target_site(c.domain, site)]
```

**Step 3: 更新 main() 解析 --site 参数**

```python
def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('browser', nargs='?', default=None)
    parser.add_argument('--site', choices=['bilibili', 'youtube'], default='bilibili')
    args = parser.parse_args()

    browsers = [args.browser] if args.browser else ['edge', 'chrome']
    site = args.site

    for browser in browsers:
        for extractor in (extract_via_api, extract_via_cli):
            try:
                cookies = extractor(browser, site)
                if cookies:
                    print(json.dumps({
                        'success': True,
                        'browser': browser,
                        'count': len(cookies),
                        'cookies': cookies,
                    }))
                    return
            except Exception:
                continue

    site_name = 'B 站' if site == 'bilibili' else 'YouTube'
    print(json.dumps({
        'success': False,
        'error': f'未在 Edge 或 Chrome 中找到 {site_name} 登录信息，请先在浏览器中登录',
    }))
```

**Step 4: 手动验证（B 站）**

```bash
cd vid-engine
python extract_cookies.py --site bilibili
# 预期：JSON 输出，success: true，cookies 列表中域名含 bilibili
```

**Step 5: 手动验证（YouTube，无需登录也应输出 success: false）**

```bash
python extract_cookies.py --site youtube
# 预期：输出 JSON，不报 argparse 错误
```

**Step 6: Commit**

```bash
git add vid-engine/extract_cookies.py
git commit -m "feat(backend): extract_cookies.py 增加 --site 参数支持 YouTube"
```

---

## Task 2：后端 — models.py 增加 language 字段

**Files:**
- Modify: `vid-engine/src/models.py`

**Step 1: 在 VideoMeta 末尾增加 language 字段**

```python
@dataclass
class VideoMeta:
    """视频元信息"""
    id: str
    title: str
    duration: int  # 秒
    uploader: str
    language: str = ''  # yt-dlp 返回的视频主语言代码，如 "en"、"zh"
```

**Step 2: Commit**

```bash
git add vid-engine/src/models.py
git commit -m "feat(backend): VideoMeta 增加 language 字段"
```

---

## Task 3：后端 — downloader.py 动态字幕语言列表

**Files:**
- Modify: `vid-engine/src/downloader.py`

**Step 1: 替换静态 _SUBTITLE_LANGS 为动态构建函数**

删除文件顶部：
```python
# B站字幕语言优先级
_SUBTITLE_LANGS = ["zh-Hans", "zh-CN", "zh", "en"]
```

新增函数（放在 `_build_cookie_opts` 之前）：
```python
def _build_subtitle_langs(primary_lang: str) -> list:
    """根据视频主语言动态构建字幕语言优先列表"""
    if not primary_lang or primary_lang.startswith('zh'):
        return ['zh-Hans', 'zh-CN', 'zh-TW', 'zh', 'en']
    # 非中文：原语言优先，备选中文和英文
    base = [primary_lang, 'zh-Hans', 'zh-CN', 'en']
    seen: set = set()
    return [lang for lang in base if not (lang in seen or seen.add(lang))]  # type: ignore[func-returns-value]
```

**Step 2: 更新 get_video_meta 读取 language**

```python
def get_video_meta(self, url: str) -> VideoMeta:
    """获取视频元信息（不下载文件）"""
    opts = {**self._base_opts(), "extract_flat": False}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
        return VideoMeta(
            id=info.get("id", ""),
            title=info.get("title", "未知标题"),
            duration=int(info.get("duration") or 0),
            uploader=info.get("uploader", ""),
            language=info.get("language", "") or "",
        )
```

**Step 3: 更新 download_subtitle 接收 primary_lang 参数**

```python
def download_subtitle(self, url: str, primary_lang: str = '') -> Optional[str]:
    """尝试下载字幕，返回 .vtt 文件路径，失败返回 None"""
    langs = _build_subtitle_langs(primary_lang)
    for write_subs, write_auto in [(True, False), (False, True)]:
        result = self._try_download_subtitle(url, write_subs, write_auto, langs)
        if result:
            return result
    return None
```

**Step 4: 更新 _try_download_subtitle 接收 langs 参数**

```python
def _try_download_subtitle(
    self, url: str, write_subs: bool, write_auto: bool, langs: list
) -> Optional[str]:
    """执行一次字幕下载尝试"""
    outtmpl = str(self.work_dir / "%(id)s.%(ext)s")
    opts = {
        **self._base_opts(),
        "skip_download": True,
        "writesubtitles": write_subs,
        "writeautomaticsub": write_auto,
        "subtitleslangs": langs,
        "subtitlesformat": "vtt/json3/best",
        "convertsubtitles": "vtt",
        "outtmpl": outtmpl,
    }

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            video_id = info.get("id", "")

        for lang in langs:
            vtt_path = self.work_dir / f"{video_id}.{lang}.vtt"
            if vtt_path.exists() and vtt_path.stat().st_size > 0:
                return str(vtt_path)

        vtt_files = [
            f for f in self.work_dir.glob("*.vtt") if f.stat().st_size > 0
        ]
        if vtt_files:
            return str(vtt_files[0])

    except Exception:
        pass

    return None
```

**Step 5: Commit**

```bash
git add vid-engine/src/downloader.py
git commit -m "feat(backend): downloader 根据视频主语言动态构建字幕优先列表"
```

---

## Task 4：后端 — pipeline.py 传递 language 给 _get_segments

**Files:**
- Modify: `vid-engine/src/pipeline.py`

**Step 1: 更新 _get_segments 签名增加 primary_lang**

```python
def _get_segments(
    downloader: VideoDownloader, url: str, primary_lang: str = ''
) -> List[SubtitleSegment]:
    """
    获取字幕片段：优先下载字幕，否则走 ASR
    """
    subtitle_file = downloader.download_subtitle(url, primary_lang)
    # 其余代码不变
    ...
```

**Step 2: 更新 run() 中 _get_segments 的两处调用**

找到两处 `_get_segments(downloader, url)` 调用，均改为 `_get_segments(downloader, url, meta.language)`：

```python
# skip_video 分支（约第 169 行）
segments = _get_segments(downloader, url, meta.language)

# 并行分支（约第 178 行）
seg_future = executor.submit(_get_segments, downloader, url, meta.language)
```

**Step 3: 手动验证（可选，需要有 YouTube URL）**

```bash
cd vid-engine
python main.py "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --skip-video -o /tmp/test_yt.txt
# 预期：正常运行，无 TypeError
```

**Step 4: Commit**

```bash
git add vid-engine/src/pipeline.py
git commit -m "feat(backend): pipeline 传递视频语言给字幕下载器"
```

---

## Task 5：前端 — 新建 platform.ts 平台工具模块

**Files:**
- Create: `src/renderer/src/platform.ts`

**Step 1: 创建文件，写入完整实现**

```typescript
// src/renderer/src/platform.ts
// 平台工具模块：集中管理 B 站 / YouTube 的 URL 识别、webview 配置、注入脚本

export type Platform = 'bilibili' | 'youtube'

// ─── URL 识别 ─────────────────────────────────────────────

export function detectPlatform(url: string): Platform | null {
  const u = url.trim()
  if (/bilibili\.com|BV[a-zA-Z0-9]+/.test(u)) return 'bilibili'
  if (/youtube\.com\/watch|youtu\.be\//.test(u)) return 'youtube'
  return null
}

export function extractVideoId(url: string, platform: Platform): string | null {
  if (platform === 'bilibili') {
    const m = url.match(/BV[a-zA-Z0-9]+/)
    return m ? m[0] : null
  }
  // youtube.com/watch?v=xxx 或 youtu.be/xxx（11 位 ID）
  let m = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/)
  if (m) return m[1]
  m = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/)
  return m ? m[1] : null
}

export function validateUrl(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return '请输入视频链接'
  const platform = detectPlatform(trimmed)
  if (!platform) return '链接不合法，请输入 B 站或 YouTube 视频链接'
  if (!extractVideoId(trimmed, platform)) return '无法提取视频 ID，请检查链接格式'
  return null
}

// ─── webview 配置 ─────────────────────────────────────────

export function getWebviewUrl(videoId: string, platform: Platform): string {
  if (platform === 'bilibili') return `https://www.bilibili.com/video/${videoId}`
  return `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0`
}

export function getWebviewSession(platform: Platform): string {
  return platform === 'bilibili' ? 'persist:bilibili' : 'persist:youtube'
}

// ─── 注入脚本 ─────────────────────────────────────────────

/** B 站网页全屏按钮注入脚本；YouTube embed 填满 webview，直接返回 true */
export function getFullscreenScript(platform: Platform): string {
  if (platform === 'youtube') return '(function(){ return true; })()'
  return `
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
}

/** 两平台通用：直接操作 video 元素的 currentTime */
export function getSeekScript(seconds: number): string {
  return `
    (function(){
      const v = document.querySelector('video');
      if (v) { v.currentTime = ${seconds}; v.play(); return true; }
      return false;
    })()
  `
}

/** 时间跳转降级 URL（无法通过 JS 跳转时重新加载） */
export function getSeekFallbackUrl(videoId: string, platform: Platform, seconds: number): string {
  if (platform === 'bilibili') return `https://www.bilibili.com/video/${videoId}?t=${seconds}`
  return `https://www.youtube.com/embed/${videoId}?autoplay=1&start=${seconds}`
}
```

**Step 2: 验证 TypeScript 类型检查**

```bash
npm run typecheck
# 预期：无错误
```

**Step 3: Commit**

```bash
git add src/renderer/src/platform.ts
git commit -m "feat(frontend): 新建 platform.ts 平台工具模块"
```

---

## Task 6：前端 — preload/index.ts 暴露 importYoutubeCookies

**Files:**
- Modify: `src/preload/index.ts`

**Step 1: 在 api 对象中追加 importYoutubeCookies**

在 `importBrowserCookies` 行之后，紧接着添加：

```typescript
// 启动时从 Edge/Chrome 导入 YouTube cookies
importYoutubeCookies: (): Promise<CookieImportResult> =>
  ipcRenderer.invoke('import-youtube-cookies'),
```

**Step 2: 验证类型检查**

```bash
npm run typecheck
# 预期：无错误
```

**Step 3: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(preload): 暴露 importYoutubeCookies IPC 接口"
```

---

## Task 7：前端 — index.ts 新增 import-youtube-cookies IPC handler

**Files:**
- Modify: `src/main/index.ts`

**Step 1: 在 import-browser-cookies handler 之后添加 YouTube Cookie handler**

```typescript
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
```

**Step 2: 验证类型检查**

```bash
npm run typecheck
# 预期：无错误
```

**Step 3: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(main): 新增 import-youtube-cookies IPC handler"
```

---

## Task 8：前端 — App.vue Script 部分改造

**Files:**
- Modify: `src/renderer/src/App.vue`（script 部分）

**Step 1: 导入 platform.ts**

在 `import { ref, watch, ... } from 'vue'` 之后添加：

```typescript
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
```

**Step 2: 将 bvid ref 替换为 videoId，并新增 currentPlatform**

```typescript
// 删除：
const bvid = ref('')

// 新增：
const videoId = ref('')
const currentPlatform = ref<Platform | null>(null)
```

**Step 3: 新增 webviewSession 计算属性**

在 `latestProgress` 等计算属性附近添加：

```typescript
const webviewSession = computed(() =>
  currentPlatform.value ? getWebviewSession(currentPlatform.value) : 'persist:bilibili'
)
```

**Step 4: 删除旧工具函数，更新 seekTo**

删除：
```typescript
function extractBvid(rawUrl: string): string | null { ... }
function validateBilibiliUrl(rawUrl: string): string | null { ... }
```

更新 `seekTo`：
```typescript
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
```

**Step 5: 更新 parseVideo()**

```typescript
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
```

**Step 6: 更新 watch(videoId, ...) 及 injectWebFullscreen**

将 `watch(bvid, ...)` 改为 `watch(videoId, ...)`，并在 `did-finish-load` 回调中对平台判断：

```typescript
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
    // YouTube embed 自带 autoplay，无需 hold；B 站需要先 hold 再全屏
    if (currentPlatform.value === 'bilibili') {
      wv.executeJavaScript(HOLD_PLAY_SCRIPT).catch(() => {})
    }
    injectWebFullscreen(wv)
  })
})
```

更新 `injectWebFullscreen`：

```typescript
function injectWebFullscreen(wv: any): void {
  if (!currentPlatform.value) return

  const script = getFullscreenScript(currentPlatform.value)
  const releaseScript = `if (window.__vsReleasePlay) window.__vsReleasePlay();`

  const showAndPlay = (): void => {
    isWebFullscreen.value = true
    if (currentPlatform.value === 'bilibili') {
      wv.executeJavaScript(releaseScript).catch(() => {})
    }
  }

  // YouTube embed 立即填满 webview，直接标记可见
  if (currentPlatform.value === 'youtube') {
    showAndPlay()
    return
  }

  // B 站：重试点击网页全屏按钮
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
```

**Step 7: 更新导航拦截函数**

```typescript
function preventAutoNext(e: any): void {
  if (!currentPlatform.value) return
  const targetId = extractVideoId(e.url ?? '', currentPlatform.value)
  if (targetId && targetId !== videoId.value) {
    e.preventDefault()
  }
}

function onWebviewNavigateInPage(e: any): void {
  if (!e.isMainFrame || currentPlatform.value !== 'bilibili') return
  const targetId = extractVideoId(e.url ?? '', 'bilibili')
  if (targetId && targetId !== videoId.value) {
    webviewRef.value?.loadURL(videoUrl.value)
  }
}

function onWebviewDomReady(): void {
  if (!webviewRef.value || currentPlatform.value !== 'bilibili') return
  // 以下 B 站特定代码不变
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
```

**Step 8: 新增 YouTube Cookie 状态 ref 及函数**

```typescript
const cookieYtStatus = ref<'idle' | 'loading' | 'ok' | 'fail'>('idle')
const cookieYtBrowser = ref('')

const cookieYtTooltip = computed((): [string, string] => {
  if (cookieYtStatus.value === 'ok')
    return [`已用 ${cookieYtBrowser.value} 账号登录 YouTube`, '']
  if (cookieYtStatus.value === 'fail')
    return ['未检测到 YouTube 登录信息', '请先在 Edge 或 Chrome 中登录 YouTube']
  return ['正在读取 YouTube 登录状态...', '']
})

async function importYoutubeCookies(): Promise<void> {
  cookieYtStatus.value = 'loading'
  const result = await window.api.importYoutubeCookies()
  if (result.success && result.browser) {
    cookieYtStatus.value = 'ok'
    cookieYtBrowser.value = result.browser === 'edge' ? 'Edge' : 'Chrome'
  } else {
    cookieYtStatus.value = 'fail'
  }
}
```

**Step 9: 更新 onMounted 并行导入两个平台 Cookie**

```typescript
onMounted(() => {
  importBrowserCookies()
  importYoutubeCookies()
})
```

**Step 10: 更新 pasteAndParse**

```typescript
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
```

**Step 11: 验证类型检查**

```bash
npm run typecheck
# 预期：无错误
```

**Step 12: Commit（script 部分）**

```bash
git add src/renderer/src/App.vue
git commit -m "feat(renderer): App.vue script 改造支持双平台"
```

---

## Task 9：前端 — App.vue Template 部分改造

**Files:**
- Modify: `src/renderer/src/App.vue`（template 部分）

**Step 1: 更新 URL 输入框 placeholder**

```html
<!-- 修改前 -->
placeholder="粘贴 B 站视频链接..."

<!-- 修改后 -->
placeholder="粘贴 B 站 / YouTube 视频链接..."
```

**Step 2: 在 B 站 Cookie 指示器旁新增 YouTube Cookie 指示器**

在现有 `<div class="relative group/cookie shrink-0">` 块之后（解析按钮之前）添加：

```html
<!-- YouTube 账号状态 -->
<div class="relative group/cookie-yt shrink-0">
  <div class="w-7 h-7 flex items-center justify-center rounded-md bg-slate-50 border border-slate-200 cursor-default transition-colors group-hover/cookie-yt:bg-slate-100">
    <IconLoader2 v-if="cookieYtStatus === 'loading'" class="w-3.5 h-3.5 text-slate-400 animate-spin" />
    <IconCircleCheck v-else-if="cookieYtStatus === 'ok'" class="w-3.5 h-3.5 text-emerald-500" />
    <IconCircleX v-else-if="cookieYtStatus === 'fail'" class="w-3.5 h-3.5 text-amber-400" />
    <span v-else class="text-[10px] font-bold text-slate-400">YT</span>
  </div>
  <div class="absolute top-full right-0 mt-2 w-max max-w-[260px] px-3 py-2.5 bg-slate-800 rounded-xl shadow-xl opacity-0 group-hover/cookie-yt:opacity-100 transition-opacity duration-150 pointer-events-none z-50">
    <p class="text-xs font-medium text-white leading-snug">{{ cookieYtTooltip[0] }}</p>
    <p v-if="cookieYtTooltip[1]" class="text-[11px] text-slate-400 mt-1 leading-snug">{{ cookieYtTooltip[1] }}</p>
    <div class="absolute bottom-full right-2.5 border-[5px] border-transparent border-b-slate-800" />
  </div>
</div>
```

**Step 3: 更新 webview v-if 和 partition**

```html
<!-- 修改前 -->
<webview
  v-if="bvid"
  ref="webviewRef"
  :src="videoUrl"
  partition="persist:bilibili"
  ...

<!-- 修改后 -->
<webview
  v-if="videoId"
  ref="webviewRef"
  :src="videoUrl"
  :partition="webviewSession"
  ...
```

**Step 4: 更新遮罩和空状态中的 bvid 引用**

```html
<!-- 遮罩：全屏激活前隐藏初始加载页面 -->
<!-- 修改前：v-if="bvid && !isWebFullscreen" -->
<!-- 修改后：v-if="videoId && !isWebFullscreen" -->

<!-- 空状态 -->
<!-- 修改前：v-if="!bvid" -->
<!-- 修改后：v-if="!videoId" -->
```

**Step 5: 更新空状态提示文案**

```html
<!-- 修改前 -->
<p class="text-sm font-medium text-slate-400">输入 B 站链接，一键解析</p>
<p class="text-xs text-slate-300 mt-1">支持 BV 号格式</p>

<!-- 修改后 -->
<p class="text-sm font-medium text-slate-400">输入 B 站 / YouTube 链接，一键解析</p>
<p class="text-xs text-slate-300 mt-1">支持 B 站 BV 号 · YouTube 视频链接</p>
```

**Step 6: 全局搜索确认无遗漏的 bvid 引用**

```bash
grep -n "bvid" src/renderer/src/App.vue
# 预期：无任何匹配（或只有注释）
```

**Step 7: 验证类型检查和 lint**

```bash
npm run typecheck && npm run lint
# 预期：无错误
```

**Step 8: 启动开发服务器，手动验证**

```bash
npm run dev
```

验证清单：
- [ ] 输入 B 站 BV 链接，正常解析，webview 加载 B 站播放器
- [ ] 输入 YouTube 链接（如 `https://www.youtube.com/watch?v=dQw4w9WgXcQ`），webview 加载 YouTube embed
- [ ] 时间轴点击跳转在两个平台均有效
- [ ] 两个 Cookie 状态指示器正常显示
- [ ] 输入非法链接显示对应错误提示

**Step 9: Commit**

```bash
git add src/renderer/src/App.vue
git commit -m "feat(renderer): App.vue template 改造支持双平台"
```

---

## 完成检查

- [ ] Task 1: extract_cookies.py --site 参数 ✓
- [ ] Task 2: VideoMeta language 字段 ✓
- [ ] Task 3: downloader 动态字幕语言 ✓
- [ ] Task 4: pipeline 传递 language ✓
- [ ] Task 5: platform.ts 创建 ✓
- [ ] Task 6: preload importYoutubeCookies ✓
- [ ] Task 7: main import-youtube-cookies IPC ✓
- [ ] Task 8: App.vue script ✓
- [ ] Task 9: App.vue template ✓
