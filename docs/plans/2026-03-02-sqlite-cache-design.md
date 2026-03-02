# SQLite 解析内容缓存设计

**日期：** 2026-03-02
**状态：** 已批准

## 背景

当前历史记录只保存视频元数据（标题、URL、平台、模式等），不缓存解析结果。用户从历史面板加载已解析视频时，必须重新解析，耗时较长。

`HistoryItem` 中已有 `outputPath?: string` 字段，`loadHistoryItem()` 已有读取文件的逻辑，但 `saveHistory()` 从未写入该字段，导致缓存机制从未生效。

## 目标

- 解析完成后，将 Markdown 内容持久化到 SQLite 数据库
- 从历史记录加载视频时，优先命中缓存直接显示，无需重新解析
- 删除历史记录时同步删除对应缓存

## 技术选型

使用 **`node:sqlite`**（Node.js 22 内置模块），Electron 39 已捆绑 Node 22.14。

- 零额外依赖，无需 native 模块编译
- 同步 API，适合主进程
- 数据库文件：`{userData}/cache.db`

## 架构

### 文件变更

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/main/cache.ts` | 新建 | SQLite 增删改查，约 50 行 |
| `src/main/index.ts` | 修改 | 新增 3 个 IPC handler |
| `src/preload/index.ts` | 修改 | 暴露 getCache / setCache / deleteCache |
| `src/renderer/src/App.vue` | 修改 | saveHistory 写缓存，loadHistoryItem 读缓存，历史面板加标识 |

### 数据库 Schema

```sql
CREATE TABLE IF NOT EXISTS video_cache (
  url       TEXT PRIMARY KEY,
  content   TEXT NOT NULL,
  cached_at INTEGER NOT NULL
)
```

缓存键为视频 URL，与 history.ts 去重逻辑保持一致。

### `cache.ts` 接口

```typescript
export function getCachedContent(url: string): string | null
export function setCachedContent(url: string, content: string): void
export function deleteCachedContent(url: string): void
export function getCachedUrls(): string[]   // 用于 UI 标识
```

数据库使用懒初始化，首次调用时打开，避免 app ready 前访问。

## 数据流

### 解析时（写缓存）

```
parseVideo()
  └─ result.output (Markdown)
       ├─ timelineChunks = parseMarkdown(output)
       └─ saveHistory(output)
            ├─ addHistory(metadata)        // 已有
            └─ setCache(url, output)       // 新增
```

### 从历史加载时（读缓存）

```
loadHistoryItem(item)
  └─ getCache(item.url)
       ├─ 命中 → timelineChunks = parseMarkdown(cached) → 直接显示
       └─ 未命中 → parseVideo()（解析后自动写缓存）
```

### 删除历史时（清缓存）

```
deleteHistoryItem(id)
  ├─ deleteHistory(id)
  └─ deleteCache(url)    // 需从 historyList 先查 url
```

## UI 变化

### 缓存标识

历史面板中，有缓存的条目右侧显示 ⚡ 图标。

- 历史面板打开时，调用 `getCachedUrls()` 获取所有已缓存的 URL
- 与 `historyList` 对比，标记 `cached: boolean`

### 加载提示

从缓存加载时，右侧时间轴顶部短暂显示"从缓存加载"提示，1.5 秒后消失。

## 兼容性

- `outputPath` 字段保留但不再写入新值，已有旧数据仍可读取
- 缓存与历史元数据分离存储，缓存损坏不影响历史列表
