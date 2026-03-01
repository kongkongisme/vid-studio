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

const HISTORY_FILE = path.join(app.getPath('userData'), 'history.json')
const MAX_ITEMS = 50

export async function getHistory(): Promise<HistoryItem[]> {
  try {
    const data = await fs.readFile(HISTORY_FILE, 'utf-8')
    return JSON.parse(data)
  } catch {
    return []
  }
}

export async function addHistory(item: Omit<HistoryItem, 'id' | 'createdAt'>): Promise<void> {
  const history = await getHistory()

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

  await fs.writeFile(HISTORY_FILE, JSON.stringify(filtered, null, 2))
}

export async function toggleFavorite(id: string): Promise<void> {
  const history = await getHistory()
  const item = history.find((h) => h.id === id)
  if (item) {
    item.favorited = !item.favorited
    await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2))
  }
}

export async function deleteHistory(id: string): Promise<void> {
  const history = await getHistory()
  const filtered = history.filter((h) => h.id !== id)
  await fs.writeFile(HISTORY_FILE, JSON.stringify(filtered, null, 2))
}
