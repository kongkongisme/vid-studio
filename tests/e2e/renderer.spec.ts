import { test, expect, type Page } from '@playwright/test'
import {
  DEFAULT_MODELS,
  DEFAULT_PREFERENCES,
  SECRET_KEYS,
  type DiagnosticReport,
  type SettingsSnapshot,
  type SettingsUpdate
} from '../../src/shared/settings'

interface MockState {
  clipboardReads: number
  cookieImports: number
  failLoad: boolean
  deferDiagnosis: boolean
  finishDiagnosis?: (report: DiagnosticReport) => void
  saved?: SettingsUpdate
  finishStop?: () => void
  finishParse?: () => void
}
declare global {
  interface Window {
    mockState: MockState
  }
}

async function installApi(page: Page): Promise<void> {
  const settings: SettingsSnapshot = {
    preferences: { ...DEFAULT_PREFERENCES },
    models: { ...DEFAULT_MODELS },
    secrets: Object.fromEntries(
      SECRET_KEYS.map((key) => [key, { configured: false, stored: false, source: 'none' }])
    ) as SettingsSnapshot['secrets'],
    encryptionAvailable: true
  }
  await page.addInitScript((initial) => {
    const snapshot = JSON.parse(localStorage.getItem('mock-settings') || JSON.stringify(initial))
    const state: MockState = {
      clipboardReads: 0,
      cookieImports: 0,
      failLoad: false,
      deferDiagnosis: false
    }
    window.mockState = state
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        readText: async () => {
          state.clipboardReads++
          return ''
        },
        writeText: async () => undefined
      }
    })
    const api: Partial<Window['api']> = {
      getSettings: async () => {
        if (state.failLoad) throw new Error('mock settings unavailable')
        return structuredClone(snapshot)
      },
      saveSettings: async (update) => {
        state.saved = update
        snapshot.preferences = update.preferences
        snapshot.models = { ...snapshot.models, ...update.models }
        for (const [key, value] of Object.entries(update.secrets || {})) {
          if (value) snapshot.secrets[key] = { configured: true, stored: true, source: 'settings' }
        }
        localStorage.setItem('mock-settings', JSON.stringify(snapshot))
        return structuredClone(snapshot)
      },
      diagnoseEnvironment: async () => {
        if (state.deferDiagnosis)
          return new Promise((resolve) => {
            state.finishDiagnosis = resolve
          })
        return { generatedAt: '', appVersion: 'test', platform: 'test', items: [] }
      },
      importBrowserCookies: async () => {
        state.cookieImports++
        return { success: false }
      },
      importYoutubeCookies: async () => {
        state.cookieImports++
        return { success: false }
      },
      getConversation: async () => [],
      getAnnotations: async () => [],
      onParseProgress: () => () => undefined,
      parseVideo: () =>
        new Promise((resolve) => {
          state.finishParse = () => resolve({ success: false, error: '已停止解析' })
        }),
      stopParse: () =>
        new Promise((resolve) => {
          state.finishStop = resolve
        }),
      onChatEvent: () => () => undefined,
      onLocalPlaybackProgress: () => () => undefined
    }
    Object.defineProperty(window, 'api', { value: api })
  }, settings)
}

test.beforeEach(async ({ page }) => {
  await installApi(page)
  await page.goto('/')
  await expect(page.getByRole('button', { name: '打开设置与诊断' })).toBeVisible()
})

test('startup keeps clipboard and browser cookies untouched until preferences are enabled', async ({
  page
}) => {
  await page.clock.install()
  await page.clock.runFor(2500)
  expect(
    await page.evaluate(() => [window.mockState.clipboardReads, window.mockState.cookieImports])
  ).toEqual([0, 0])
  await page.getByRole('button', { name: '打开设置与诊断' }).click()
  const dialog = page.getByRole('dialog', { name: '设置与诊断' })
  await dialog.getByRole('tab', { name: '使用偏好' }).click()
  await dialog.getByLabel('启动时同步浏览器账号', { exact: false }).check()
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click()
  await expect(dialog.getByText('设置已保存，下次请求会使用新配置。')).toBeVisible()
  await page.reload()
  await expect.poll(() => page.evaluate(() => window.mockState.cookieImports)).toBe(2)
  expect(await page.evaluate(() => window.mockState.clipboardReads)).toBe(0)
})

test('settings clear typed secrets, support keyboard tabs and fit a 900 by 600 window', async ({
  page
}) => {
  await page.setViewportSize({ width: 900, height: 600 })
  const trigger = page.getByRole('button', { name: '打开设置与诊断' })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: '设置与诊断' })
  const key = dialog.getByLabel('DeepSeek API Key', { exact: true })
  await key.fill('synthetic-test-key')
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click()
  await expect(key).toHaveValue('')
  expect(await page.evaluate(() => window.mockState.saved?.secrets?.DEEPSEEK_API_KEY)).toBe(
    'synthetic-test-key'
  )
  await dialog.getByRole('tab', { name: '模型与服务' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(dialog.getByRole('tab', { name: '环境诊断' })).toBeFocused()
  await expect(dialog.getByRole('tab', { name: '环境诊断' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await page.keyboard.press('End')
  await expect(dialog.getByRole('tab', { name: '使用偏好' })).toBeFocused()
  const box = await dialog.boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.height + box!.y).toBeLessThanOrEqual(600)
  await expect(dialog.getByRole('button', { name: '保存设置', exact: true })).toBeInViewport()
  await page.screenshot({ path: test.info().outputPath('settings-small.png') })
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(trigger).toBeFocused()
})

test('failed reloads and stale diagnosis cannot restore outdated settings', async ({ page }) => {
  await page.getByRole('button', { name: '打开设置与诊断' }).click()
  const dialog = page.getByRole('dialog', { name: '设置与诊断' })
  await expect(dialog.getByLabel('DeepSeek API Key', { exact: true })).toBeVisible()
  await page.evaluate(() => {
    window.mockState.deferDiagnosis = true
  })
  await dialog.getByRole('tab', { name: '环境诊断' }).click()
  await dialog.getByRole('button', { name: '运行本地检查' }).click()
  await expect(dialog.getByRole('button', { name: '正在检查…' })).toBeDisabled()
  await dialog.getByRole('tab', { name: '使用偏好' }).click()
  await dialog.getByLabel('允许问答联网搜索', { exact: false }).uncheck()
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click()
  await expect(dialog.getByText('设置已保存，下次请求会使用新配置。')).toBeVisible()
  await page.evaluate(() =>
    window.mockState.finishDiagnosis?.({
      generatedAt: '',
      appVersion: '',
      platform: '',
      items: [{ id: 'stale', title: '过期诊断', status: 'ok', detail: '不应展示' }]
    })
  )
  await dialog.getByRole('tab', { name: '环境诊断' }).click()
  await expect(dialog.getByText('过期诊断')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: '运行本地检查' })).toBeEnabled()
  await page.keyboard.press('Escape')
  await page.evaluate(() => {
    window.mockState.failLoad = true
  })
  await page.getByRole('button', { name: '打开设置与诊断' }).click()
  await expect(dialog.getByRole('alert')).toContainText('mock settings unavailable')
  await expect(dialog.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled()
  await expect(dialog.getByLabel('DeepSeek API Key', { exact: true })).toHaveCount(0)
})

test('keeps source controls locked until the background process tree has stopped', async ({
  page
}) => {
  await page.getByPlaceholder(/粘贴.*链接/).fill('https://www.bilibili.com/video/BV1xx411c7mD')
  await page.getByRole('button', { name: '一键解析', exact: true }).click()
  await expect.poll(() => page.evaluate(() => Boolean(window.mockState.finishParse))).toBe(true)
  await page.getByRole('button', { name: '停止解析', exact: true }).click()
  await expect(page.getByRole('button', { name: '正在停止…', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '打开资料库' })).toBeDisabled()
  await page.evaluate(() => window.mockState.finishParse?.())
  await expect(page.getByRole('button', { name: '正在停止…', exact: true })).toBeVisible()
  await page.evaluate(() => window.mockState.finishStop?.())
  await expect(page.getByRole('button', { name: '一键解析', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '打开资料库' })).toBeEnabled()
})
