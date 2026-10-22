export const SECRET_KEYS = [
  'DEEPSEEK_API_KEY',
  'GPT_API_KEY',
  'SILICONFLOW_API_KEY',
  'ZHIPUAI_API_KEY',
  'TAVILY_API_KEY'
] as const
export type SecretKey = (typeof SECRET_KEYS)[number]
export const MODEL_KEYS = [
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_MODEL',
  'GPT_BASE_URL',
  'GPT_MODEL',
  'GPT_REASONING_EFFORT'
] as const
export type ModelKey = (typeof MODEL_KEYS)[number]
export interface Preferences {
  detectClipboard: boolean
  autoImportCookies: boolean
  allowWebSearch: boolean
  pythonPath: string
}
export const DEFAULT_PREFERENCES: Preferences = {
  detectClipboard: false,
  autoImportCookies: false,
  allowWebSearch: true,
  pythonPath: ''
}
export const DEFAULT_MODELS: Record<ModelKey, string> = {
  DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
  DEEPSEEK_MODEL: 'deepseek-chat',
  GPT_BASE_URL: 'https://api.openai.com/v1',
  GPT_MODEL: 'gpt-5.6-sol',
  GPT_REASONING_EFFORT: 'high'
}
export interface SettingsSnapshot {
  preferences: Preferences
  models: Record<ModelKey, string>
  secrets: Record<
    SecretKey,
    { configured: boolean; stored: boolean; source: 'environment' | 'settings' | 'legacy' | 'none' }
  >
  encryptionAvailable: boolean
}
export interface SettingsUpdate {
  preferences: Preferences
  models?: Partial<Record<ModelKey, string>>
  secrets?: Partial<Record<SecretKey, string | null>>
}
export interface DiagnosticItem {
  id: string
  title: string
  status: 'ok' | 'warning' | 'error'
  detail: string
  help?: string
}
export interface DiagnosticReport {
  generatedAt: string
  appVersion: string
  platform: string
  items: DiagnosticItem[]
}

/** Copy only this intentionally narrow schema; never raw config, environment or process logs. */
export function diagnosticText(report: DiagnosticReport): string {
  return [
    `VidStudio ${report.appVersion} · ${report.platform}`,
    `检查时间：${report.generatedAt}`,
    '本地检查；未测试网络连通性、模型权限或 API 余额。',
    '',
    ...report.items.flatMap((item) => [
      `[${item.status}] ${item.title}：${item.detail}`,
      ...(item.help ? [`建议：${item.help}`] : [])
    ])
  ].join('\n')
}
