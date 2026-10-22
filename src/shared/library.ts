import type { HistoryItem } from './history'

export interface LibraryQuery {
  query: string
  favoritesOnly?: boolean
  offset?: number
}

export interface LibraryMatch {
  chunkId: string
  startSeconds: number
  title: string
  excerpt: string
  kind: 'title' | 'summary' | 'transcript' | 'note' | 'tags' | 'legacy-note'
}

export interface LibraryEntry {
  item: HistoryItem
  cached: boolean
  matches: LibraryMatch[]
  moreMatches: boolean
}

export interface LibraryResult {
  entries: LibraryEntry[]
  total: number
  totalSources: number
  unavailableSources: number
}
