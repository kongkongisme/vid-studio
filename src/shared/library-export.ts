export const MAX_LIBRARY_EXPORT_SOURCES = 200

export interface LibraryExportRequest {
  ids: string[]
  format: 'markdown' | 'json'
  includeTranscript: boolean
  includeAnnotations: boolean
}

export interface LibraryExportResult {
  success: boolean
  canceled?: boolean
  path?: string
  count?: number
  error?: string
}

export function validateLibraryExport(value: LibraryExportRequest): void {
  if (
    !value ||
    !Array.isArray(value.ids) ||
    !value.ids.length ||
    value.ids.length > MAX_LIBRARY_EXPORT_SOURCES ||
    value.ids.some((id) => typeof id !== 'string' || !id || id.length > 500) ||
    new Set(value.ids).size !== value.ids.length
  )
    throw new Error(`请选择 1 至 ${MAX_LIBRARY_EXPORT_SOURCES} 份不同的资料`)
  if (
    !['markdown', 'json'].includes(value.format) ||
    typeof value.includeTranscript !== 'boolean' ||
    typeof value.includeAnnotations !== 'boolean'
  )
    throw new Error('批量导出选项无效')
}
