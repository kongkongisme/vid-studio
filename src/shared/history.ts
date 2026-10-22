export interface HistoryItem {
  id: string
  url: string
  title: string
  platform: 'bilibili' | 'youtube' | 'local' | 'document'
  thumbnail?: string
  mode: 'asr' | 'visual' | 'imported'
  createdAt: number
  favorited: boolean
  outputPath?: string
  duration?: number
  filePath?: string
}
