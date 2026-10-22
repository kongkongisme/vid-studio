import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { HistoryItem } from '../shared/history'

const platforms = new Set(['bilibili', 'youtube', 'local', 'document'])
const modes = new Set(['asr', 'visual', 'imported'])

function validateItem(item: Omit<HistoryItem, 'id' | 'createdAt'>): void {
  if (
    !item ||
    typeof item.url !== 'string' ||
    !item.url ||
    item.url.length > 4096 ||
    typeof item.title !== 'string' ||
    item.title.length > 1000 ||
    !platforms.has(item.platform) ||
    !modes.has(item.mode) ||
    typeof item.favorited !== 'boolean'
  )
    throw new Error('历史记录格式无效')
}

/** One writer per app process; atomic replacement never truncates the last good file. */
export class HistoryStore {
  private pending: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  private async read(): Promise<HistoryItem[]> {
    let content: string
    try {
      content = await fs.readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error('无法读取历史记录，请检查文件权限。原文件未修改。', { cause: error })
    }
    try {
      const items: unknown = JSON.parse(content)
      if (!Array.isArray(items)) throw new Error('Expected history array')
      for (const item of items) {
        validateItem(item)
        if (typeof item.id !== 'string' || !item.id || !Number.isFinite(item.createdAt))
          throw new Error('Invalid history identifier')
      }
      return items
    } catch (error) {
      throw new Error('历史文件损坏，已保留原文件。可从 history.json.bak 恢复后重试。', {
        cause: error
      })
    }
  }

  async list(): Promise<HistoryItem[]> {
    await this.pending
    return this.read()
  }

  private async atomicWrite(filePath: string, content: string): Promise<void> {
    const temporary = `${filePath}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, content, { mode: 0o600, flag: 'wx' })
      await fs.rename(temporary, filePath)
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  private mutate(update: (items: HistoryItem[]) => HistoryItem[]): Promise<void> {
    const operation = this.pending.then(async () => {
      const previous = await this.read()
      const next = update(previous.map((item) => ({ ...item })))
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      // Back up only validated data. A malformed original is never overwritten.
      await this.atomicWrite(`${this.filePath}.bak`, JSON.stringify(previous, null, 2))
      await this.atomicWrite(this.filePath, JSON.stringify(next, null, 2))
    })
    // A failed mutation must reject its caller without poisoning subsequent operations.
    this.pending = operation.catch(() => undefined)
    return operation
  }

  add(item: Omit<HistoryItem, 'id' | 'createdAt'>): Promise<void> {
    validateItem(item)
    return this.mutate((items) => {
      const existing = items.find((entry) => entry.url === item.url)
      return [
        {
          ...item,
          id: existing?.id ?? randomUUID(),
          createdAt: existing?.createdAt ?? Date.now(),
          title: existing?.title ?? item.title,
          favorited: existing?.favorited ?? item.favorited
        },
        ...items.filter((entry) => entry.url !== item.url)
      ]
    })
  }

  toggleFavorite(id: string): Promise<void> {
    return this.mutate((items) => {
      const item = items.find((entry) => entry.id === id)
      if (item) item.favorited = !item.favorited
      return items
    })
  }

  remove(id: string): Promise<void> {
    return this.mutate((items) => items.filter((entry) => entry.id !== id))
  }

  rename(id: string, title: string): Promise<void> {
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 200)
      return Promise.reject(new Error('标题需要 1 至 200 个字'))
    return this.mutate((items) => {
      const item = items.find((entry) => entry.id === id)
      if (item) item.title = title.trim()
      return items
    })
  }
}
