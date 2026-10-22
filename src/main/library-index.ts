import type { DatabaseSync } from 'node:sqlite'
import { setImmediate } from 'node:timers/promises'
import { parseTimelineMarkdown, type TimelineChunk } from '../shared/timeline'
import { importTimeline } from '../shared/timeline-import'
import type { HistoryItem } from '../shared/history'
import type { LibraryEntry, LibraryMatch, LibraryQuery, LibraryResult } from '../shared/library'

interface MatchRow {
  chunk_json: string
  note: string
}

function excerpt(text: string, query: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  const start = Math.max(0, clean.toLowerCase().indexOf(query) - 45)
  const end = Math.min(clean.length, start + Math.max(170, query.length + 50))
  return `${start ? '…' : ''}${clean.slice(start, end)}${end < clean.length ? '…' : ''}`
}

function matchChunk(chunk: TimelineChunk, note: string, query: string): LibraryMatch {
  const candidates: Array<{ kind: LibraryMatch['kind']; text: string; seconds?: number }> = [
    { kind: 'note', text: note },
    { kind: 'title', text: chunk.title },
    { kind: 'summary', text: [chunk.summary, ...chunk.keyPoints].join('\n') },
    { kind: 'tags', text: chunk.tags.join(' · ') },
    ...chunk.transcript.map((line) => ({
      kind: 'transcript' as const,
      text: line.text,
      seconds: line.seconds
    }))
  ]
  const found = candidates.find((candidate) => candidate.text.toLowerCase().includes(query))
  return {
    chunkId: chunk.id,
    title: chunk.title,
    startSeconds: found?.seconds ?? chunk.startSeconds,
    kind: found?.kind ?? 'title',
    excerpt: excerpt(found?.text ?? chunk.title, query)
  }
}

/** A disposable local index. Original cache and personal annotations remain authoritative. */
export class LibraryIndex {
  private refreshing: Promise<void> | null = null

  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS library_sources (
        source_key TEXT PRIMARY KEY,
        cached_at INTEGER NOT NULL,
        valid INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS library_chunks (
        source_key TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        start_seconds REAL NOT NULL,
        chunk_json TEXT NOT NULL,
        search_text TEXT NOT NULL,
        imported_note TEXT NOT NULL,
        PRIMARY KEY (source_key, chunk_id)
      );
    `)
    db.function('library_lower', { deterministic: true }, (value) =>
      String(value ?? '').toLowerCase()
    )
  }

  update(sourceKey: string, content: string, cachedAt: number): void {
    let chunks: TimelineChunk[] = []
    try {
      chunks = content.trimStart().startsWith('{')
        ? importTimeline('cache.json', content).chunks
        : parseTimelineMarkdown(content)
    } catch {
      // Broken/unsupported caches must not prevent other documents from being searchable.
    }
    this.db.exec('SAVEPOINT library_update')
    try {
      this.db.prepare('DELETE FROM library_chunks WHERE source_key = ?').run(sourceKey)
      const insert = this.db.prepare(`INSERT INTO library_chunks
        (source_key, chunk_id, start_seconds, chunk_json, search_text, imported_note)
        VALUES (?, ?, ?, ?, ?, ?)`)
      for (const chunk of chunks) {
        const searchText = [
          chunk.title,
          chunk.summary,
          ...chunk.keyPoints,
          ...chunk.tags,
          ...chunk.transcript.map((line) => line.text)
        ]
          .join('\n')
          .toLowerCase()
        insert.run(
          sourceKey,
          chunk.id,
          chunk.startSeconds,
          JSON.stringify(chunk),
          searchText,
          chunk.userNote ?? ''
        )
      }
      this.db
        .prepare(
          `INSERT OR REPLACE INTO library_sources (source_key, cached_at, valid)
        VALUES (?, ?, ?)`
        )
        .run(sourceKey, cachedAt, chunks.length ? 1 : 0)
      this.db.exec('RELEASE library_update')
    } catch (error) {
      this.db.exec('ROLLBACK TO library_update; RELEASE library_update')
      throw error
    }
  }

  remove(sourceKey: string): void {
    this.db.prepare('DELETE FROM library_chunks WHERE source_key = ?').run(sourceKey)
    this.db.prepare('DELETE FROM library_sources WHERE source_key = ?').run(sourceKey)
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.refreshMissing().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async refreshMissing(): Promise<void> {
    const missing = this.db
      .prepare(
        `SELECT c.url FROM video_cache c
      LEFT JOIN library_sources s ON s.source_key = c.url
      WHERE s.source_key IS NULL OR s.cached_at != c.cached_at`
      )
      .all() as { url: string }[]
    const read = this.db.prepare('SELECT content, cached_at FROM video_cache WHERE url = ?')
    for (let index = 0; index < missing.length; index++) {
      const row = read.get(missing[index].url) as { content: string; cached_at: number } | undefined
      if (row) this.update(missing[index].url, row.content, row.cached_at)
      if (index % 8 === 0) await setImmediate()
    }
  }

  async search(history: HistoryItem[], options: LibraryQuery): Promise<LibraryResult> {
    if (!options || typeof options.query !== 'string' || options.query.length > 200)
      throw new Error('搜索词不能超过 200 个字')
    const query = options.query.trim().toLowerCase()
    const offset = Math.max(0, Math.floor(Number(options.offset) || 0))
    await this.refresh()
    const sources = new Map(
      (
        this.db
          .prepare(
            `SELECT c.url, COALESCE(s.valid, 0) AS valid FROM video_cache c
      LEFT JOIN library_sources s ON s.source_key = c.url`
          )
          .all() as { url: string; valid: number }[]
      ).map((row) => [row.url, Boolean(row.valid)])
    )
    const find = this.db
      .prepare(`SELECT c.chunk_json, COALESCE(a.note_text, c.imported_note) AS note
      FROM library_chunks c LEFT JOIN chunk_annotations a
        ON a.source_key = c.source_key AND a.chunk_id = c.chunk_id
      WHERE c.source_key = ? AND (instr(c.search_text, ?) > 0
        OR instr(library_lower(COALESCE(a.note_text, c.imported_note)), ?) > 0)
      ORDER BY c.start_seconds, c.chunk_id LIMIT 4`)
    const findOldNotes = this.db.prepare(`SELECT a.chunk_id, a.start_seconds, a.title, a.note_text
      FROM chunk_annotations a LEFT JOIN library_chunks c
        ON a.source_key = c.source_key AND a.chunk_id = c.chunk_id
      WHERE a.source_key = ? AND c.chunk_id IS NULL AND instr(library_lower(a.note_text), ?) > 0
      ORDER BY a.start_seconds LIMIT 4`)
    const entries: LibraryEntry[] = []
    let total = 0
    for (let index = 0; index < history.length; index++) {
      const item = history[index]
      if (options.favoritesOnly && !item.favorited) continue
      const matches: LibraryMatch[] = []
      if (query) {
        const rows = find.all(item.url, query, query) as unknown as MatchRow[]
        for (const row of rows)
          matches.push(matchChunk(JSON.parse(row.chunk_json), row.note, query))
        if (matches.length < 4) {
          const old = findOldNotes.all(item.url, query) as {
            chunk_id: string
            start_seconds: number
            title: string
            note_text: string
          }[]
          for (const row of old)
            matches.push({
              chunkId: row.chunk_id,
              startSeconds: row.start_seconds,
              title: row.title,
              excerpt: excerpt(row.note_text, query),
              kind: 'legacy-note'
            })
        }
      }
      if (
        !query ||
        matches.length ||
        item.title.toLowerCase().includes(query) ||
        item.url.toLowerCase().includes(query)
      ) {
        if (total >= offset && entries.length < 50)
          entries.push({
            item,
            cached: sources.has(item.url),
            matches: matches.slice(0, 3),
            moreMatches: matches.length > 3
          })
        total++
      }
      if (index % 30 === 0) await setImmediate()
    }
    return {
      entries,
      total,
      totalSources: history.length,
      unavailableSources: history.filter((item) => !sources.get(item.url)).length
    }
  }
}
