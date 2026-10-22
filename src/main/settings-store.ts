import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseEnv } from 'node:util'
import {
  DEFAULT_PREFERENCES,
  DEFAULT_MODELS,
  SECRET_KEYS,
  MODEL_KEYS,
  type Preferences,
  type SettingsSnapshot,
  type SettingsUpdate,
  type SecretKey,
  type ModelKey
} from '../shared/settings'

export interface SecretCipher {
  available: () => boolean
  encrypt: (value: string) => Buffer
  decrypt: (value: Buffer) => string
}
interface StoredSettings {
  version: 1
  preferences: Preferences
  models: Partial<Record<ModelKey, string>>
  encrypted: Partial<Record<SecretKey, string>>
}
const TUNING_KEYS = ['LLM_MAX_WORKERS', 'EMBED_CACHE_ENABLED', 'VID_CACHE_DIR', 'LLM_PROVIDER']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function configuredSecret(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    Boolean(value.trim()) &&
    !/your[-_ ]|replace[-_ ]|^<.*>$|^sk-xxx|^example$/i.test(value.trim())
  )
}

function validatePreferences(input: Preferences): Preferences {
  if (
    !input ||
    ['detectClipboard', 'autoImportCookies', 'allowWebSearch'].some(
      (key) => typeof input[key] !== 'boolean'
    ) ||
    typeof input.pythonPath !== 'string' ||
    input.pythonPath.length > 4096 ||
    /[\r\n\0]/.test(input.pythonPath)
  )
    throw new Error('偏好设置格式无效')
  return {
    detectClipboard: input.detectClipboard,
    autoImportCookies: input.autoImportCookies,
    allowWebSearch: input.allowWebSearch,
    pythonPath: input.pythonPath.trim()
  }
}

function validateModel(key: ModelKey, value: string): string {
  if (typeof value !== 'string' || value.length > 1000 || /[\r\n\0]/.test(value))
    throw new Error('模型配置格式无效')
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (key.endsWith('_BASE_URL')) {
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      throw new Error('接口地址需要完整的 http:// 或 https:// URL')
    }
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new Error('接口地址不能包含账号密码、查询参数或片段')
    if (parsed.hostname.endsWith('.example')) throw new Error('请替换示例接口地址')
    return trimmed.replace(/\/+$/, '')
  }
  if (
    key === 'GPT_REASONING_EFFORT' &&
    !['omit', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(trimmed)
  )
    throw new Error('推理强度不受支持')
  return trimmed
}

/** Keys stay encrypted on disk and are never returned to renderer snapshots. */
export class SettingsStore {
  private pending: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly legacyEnvPath: string,
    private readonly cipher: SecretCipher,
    private readonly environment: NodeJS.ProcessEnv = process.env
  ) {}

  private async read(): Promise<StoredSettings> {
    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: 1, preferences: { ...DEFAULT_PREFERENCES }, models: {}, encrypted: {} }
      throw new Error('无法读取设置文件，原文件未修改。', { cause: error })
    }
    try {
      const data = JSON.parse(raw) as StoredSettings
      if (
        !isRecord(data) ||
        data.version !== 1 ||
        !isRecord(data.models) ||
        !isRecord(data.encrypted)
      )
        throw new Error('Unsupported settings format')
      data.preferences = validatePreferences(data.preferences)
      for (const key of MODEL_KEYS)
        if (data.models[key] !== undefined) validateModel(key, data.models[key]!)
      for (const key of SECRET_KEYS)
        if (data.encrypted[key] !== undefined && typeof data.encrypted[key] !== 'string')
          throw new Error('Invalid ciphertext')
      return data
    } catch (error) {
      throw new Error('设置文件损坏，原文件已保留。', { cause: error })
    }
  }

  private async legacy(): Promise<Record<string, string>> {
    try {
      return Object.fromEntries(
        Object.entries(parseEnv(await fs.readFile(this.legacyEnvPath, 'utf8'))).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw new Error('无法读取现有环境配置文件', { cause: error })
    }
  }

  async snapshot(): Promise<SettingsSnapshot> {
    await this.pending
    const [stored, legacy] = await Promise.all([this.read(), this.legacy()])
    const models = Object.fromEntries(
      MODEL_KEYS.map((key) => [
        key,
        this.environment[key] ?? stored.models[key] ?? legacy[key] ?? DEFAULT_MODELS[key]
      ])
    ) as Record<ModelKey, string>
    const secrets = Object.fromEntries(
      SECRET_KEYS.map((key) => {
        const source =
          this.environment[key] !== undefined
            ? 'environment'
            : stored.encrypted[key]
              ? 'settings'
              : legacy[key]
                ? 'legacy'
                : 'none'
        const configured =
          source === 'settings' ||
          configuredSecret(source === 'environment' ? this.environment[key] : legacy[key])
        return [
          key,
          {
            configured,
            stored: Boolean(stored.encrypted[key]),
            source: configured ? source : 'none'
          }
        ]
      })
    ) as SettingsSnapshot['secrets']
    return {
      preferences: stored.preferences,
      models,
      secrets,
      encryptionAvailable: this.cipher.available()
    }
  }

  async values(): Promise<Record<string, string>> {
    await this.pending
    const [stored, legacy] = await Promise.all([this.read(), this.legacy()])
    const values: Record<string, string> = {}
    for (const key of [...MODEL_KEYS, ...TUNING_KEYS]) {
      const value =
        this.environment[key] ?? stored.models[key] ?? legacy[key] ?? DEFAULT_MODELS[key]
      if (value !== undefined) values[key] = value
    }
    for (const key of SECRET_KEYS) {
      let value = this.environment[key]
      if (value === undefined && stored.encrypted[key]) {
        if (!this.cipher.available())
          throw new Error('系统密钥库不可用，无法读取已保存的 API Key。')
        try {
          value = this.cipher.decrypt(Buffer.from(stored.encrypted[key]!, 'base64'))
        } catch {
          throw new Error(`无法解密 ${key}，请在设置中重新保存此密钥。`)
        }
      }
      value ??= legacy[key] ?? ''
      values[key] = configuredSecret(value) ? value : ''
    }
    if (!stored.preferences.allowWebSearch) values.TAVILY_API_KEY = ''
    return values
  }

  save(update: SettingsUpdate): Promise<void> {
    const operation = this.pending.then(async () => {
      const stored = await this.read()
      stored.preferences = validatePreferences(update.preferences)
      for (const [key, value] of Object.entries(update.models ?? {})) {
        if (!MODEL_KEYS.includes(key as ModelKey)) throw new Error('未知模型设置项')
        const checked = validateModel(key as ModelKey, value)
        if (checked) stored.models[key] = checked
        else delete stored.models[key]
      }
      for (const [key, value] of Object.entries(update.secrets ?? {})) {
        if (!SECRET_KEYS.includes(key as SecretKey)) throw new Error('未知密钥设置项')
        if (value === null) {
          delete stored.encrypted[key]
          continue
        }
        if (value === '') continue
        if (!configuredSecret(value) || value!.length > 4096 || /[\r\n\0]/.test(value!))
          throw new Error('请填写有效的 API Key，不要保留示例值。')
        if (!this.cipher.available())
          throw new Error(
            '系统密钥库不可用，无法加密保存。可使用环境变量配置，或先启用系统密钥库。'
          )
        stored.encrypted[key] = this.cipher.encrypt(value!.trim()).toString('base64')
      }
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temporary, JSON.stringify(stored, null, 2), { flag: 'wx', mode: 0o600 })
        await fs.rename(temporary, this.filePath)
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined)
      }
    })
    this.pending = operation.catch(() => undefined)
    return operation
  }
}
