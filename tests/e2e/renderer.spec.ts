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
  parseCalls: number
  cachedSources: string[]
  failLoad: boolean
  deferDiagnosis: boolean
  finishDiagnosis?: (report: DiagnosticReport) => void
  saved?: SettingsUpdate
  finishStop?: () => void
  finishParse?: () => void
  playbackRequests: {
    filePath: string
    requestId: string
    finish: (result: { success: boolean; error?: string }) => void
  }[]
  canceledPlaybacks: number
  emitPlayback?: Parameters<NonNullable<Window['api']['onLocalPlaybackProgress']>>[0]
  libraryExports: Parameters<Window['api']['exportLibrary']>[0][]
  librarySize: number
  clipboardWrites: string[]
  failClipboardWrite: boolean
  finishLibraryExport?: (result: Awaited<ReturnType<Window['api']['exportLibrary']>>) => void
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
      parseCalls: 0,
      cachedSources: [],
      playbackRequests: [],
      canceledPlaybacks: 0,
      failLoad: false,
      deferDiagnosis: false,
      libraryExports: [],
      librarySize: 3,
      clipboardWrites: [],
      failClipboardWrite: false
    }
    window.mockState = state
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        readText: async () => {
          state.clipboardReads++
          return ''
        },
        writeText: async (text: string) => {
          if (state.failClipboardWrite) throw new Error('Clipboard permission denied')
          state.clipboardWrites.push(text)
        }
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
      saveAnnotation: async (input) => ({ ...input, updatedAt: Date.now() }),
      getReadingPosition: async () => null,
      saveReadingPosition: async (input) => ({ ...input, updatedAt: Date.now() }),
      setCache: async (key) => {
        state.cachedSources.push(key)
      },
      addHistory: async () => undefined,
      searchLibrary: async (query) => {
        const sourceIds =
          state.librarySize === 3
            ? ['one', 'two', 'missing']
            : Array.from({ length: state.librarySize }, (_, n) => String(n + 1))
        const entries = sourceIds
          .map((id) => ({
            item: {
              id,
              url: `document:${id}`,
              title: `资料 ${id}`,
              platform: 'document' as const,
              mode: 'imported' as const,
              createdAt: 1,
              favorited: id === 'one'
            },
            cached: id !== 'missing',
            matches: [],
            moreMatches: false
          }))
          .filter(
            (entry) =>
              (!query.favoritesOnly || entry.item.favorited) &&
              (!query.query || entry.item.title.includes(query.query))
          )
        return {
          entries: entries.slice(query.offset || 0, (query.offset || 0) + 50),
          total: entries.length,
          totalSources: sourceIds.length,
          unavailableSources: state.librarySize === 3 ? 1 : 0
        }
      },
      exportLibrary: (request) => {
        state.libraryExports.push(request)
        return new Promise((resolve) => {
          state.finishLibraryExport = resolve
        })
      },
      onParseProgress: () => () => undefined,
      parseVideo: () => {
        state.parseCalls++
        return new Promise((resolve) => {
          state.finishParse = () => resolve({ success: false, error: '已停止解析' })
        })
      },
      stopParse: () =>
        new Promise((resolve) => {
          state.finishStop = resolve
        }),
      onChatEvent: () => () => undefined,
      getPathForFile: (file) => `/mock/${file.name}`,
      prepareLocalVideoPlayback: (filePath, _forceProxy, requestId) =>
        new Promise((resolve) => {
          state.playbackRequests.push({ filePath, requestId: requestId!, finish: resolve })
        }),
      cancelLocalVideoPlayback: async () => {
        state.canceledPlaybacks++
      },
      onLocalPlaybackProgress: (callback) => {
        state.emitPlayback = callback
        return () => {
          state.emitPlayback = undefined
        }
      }
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

test('opens the built-in example offline and navigates adjacent chapter boundaries correctly', async ({
  page
}) => {
  await page.setViewportSize({ width: 900, height: 600 })
  await expect(page.getByRole('button', { name: '打开设置与诊断' })).toBeInViewport()
  await expect(page.getByRole('button', { name: '打开资料库' })).toBeInViewport()
  await expect(page.getByRole('button', { name: '一键解析', exact: true })).toBeInViewport()
  await page.screenshot({ path: test.info().outputPath('welcome-small.png') })
  await page.getByRole('button', { name: '打开离线示例', exact: true }).click()
  const reader = page.getByRole('article', { name: '导入资料阅读器' })
  await expect(
    reader.getByRole('heading', { name: '从看过到记住：三步整理学习笔记' })
  ).toBeVisible()
  await expect(reader.getByText(/虚构示例/)).toBeVisible()
  await page
    .locator('[id^="timeline-"]')
    .getByText('用自己的话补上一句理解', { exact: true })
    .click()
  await expect(reader.getByRole('heading', { level: 2 })).toHaveText('用自己的话补上一句理解')
  await expect(reader.getByText('阅读位置已保存', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '写笔记', exact: true }).first().click()
  await page.getByRole('textbox', { name: '我的笔记' }).fill('先确定问题，再挑选原文。')
  await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.mockState.parseCalls)).toBe(0)
  expect(await page.evaluate(() => window.mockState.cachedSources)).toHaveLength(1)
  await expect(page.getByRole('button', { name: '导出', exact: true })).toBeEnabled()
  await page.screenshot({ path: test.info().outputPath('demo-small.png') })
  await page.getByLabel('选择字幕或笔记文件').setInputFiles({
    name: '损坏字幕.srt',
    mimeType: 'text/plain',
    buffer: Buffer.from([0xe4, 0xb8])
  })
  await expect(page.getByRole('alert')).toContainText('无法识别文字编码')
  await expect(
    reader.getByRole('heading', { name: '从看过到记住：三步整理学习笔记' })
  ).toBeVisible()
  expect(await page.evaluate(() => window.mockState.cachedSources)).toHaveLength(1)
})

test('ignores old playback results for the same file and cancels previews when leaving it', async ({
  page
}) => {
  const file = { name: 'repeat.mp4', mimeType: 'video/mp4', buffer: Buffer.from('invalid video') }
  const input = page.getByLabel('选择本地视频文件', { exact: true })
  await input.setInputFiles(file)
  // The invalid source exercises the automatic fallback as well as the initial request.
  await expect.poll(() => page.evaluate(() => window.mockState.playbackRequests.length)).toBe(2)
  await input.setInputFiles(file)
  await expect.poll(() => page.evaluate(() => window.mockState.playbackRequests.length)).toBe(4)
  await page.evaluate(() => {
    const state = window.mockState
    const old = state.playbackRequests[1]
    const current = state.playbackRequests[3]
    state.emitPlayback?.({
      filePath: current.filePath,
      requestId: current.requestId,
      status: 'converting',
      progress: 35,
      message: '当前预览 35%'
    })
    state.emitPlayback?.({
      filePath: old.filePath,
      requestId: old.requestId,
      status: 'error',
      progress: 0,
      message: '过期预览错误'
    })
    old.finish({ success: false, error: '过期预览错误' })
  })
  await expect(page.getByText('当前预览 35%', { exact: true })).toBeVisible()
  await expect(page.getByText('过期预览错误')).toHaveCount(0)
  await page.getByLabel('选择字幕或笔记文件').setInputFiles({
    name: 'reading.srt',
    mimeType: 'text/plain',
    buffer: Buffer.from('1\n00:00:01,000 --> 00:00:03,000\n切换到阅读资料。\n')
  })
  await expect(page.getByRole('article', { name: '导入资料阅读器' })).toBeVisible()
  expect(await page.evaluate(() => window.mockState.canceledPlaybacks)).toBeGreaterThan(0)
  await page.evaluate(() => {
    const state = window.mockState
    const current = state.playbackRequests[3]
    state.emitPlayback?.({
      filePath: current.filePath,
      requestId: current.requestId,
      status: 'error',
      progress: 0,
      message: '离开后的旧错误'
    })
    current.finish({ success: false, error: '离开后的旧错误' })
  })
  await expect(page.getByRole('article', { name: '导入资料阅读器' })).toBeVisible()
  await expect(page.getByText('离开后的旧错误')).toHaveCount(0)
})

test('bulk export keeps selection explicit, handles cancellation and failure, and locks pending actions', async ({
  page
}) => {
  await page.setViewportSize({ width: 900, height: 600 })
  const trigger = page.getByRole('button', { name: '打开资料库' })
  await trigger.click()
  const library = page.getByRole('dialog', { name: '资料库', exact: true })
  await library.getByRole('button', { name: '批量导出', exact: true }).click()
  await expect(library.getByRole('button', { name: '导出所选（0）' })).toBeDisabled()
  await expect(library.getByLabel('选择资料：资料 missing', { exact: true })).toBeDisabled()
  await library.getByLabel('选择资料：资料 one', { exact: true }).check()
  await expect(library.getByLabel('选择已显示资料', { exact: true })).toHaveJSProperty(
    'indeterminate',
    true
  )
  await library.getByLabel('选择已显示资料', { exact: true }).check()
  await library.getByRole('combobox', { name: '导出格式', exact: true }).selectOption('json')
  await library.getByLabel('附带个人笔记与收藏', { exact: true }).uncheck()
  await library.getByRole('button', { name: '导出所选（2）' }).click()
  await expect(library.getByRole('button', { name: '正在导出…' })).toBeDisabled()
  await expect(library.getByLabel('搜索标题、章节、原文和我的笔记')).toBeDisabled()
  await expect(library.getByRole('button', { name: '关闭资料库' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(library).toBeVisible()
  expect(await page.evaluate(() => window.mockState.libraryExports[0])).toEqual({
    ids: ['one', 'two'],
    format: 'json',
    includeTranscript: true,
    includeAnnotations: false
  })
  await page.evaluate(() =>
    window.mockState.finishLibraryExport?.({ success: false, canceled: true })
  )
  await expect(library.getByRole('button', { name: '导出所选（2）' })).toBeEnabled()
  await expect(library.getByRole('alert')).toHaveCount(0)
  await library.getByRole('button', { name: '导出所选（2）' }).click()
  await page.evaluate(() =>
    window.mockState.finishLibraryExport?.({ success: false, error: '模拟磁盘空间不足' })
  )
  await expect(library.getByRole('alert')).toContainText('模拟磁盘空间不足')
  await library.getByRole('button', { name: '导出所选（2）' }).click()
  await page.evaluate(() =>
    window.mockState.finishLibraryExport?.({
      success: true,
      count: 2,
      path: '/chosen/VidStudio-test'
    })
  )
  await expect(library.getByRole('status')).toContainText('已导出 2 份资料')
  await library.getByLabel('搜索标题、章节、原文和我的笔记').fill('one')
  await expect(library.getByRole('button', { name: '导出所选（0）' })).toBeDisabled()
  await expect(library.getByRole('status')).toHaveCount(0)
  await expect(library.getByLabel('选择资料：资料 two', { exact: true })).toHaveCount(0)
  await library.getByLabel('选择已显示资料', { exact: true }).check()
  await expect(library.getByRole('button', { name: '导出所选（1）' })).toBeInViewport()
  await page.screenshot({ path: test.info().outputPath('library-export-small.png') })
  await page.keyboard.press('Escape')
  await expect(library).not.toBeVisible()
  await expect(trigger).toBeFocused()
})

test('bulk selection survives pagination, caps at 200 and clears when filtering changes', async ({
  page
}) => {
  await page.evaluate(() => {
    window.mockState.librarySize = 250
  })
  await page.getByRole('button', { name: '打开资料库' }).click()
  const library = page.getByRole('dialog', { name: '资料库', exact: true })
  await library.getByRole('button', { name: '批量导出', exact: true }).click()
  await library.getByLabel('选择已显示资料', { exact: true }).check()
  await expect(library.getByRole('button', { name: '导出所选（50）' })).toBeEnabled()
  for (let pageNumber = 2; pageNumber <= 5; pageNumber++) {
    await library.getByRole('button', { name: /加载更多/ }).click()
    await expect(
      library.getByLabel(`选择资料：资料 ${pageNumber * 50}`, { exact: true })
    ).toHaveCount(1)
  }
  await expect(library.getByLabel('选择资料：资料 1', { exact: true })).toBeChecked()
  const bulk = library.getByLabel('选择前 200 份已显示资料', { exact: true })
  await bulk.check()
  await expect(library.getByRole('button', { name: '导出所选（200）' })).toBeEnabled()
  await expect(library.getByLabel('选择资料：资料 201', { exact: true })).toBeDisabled()
  await bulk.uncheck()
  await expect(library.getByLabel('选择资料：资料 201', { exact: true })).toBeEnabled()
  await library.getByLabel('选择资料：资料 201', { exact: true }).check()
  await library.getByLabel('仅看收藏资料', { exact: true }).check()
  await expect(library.getByRole('button', { name: '导出所选（0）' })).toBeDisabled()
  await expect(library.getByText('还没有收藏资料，点击资料旁的星标即可收藏。')).toBeVisible()
})

test('copies canonical timestamp links from imported online sources and supports retry after clipboard errors', async ({
  page
}) => {
  await page.getByRole('button', { name: '打开离线示例', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: '从看过到记住：三步整理学习笔记', exact: true })
  ).toBeVisible()
  await expect(page.getByRole('button', { name: '导入资料', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: '复制原视频链接', exact: true })).toHaveCount(0)
  await page.getByLabel('选择字幕或笔记文件').setInputFiles({
    name: 'linked.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        type: 'vidstudio-timeline',
        version: 1,
        title: '带来源的课程',
        sourceKind: 'notes',
        sourceUrl: 'https://youtu.be/abcdefgh-_1?si=tracking',
        chunks: [
          {
            id: 'linked',
            startSeconds: 65.5,
            endSeconds: 120,
            title: '带时间的章节',
            summary: '回到证据',
            transcript: []
          }
        ]
      })
    )
  })
  await page.setViewportSize({ width: 900, height: 600 })
  await expect(page.getByRole('heading', { name: '带来源的课程', exact: true })).toBeVisible()
  const copy = page.getByRole('button', { name: '复制原视频链接', exact: true })
  await expect(copy).toBeInViewport()
  await page.evaluate(() => {
    window.mockState.failClipboardWrite = true
  })
  await copy.click()
  await expect(page.getByRole('alert')).toContainText('复制失败，请重试')
  await page.evaluate(() => {
    window.mockState.failClipboardWrite = false
  })
  await copy.click()
  await expect(
    page.getByRole('status').filter({ hasText: '原视频时间戳链接已复制' })
  ).toBeAttached()
  expect(await page.evaluate(() => window.mockState.clipboardWrites)).toEqual([
    'https://www.youtube.com/watch?v=abcdefgh-_1&t=65'
  ])
  await expect(page.getByText('复制失败，请重试')).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('source-link-small.png') })
})
