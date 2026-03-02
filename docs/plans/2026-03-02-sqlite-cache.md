# SQLite 解析内容缓存 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 使用 `node:sqlite`（Node 22 内置模块）缓存视频解析结果，让用户从历史记录加载视频时无需重新解析。

**Architecture:** 新增 `src/main/cache.ts` 管理 SQLite 数据库（`{userData}/cache.db`），通过 4 个新 IPC handler 暴露给渲染层；`saveHistory` 同步写缓存，`loadHistoryItem` 优先读缓存（命中则直接渲染，未命中则重新解析）。

**Tech Stack:** `node:sqlite`（Node 22 内置，Electron 39 已捆绑），TypeScript，Vue 3 Composition API，@tabler/icons-vue（`IconBolt` 已导入）

---

## Task 1: 创建 `src/main/cache.ts`

**Files:**
- Create: `src/main/cache.ts`

**Step 1: 创建缓存模块**

```typescript
// src/main/cache.ts
import { app } from 'electron'
import path from 'path'

// node:sqlite 是 Node 22 内置模块，Electron 39 (Node 22.14) 支持
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — node:sqlite 类型声明在部分 @types/node 版本中缺失
import { DatabaseSync } from 'node:sqlite'

let db: InstanceType<typeof DatabaseSync> | null = null

function getDb(): InstanceType<typeof DatabaseSync> {
  if (!db) {
    const dbPath = path.join(app.getPath('userData'), 'cache.db')
    db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE IF NOT EXISTS video_cache (
        url       TEXT PRIMARY KEY,
        content   TEXT NOT NULL,
        cached_at INTEGER NOT NULL
      )
    `)
  }
  return db
}

export function getCachedContent(url: string): string | null {
  const row = getDb()
    .prepare('SELECT content FROM video_cache WHERE url = ?')
    .get(url) as { content: string } | undefined
  return row?.content ?? null
}

export function setCachedContent(url: string, content: string): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO video_cache (url, content, cached_at) VALUES (?, ?, ?)')
    .run(url, content, Date.now())
}

export function deleteCachedContent(url: string): void {
  getDb().prepare('DELETE FROM video_cache WHERE url = ?').run(url)
}

export function getCachedUrls(): string[] {
  const rows = getDb().prepare('SELECT url FROM video_cache').all() as { url: string }[]
  return rows.map((r) => r.url)
}
```

**Step 2: 检查是否能通过 typecheck**

```bash
cd /Users/quantum/Desktop/Workspace/VibeCoding/vid-studio
npm run typecheck
```

预期：通过，或只有 `node:sqlite` 相关的 ts-ignore 警告（不是错误）。

如果报错 `Cannot find module 'node:sqlite'`，在 `src/main/cache.ts` 顶部加一行：
```typescript
declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string)
    exec(sql: string): void
    prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[]; run(...args: unknown[]): void }
  }
}
```

**Step 3: Commit**

```bash
git add src/main/cache.ts
git commit -m "feat: 添加 SQLite 缓存模块 (cache.ts)"
```

---

## Task 2: 在 `src/main/index.ts` 添加 IPC handlers

**Files:**
- Modify: `src/main/index.ts`

**Step 1: 添加 import**

在文件顶部，找到已有的 import 行：
```typescript
import { getHistory, addHistory, toggleFavorite, deleteHistory } from './history'
```
替换为：
```typescript
import { getHistory, addHistory, toggleFavorite, deleteHistory } from './history'
import { getCachedContent, setCachedContent, deleteCachedContent, getCachedUrls } from './cache'
```

**Step 2: 添加 4 个 IPC handlers**

在 `ipcMain.handle('read-file', ...)` 之后，添加：

```typescript
// ─── IPC：解析内容缓存 ────────────────────────────────────

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
```

**Step 3: 验证编译**

```bash
npm run typecheck
```

**Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: 添加缓存 IPC handlers"
```

---

## Task 3: 更新 `src/preload/index.ts` 暴露缓存 API

**Files:**
- Modify: `src/preload/index.ts`

**Step 1: 在 `api` 对象的 `readFile` 之后，添加 4 个缓存方法**

找到：
```typescript
  readFile: (path: string): Promise<string | null> => ipcRenderer.invoke('read-file', path)
```
替换为：
```typescript
  readFile: (path: string): Promise<string | null> => ipcRenderer.invoke('read-file', path),

  // 解析内容缓存
  getCache: (url: string): Promise<string | null> => ipcRenderer.invoke('get-cache', url),
  setCache: (url: string, content: string): Promise<void> => ipcRenderer.invoke('set-cache', url, content),
  deleteCache: (url: string): Promise<void> => ipcRenderer.invoke('delete-cache', url),
  getCachedUrls: (): Promise<string[]> => ipcRenderer.invoke('get-cached-urls')
```

**Step 2: 验证**

```bash
npm run typecheck
```

**Step 3: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat: preload 暴露缓存 API"
```

---

## Task 4: 更新 `App.vue` — 逻辑层

**Files:**
- Modify: `src/renderer/src/App.vue`

本任务做 5 处 script 修改，不涉及模板。

**Step 1: 在 Phase 2 历史管理的 `ref` 声明区（约 114 行）新增两个 ref**

找到：
```typescript
const historyList = ref<HistoryItem[]>([])
const showHistoryPanel = ref(false)
const historySearch = ref('')
```
替换为：
```typescript
const historyList = ref<HistoryItem[]>([])
const showHistoryPanel = ref(false)
const historySearch = ref('')
const cachedUrls = ref(new Set<string>())
const cacheLoadedMsg = ref(false)
```

**Step 2: 修改 `saveHistory`（约 673 行）**

将参数 `_output` 改为 `output`，并在成功保存后写缓存。

找到：
```typescript
async function saveHistory(_output: string): Promise<void> {
  console.log('[saveHistory] 开始保存，currentPlatform:', currentPlatform.value, 'videoId:', videoId.value)
  if (!currentPlatform.value || !videoId.value) {
    console.log('[saveHistory] 跳过：平台或视频ID为空')
    return
  }

  const title = timelineChunks.value[0]?.title || '未命名视频'
  console.log('[saveHistory] 标题:', title, 'URL:', url.value)
  try {
    await window.api.addHistory({
      url: url.value,
      title,
      platform: currentPlatform.value,
      mode: skipVideo.value ? 'asr' : 'visual',
      favorited: false
    })
    console.log('[saveHistory] 保存成功')
    await loadHistory()
  } catch (e) {
    console.error('[saveHistory] 保存失败:', e)
  }
}
```
替换为：
```typescript
async function saveHistory(output: string): Promise<void> {
  console.log('[saveHistory] 开始保存，currentPlatform:', currentPlatform.value, 'videoId:', videoId.value)
  if (!currentPlatform.value || !videoId.value) {
    console.log('[saveHistory] 跳过：平台或视频ID为空')
    return
  }

  const title = timelineChunks.value[0]?.title || '未命名视频'
  console.log('[saveHistory] 标题:', title, 'URL:', url.value)
  try {
    await window.api.addHistory({
      url: url.value,
      title,
      platform: currentPlatform.value,
      mode: skipVideo.value ? 'asr' : 'visual',
      favorited: false
    })
    await window.api.setCache(url.value, output)
    console.log('[saveHistory] 保存成功（含缓存）')
    await loadHistory()
  } catch (e) {
    console.error('[saveHistory] 保存失败:', e)
  }
}
```

**Step 3: 修改 `loadHistoryItem`（约 722 行）**

将 `outputPath` 逻辑替换为 SQLite 缓存查询，命中时显示提示。

找到整个函数：
```typescript
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
```
替换为：
```typescript
async function loadHistoryItem(item: HistoryItem): Promise<void> {
  url.value = item.url
  skipVideo.value = item.mode === 'asr'
  showHistoryPanel.value = false

  // 优先从 SQLite 缓存加载
  try {
    const cached = await window.api.getCache(item.url)
    if (cached) {
      timelineChunks.value = parseMarkdown(cached)
      currentPlatform.value = item.platform
      videoId.value = extractVideoId(item.url, item.platform) || ''
      videoUrl.value = getWebviewUrl(videoId.value, item.platform)
      // 显示"从缓存加载"提示，1.5s 后自动消失
      cacheLoadedMsg.value = true
      setTimeout(() => { cacheLoadedMsg.value = false }, 1500)
      return
    }
  } catch {
    // 缓存读取失败，继续重新解析
  }

  // 缓存未命中，重新解析（解析完成后 saveHistory 会自动写入缓存）
  await parseVideo()
}
```

**Step 4: 修改 `deleteHistoryItem`（约 706 行）**

删除历史前先查出 URL，同步删除缓存。

找到：
```typescript
async function deleteHistoryItem(id: string): Promise<void> {
  try {
    await window.api.deleteHistory(id)
    await loadHistory()
  } catch {
    // 静默失败
  }
}
```
替换为：
```typescript
async function deleteHistoryItem(id: string): Promise<void> {
  try {
    const item = historyList.value.find((h) => h.id === id)
    await window.api.deleteHistory(id)
    if (item) await window.api.deleteCache(item.url)
    await loadHistory()
    if (item) cachedUrls.value.delete(item.url)
  } catch {
    // 静默失败
  }
}
```

**Step 5: 修改 `toggleHistoryPanel`（约 715 行）**

打开历史面板时同步刷新缓存 URL 集合。

找到：
```typescript
async function toggleHistoryPanel(): Promise<void> {
  showHistoryPanel.value = !showHistoryPanel.value
  if (showHistoryPanel.value) {
    await loadHistory()
  }
}
```
替换为：
```typescript
async function toggleHistoryPanel(): Promise<void> {
  showHistoryPanel.value = !showHistoryPanel.value
  if (showHistoryPanel.value) {
    await loadHistory()
    try {
      const urls = await window.api.getCachedUrls()
      cachedUrls.value = new Set(urls)
    } catch {
      // 静默失败
    }
  }
}
```

**Step 6: 验证**

```bash
npm run typecheck
```

**Step 7: Commit**

```bash
git add src/renderer/src/App.vue
git commit -m "feat: App.vue 接入 SQLite 缓存（读写删逻辑）"
```

---

## Task 5: 更新 `App.vue` — UI 层

**Files:**
- Modify: `src/renderer/src/App.vue`（模板部分）

**Step 1: 添加"从缓存加载"提示条**

在 `<!-- 搜索框 -->` 区块（约 1338 行）之前，`<!-- 解析中：... -->` 区块结束的 `</div>` 之后，插入：

找到（在 `<!-- ── 时间轴面板 ── -->` 内部，搜索框前）：
```html
          <!-- 搜索框 -->
          <div
            v-if="timelineChunks.length"
            class="shrink-0 px-3 py-2 border-b border-slate-200 bg-white"
          >
```
替换为：
```html
          <!-- 从缓存加载提示 -->
          <Transition
            enter-active-class="transition-all duration-300"
            leave-active-class="transition-all duration-200"
            enter-from-class="opacity-0 -translate-y-1"
            leave-to-class="opacity-0 -translate-y-1"
          >
            <div
              v-if="cacheLoadedMsg"
              class="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 text-blue-500 text-xs border-b border-blue-100"
            >
              <IconBolt class="w-3 h-3" />
              从缓存加载
            </div>
          </Transition>

          <!-- 搜索框 -->
          <div
            v-if="timelineChunks.length"
            class="shrink-0 px-3 py-2 border-b border-slate-200 bg-white"
          >
```

**Step 2: 在历史列表每行添加 ⚡ 缓存标识**

在历史面板的每个条目 `<!-- 操作按钮 -->` 之前，插入缓存图标。

找到（在 v-for 循环内，`<!-- 操作按钮 -->` 之前）：
```html
                <!-- 操作按钮 -->
                <button
                  @click.stop="toggleFavoriteHistory(item.id)"
```
替换为：
```html
                <!-- 缓存标识 -->
                <IconBolt
                  v-if="cachedUrls.has(item.url)"
                  class="w-3.5 h-3.5 text-blue-400 shrink-0 opacity-60"
                  title="已缓存，点击秒加载"
                />

                <!-- 操作按钮 -->
                <button
                  @click.stop="toggleFavoriteHistory(item.id)"
```

**Step 3: 手动验证**

```bash
npm run dev
```

验证以下场景：
1. 解析一个视频 → 右下角历史按钮打开面板 → 该视频旁出现 ⚡ 图标
2. 点击有 ⚡ 的历史条目 → 时间轴顶部出现蓝色"从缓存加载"提示，1.5s 消失
3. 删除该历史条目 → ⚡ 消失，再次解析同 URL → 重新走完整解析流程后再次出现 ⚡

**Step 4: Commit**

```bash
git add src/renderer/src/App.vue
git commit -m "feat: 历史面板缓存标识 + 从缓存加载提示"
```
