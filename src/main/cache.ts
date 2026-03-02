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
