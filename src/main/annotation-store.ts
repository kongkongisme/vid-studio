import type { DatabaseSync } from 'node:sqlite'
import {
  validateAnnotation,
  type AnnotationInput,
  type ChunkAnnotation
} from '../shared/annotations'

interface AnnotationRow {
  source_key: string
  chunk_id: string
  start_seconds: number
  title: string
  bookmarked: number
  note_text: string
  updated_at: number
}

/** Personal records are stored separately from disposable parsing caches. */
export class AnnotationStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chunk_annotations (
        source_key TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        start_seconds REAL NOT NULL,
        title TEXT NOT NULL,
        bookmarked INTEGER NOT NULL DEFAULT 0,
        note_text TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (source_key, chunk_id)
      );
      CREATE INDEX IF NOT EXISTS chunk_annotations_updated ON chunk_annotations(updated_at DESC);
    `)
  }

  list(sourceKey: string): ChunkAnnotation[] {
    if (typeof sourceKey !== 'string' || sourceKey.length > 4096) throw new Error('资料标识无效')
    const rows = this.db
      .prepare(
        'SELECT * FROM chunk_annotations WHERE source_key = ? ORDER BY start_seconds, chunk_id'
      )
      .all(sourceKey) as unknown as AnnotationRow[]
    return rows.map((row) => ({
      sourceKey: row.source_key,
      chunkId: row.chunk_id,
      startSeconds: row.start_seconds,
      title: row.title,
      bookmarked: Boolean(row.bookmarked),
      note: row.note_text,
      updatedAt: row.updated_at
    }))
  }

  save(input: AnnotationInput): ChunkAnnotation {
    validateAnnotation(input)
    const annotation = { ...input, updatedAt: Date.now() }
    // Keep empty rows as tombstones so cleared imported notes do not reappear.
    this.db
      .prepare(
        `INSERT INTO chunk_annotations (source_key, chunk_id, start_seconds, title, bookmarked, note_text, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_key, chunk_id) DO UPDATE SET
          start_seconds = excluded.start_seconds, title = excluded.title, bookmarked = excluded.bookmarked,
          note_text = excluded.note_text, updated_at = excluded.updated_at
      `
      )
      .run(
        input.sourceKey,
        input.chunkId,
        input.startSeconds,
        input.title,
        input.bookmarked ? 1 : 0,
        input.note,
        annotation.updatedAt
      )
    return annotation
  }
}
