# YouTube 视频链接支持设计文档

**日期**：2026-03-01
**状态**：已确认，待实现

---

## 背景

vid-studio 当前仅支持 B 站视频链接。后端已使用 yt-dlp（原生支持 YouTube），核心处理管道与平台无关，但前端和部分后端代码硬编码了 B 站特定逻辑，需要适配 YouTube。

## 目标

- 支持 YouTube 视频链接的完整解析流程（字幕/ASR → 语义分块 → 知识时间轴）
- 左侧 webview 嵌入 YouTube 播放器（embed URL）
- 支持 YouTube Cookie 从浏览器导入，注入 `persist:youtube` session
- 字幕语言自动检测视频主语言并优先使用

## 方案选型

选择**方案 B：平台工具模块**。新建 `platform.ts` 集中管理所有平台相关逻辑，App.vue 调用统一接口，不感知平台差异。

---

## 架构

```
用户输入 URL
    ↓
platform.ts（新文件）
  · detectPlatform()        → 'bilibili' | 'youtube'
  · extractVideoId()        → BV号 / YouTube ID
  · validateUrl()           → 统一校验
  · getWebviewUrl()         → B站原页 / YouTube embed URL
  · getWebviewSession()     → persist:bilibili / persist:youtube
  · getFullscreenScript()   → B站注入脚本 / YouTube 空操作
  · getSeekFallbackUrl()    → 时间跳转降级 URL
    ↓                              ↓
App.vue（调用 platform.ts）    index.ts（新增 IPC）
  · currentPlatform ref          · import-youtube-cookies
  · 动态 webview partition       · 注入 persist:youtube session
  · 双平台 Cookie 状态 UI
    ↓
vid-engine/（后端适配）
  · VideoMeta 增加 language 字段
  · download_subtitle() 动态语言列表
  · extract_cookies.py --site 参数
```

---

## 改动文件清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `src/renderer/src/platform.ts` | 新建 | 平台工具模块 |
| `src/renderer/src/App.vue` | 修改 | 调用 platform.ts，新增 YouTube Cookie UI |
| `src/main/index.ts` | 修改 | 新增 `import-youtube-cookies` IPC handler |
| `src/preload/index.ts` | 修改 | 暴露 `importYoutubeCookies` API |
| `vid-engine/src/models.py` | 修改 | VideoMeta 增加 `language` 字段 |
| `vid-engine/src/downloader.py` | 修改 | 动态字幕语言列表 |
| `vid-engine/src/pipeline.py` | 修改 | 传递 `meta.language` 给 downloader |
| `vid-engine/extract_cookies.py` | 修改 | 增加 `--site` 参数 |

---

## 详细设计

### 1. platform.ts（新建）

```typescript
type Platform = 'bilibili' | 'youtube'

// URL 识别：bilibili.com 或含 BV 号 → bilibili；youtube.com/watch 或 youtu.be → youtube
detectPlatform(url: string): Platform | null

// B站：提取 BV[a-zA-Z0-9]+ ；YouTube：提取 v= 参数或 youtu.be 路径（11位 ID）
extractVideoId(url: string, platform: Platform): string | null

// 校验：空链接 / 无法识别平台 / 无法提取 ID 三种错误
validateUrl(url: string): string | null

// B站：https://www.bilibili.com/video/{id}
// YouTube：https://www.youtube.com/embed/{id}?autoplay=1&rel=0
getWebviewUrl(videoId: string, platform: Platform): string

// 'persist:bilibili' | 'persist:youtube'
getWebviewSession(platform: Platform): string

// B站：现有 .bpx-player-ctrl-web 等选择器脚本
// YouTube embed 自动填满 webview，返回 () => true 空操作
getFullscreenScript(platform: Platform): string

// 两个平台通用：document.querySelector('video').currentTime = seconds
getSeekScript(seconds: number): string

// B站：https://www.bilibili.com/video/{id}?t={seconds}
// YouTube：https://www.youtube.com/embed/{id}?autoplay=1&start={seconds}
getSeekFallbackUrl(videoId: string, platform: Platform, seconds: number): string
```

### 2. App.vue 改动要点

- 删除 `extractBvid` / `validateBilibiliUrl`，改用 `platform.ts`
- `bvid` ref 改名为 `videoId`（语义更通用）
- 新增 `currentPlatform = ref<Platform | null>(null)`
- webview `partition` 改为计算属性 `webviewSession`
- `injectWebFullscreen()` 调用 `getFullscreenScript(currentPlatform.value)`
- `seekTo()` 降级 URL 调用 `getSeekFallbackUrl()`
- Cookie UI：顶部栏新增 YouTube Cookie 指示器（`cookieYtStatus` / `cookieYtBrowser`）
- `onMounted` 并行导入 B站 + YouTube Cookie
- 导航拦截白名单加入 `youtube.com`、`googlevideo.com`、`ytimg.com`
- placeholder 改为 `粘贴 B 站 / YouTube 视频链接...`

### 3. index.ts：import-youtube-cookies

与 `import-browser-cookies` 逻辑相同，差异：
- 调用 `extract_cookies.py --site youtube`
- 注入 `session.fromPartition('persist:youtube')`

### 4. preload/index.ts

新增：`importYoutubeCookies: () => ipcRenderer.invoke('import-youtube-cookies')`

### 5. vid-engine/src/models.py

```python
@dataclass
class VideoMeta:
    id: str
    title: str
    duration: int
    uploader: str
    language: str = ""  # yt-dlp 返回的视频主语言代码（如 "en"、"zh"）
```

### 6. vid-engine/src/downloader.py

新增 `_build_subtitle_langs(primary_lang: str) -> list`：
- 中文（`zh` 开头或空）→ `["zh-Hans", "zh-CN", "zh-TW", "zh", "en"]`
- 非中文 → `[primary_lang, "zh-Hans", "zh-CN", "en"]`（去重保序）

`get_video_meta()` 从 info 读取 `language` 字段。
`download_subtitle(url, primary_lang="")` 使用动态语言列表。

### 7. vid-engine/src/pipeline.py

`_get_segments()` 改为接收 `primary_lang` 参数，调用 `downloader.download_subtitle(url, primary_lang)`。
`run()` 中将 `meta.language` 传入 `_get_segments()`。

### 8. vid-engine/extract_cookies.py

新增 `SITE_DOMAINS`：
```python
SITE_DOMAINS = {
    'bilibili': ('bilibili', 'bilivideo', 'hdslb', 'biliimg'),
    'youtube': ('youtube', 'ytimg', 'googlevideo', 'yt'),
}
```

`main()` 解析 `--site bilibili|youtube` 参数（默认 `bilibili`），根据站点过滤 Cookie 并使用对应 seed URL。

---

## 关键约束

- YouTube webview 使用 embed URL，不拦截其域名下的导航
- `seekTo` 的 `video.currentTime` 操作两个平台通用（Electron webview 有完整 JS 访问权）
- YouTube fullscreen 无需注入脚本（embed 播放器已填满 webview）
- B站 Cookie 导入流程不变，YouTube Cookie 独立 IPC 并行导入
