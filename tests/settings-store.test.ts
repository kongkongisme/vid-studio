import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SettingsStore, configuredSecret, type SecretCipher } from '../src/main/settings-store'
import { DEFAULT_PREFERENCES } from '../src/shared/settings'

let directory: string
let file: string
let legacy: string
let cipher: SecretCipher
let store: SettingsStore
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vidstudio-settings-'))
  file = path.join(directory, 'settings.json')
  legacy = path.join(directory, 'legacy.env')
  // The storage contract is tested with an injected cipher; production uses Electron safeStorage.
  cipher = {
    available: vi.fn(() => true),
    encrypt: vi.fn((value) => Buffer.from('sealed:' + [...value].reverse().join(''))),
    decrypt: vi.fn((value) => [...value.toString().slice(7)].reverse().join(''))
  }
  store = new SettingsStore(file, legacy, cipher, {})
})
afterEach(() => fs.rm(directory, { recursive: true, force: true }))

describe('private application settings', () => {
  it('encrypts supplied keys, never returns them to the renderer and keeps blank fields unchanged', async () => {
    await store.save({
      preferences: DEFAULT_PREFERENCES,
      secrets: { DEEPSEEK_API_KEY: 'sensitive-example-12345' }
    })
    expect(cipher.encrypt).toHaveBeenCalledWith('sensitive-example-12345')
    expect(await fs.readFile(file, 'utf8')).not.toContain('sensitive-example-12345')
    const snapshot = await store.snapshot()
    expect(snapshot.secrets.DEEPSEEK_API_KEY).toEqual({
      configured: true,
      stored: true,
      source: 'settings'
    })
    expect(JSON.stringify(snapshot)).not.toContain('sensitive-example-12345')
    await store.save({ preferences: DEFAULT_PREFERENCES, secrets: { DEEPSEEK_API_KEY: '' } })
    expect((await store.values()).DEEPSEEK_API_KEY).toBe('sensitive-example-12345')
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
  })

  it('preserves dotenv quoting and uses environment > saved settings > legacy configuration', async () => {
    await fs.writeFile(
      legacy,
      'export DEEPSEEK_API_KEY="legacy#token" # a comment\nGPT_API_KEY=sk-your-key-here\nLLM_MAX_WORKERS=8\n'
    )
    expect((await store.values()).DEEPSEEK_API_KEY).toBe('legacy#token')
    expect((await store.snapshot()).secrets.GPT_API_KEY.configured).toBe(false)
    await store.save({
      preferences: DEFAULT_PREFERENCES,
      secrets: { DEEPSEEK_API_KEY: 'saved-token' }
    })
    expect((await store.values()).DEEPSEEK_API_KEY).toBe('saved-token')
    const fromEnvironment = new SettingsStore(file, legacy, cipher, {
      DEEPSEEK_API_KEY: 'environment-token'
    })
    expect((await fromEnvironment.values()).DEEPSEEK_API_KEY).toBe('environment-token')
    expect((await fromEnvironment.values()).LLM_MAX_WORKERS).toBe('8')
    expect((await fromEnvironment.snapshot()).secrets.DEEPSEEK_API_KEY.source).toBe('environment')
  })

  it('allows preferences without a keychain but never falls back to plaintext key storage', async () => {
    vi.mocked(cipher.available).mockReturnValue(false)
    await store.save({ preferences: { ...DEFAULT_PREFERENCES, detectClipboard: true } })
    const previous = await fs.readFile(file, 'utf8')
    await expect(
      store.save({ preferences: DEFAULT_PREFERENCES, secrets: { GPT_API_KEY: 'secret-token' } })
    ).rejects.toThrow('密钥库')
    expect(await fs.readFile(file, 'utf8')).toBe(previous)
  })

  it('clears only the saved key and can disable web search without deleting credentials', async () => {
    await fs.writeFile(legacy, 'DEEPSEEK_API_KEY=legacy-token')
    await store.save({
      preferences: { ...DEFAULT_PREFERENCES, allowWebSearch: false },
      secrets: { DEEPSEEK_API_KEY: 'stored-token', TAVILY_API_KEY: 'tvly-private-token' }
    })
    expect((await store.values()).TAVILY_API_KEY).toBe('')
    expect((await store.snapshot()).secrets.TAVILY_API_KEY.configured).toBe(true)
    await store.save({ preferences: DEFAULT_PREFERENCES, secrets: { DEEPSEEK_API_KEY: null } })
    expect((await store.values()).DEEPSEEK_API_KEY).toBe('legacy-token')
    expect((await store.snapshot()).secrets.DEEPSEEK_API_KEY.stored).toBe(false)
    expect((await store.values()).TAVILY_API_KEY).toBe('tvly-private-token')
  })

  it('serializes independent updates and preserves the file on bad models or corruption', async () => {
    await Promise.all([
      store.save({
        preferences: DEFAULT_PREFERENCES,
        secrets: { DEEPSEEK_API_KEY: 'first-token' }
      }),
      store.save({ preferences: DEFAULT_PREFERENCES, secrets: { GPT_API_KEY: 'second-token' } })
    ])
    expect((await store.values()).DEEPSEEK_API_KEY).toBe('first-token')
    const previous = await fs.readFile(file, 'utf8')
    await expect(
      store.save({
        preferences: DEFAULT_PREFERENCES,
        models: { GPT_BASE_URL: 'https://user:password@example.org/v1?key=secret' }
      })
    ).rejects.toThrow('接口地址')
    expect(await fs.readFile(file, 'utf8')).toBe(previous)
    await fs.writeFile(file, '{broken')
    await expect(store.save({ preferences: DEFAULT_PREFERENCES })).rejects.toThrow('原文件已保留')
    expect(await fs.readFile(file, 'utf8')).toBe('{broken')
  })

  it('rejects placeholder secrets and invalid executable paths without invoking a shell', async () => {
    expect(configuredSecret('your-key-here')).toBe(false)
    expect(configuredSecret('sk-real-value')).toBe(true)
    await expect(
      store.save({ preferences: DEFAULT_PREFERENCES, secrets: { GPT_API_KEY: 'sk-your-key-here' } })
    ).rejects.toThrow('示例值')
    await expect(
      store.save({ preferences: { ...DEFAULT_PREFERENCES, pythonPath: 'python\nother-command' } })
    ).rejects.toThrow('偏好设置')
  })

  it.each(['models', 'encrypted'])(
    'preserves malformed %s maps instead of treating them as empty',
    async (field) => {
      const malformed = JSON.stringify({
        version: 1,
        preferences: DEFAULT_PREFERENCES,
        models: {},
        encrypted: {},
        [field]: []
      })
      await fs.writeFile(file, malformed)
      await expect(store.snapshot()).rejects.toThrow('原文件已保留')
      await expect(store.save({ preferences: DEFAULT_PREFERENCES })).rejects.toThrow('原文件已保留')
      expect(await fs.readFile(file, 'utf8')).toBe(malformed)
    }
  )

  it('keeps omitted reasoning distinct from a model-specific none value', async () => {
    await store.save({ preferences: DEFAULT_PREFERENCES, models: { GPT_REASONING_EFFORT: 'omit' } })
    expect((await store.values()).GPT_REASONING_EFFORT).toBe('omit')
    await store.save({ preferences: DEFAULT_PREFERENCES, models: { GPT_REASONING_EFFORT: 'none' } })
    expect((await store.values()).GPT_REASONING_EFFORT).toBe('none')
  })
})
