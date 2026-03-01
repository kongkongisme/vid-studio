import { app } from 'electron'
import path from 'path'
import fs from 'fs/promises'

export interface HistoryItem {
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

const MAX_ITEMS = 50

// 延迟获取文件路径，确保 app 已 ready
function getHistoryFile(): string {
  return path.join(app.getPath('userData'), 'history.json')
}

export async function getHistory(): Promise<HistoryItem[]> {
  try {
    const data = await fs.readFile(getHistoryFile(), 'utf-8')
    return JSON.parse(data)
  } catch {
    return []
  }
}

export async function addHistory(item: Omit<HistoryItem, 'id' | 'createdAt'>): Promise<void> {
  console.log('[history] addHistory 被调用:', item)
  const history = await getHistory()
  console.log('[history] 当前历史记录数:', history.length)

  const newItem: HistoryItem = {
    ...item,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now()
  }

  // 去重：相同 URL 替换旧的
  const filtered = history.filter((h) => h.url !== item.url)
  filtered.unshift(newItem)

  // 限制数量
  if (filtered.length > MAX_ITEMS) {
    filtered.pop()
  }

  const filePath = getHistoryFile()
  // 确保目录存在（app.getPath('userData') 返回路径但不保证目录已创建）
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(filtered, null, 2))
  console.log('[history] 文件写入成功:', filePath)
}

export async function toggleFavorite(id: string): Promise<void> {
  const history = await getHistory()
  const item = history.find((h) => h.id === id)
  if (item) {
    item.favorited = !item.favorited
    await fs.writeFile(getHistoryFile(), JSON.stringify(history, null, 2))
  }
}

export async function deleteHistory(id: string): Promise<void> {
  const history = await getHistory()
  const filtered = history.filter((h) => h.id !== id)
  await fs.writeFile(getHistoryFile(), JSON.stringify(filtered, null, 2))
}
