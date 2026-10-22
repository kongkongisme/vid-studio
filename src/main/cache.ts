// src/main/cache.ts
import { app } from 'electron'
import path from 'path'
import { mkdirSync } from 'fs'
import { AnnotationStore } from './annotation-store'

import { DatabaseSync } from 'node:sqlite'

let db: DatabaseSync | null = null
let annotationStore: AnnotationStore | null = null

function getDb(): DatabaseSync {
  if (!db) {
    const dbPath = path.join(app.getPath('userData'), 'cache.db')
    mkdirSync(path.dirname(dbPath), { recursive: true })
    db = new DatabaseSync(dbPath)
    // 应用退出前关闭数据库，确保写入完整性
    app.once('will-quit', () => {
      db?.close()
      db = null
      annotationStore = null
    })
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
  const row = getDb().prepare('SELECT content FROM video_cache WHERE url = ?').get(url) as
    | { content: string }
    | undefined
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

export function getAnnotationStore(): AnnotationStore {
  annotationStore ??= new AnnotationStore(getDb())
  return annotationStore
}
