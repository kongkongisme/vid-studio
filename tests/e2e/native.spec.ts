import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const requireModule = createRequire(resolve('package.json'))
const executablePath = requireModule('electron') as string
const subtitle =
  '1\n00:00:01,250 --> 00:00:04,500\n缓存帮助减少重复计算。\n\n2\n00:02:01,000 --> 00:02:05,000\n失效策略决定数据的新鲜度。\n'

test('real IPC preserves imported sources, notes, exports and preferences across restarts', async () => {
  const testInfo = test.info()
  const directory = await mkdtemp(join(tmpdir(), 'vidstudio-native-test-'))
  const legacy = join(directory, 'empty.env')
  await writeFile(legacy, '')
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      !/API_KEY|TOKEN|SECRET|ELECTRON_RUN_AS_NODE|^VID_STUDIO_|^ELECTRON_RENDERER_URL$/.test(key)
    )
      env[key] = value
  }
  env.VID_STUDIO_DATA_DIR = join(directory, 'profile')
  env.VID_STUDIO_ENV_FILE = legacy
  let application: ElectronApplication | undefined
  let page: Page | undefined
  const rendererErrors: string[] = []
  async function launch(): Promise<Page> {
    application = await electron.launch({
      executablePath,
      args: [
        ...(process.env.CI && process.platform === 'linux' ? ['--no-sandbox'] : []),
        resolve('out/main/index.js')
      ],
      cwd: process.cwd(),
      env
    })
    await application.context().route(/^https?:\/\//, (route) => route.abort())
    const window = await application.firstWindow()
    window.on('pageerror', (error) => rendererErrors.push(error.message))
    await expect(window.getByRole('button', { name: '打开设置与诊断' })).toBeVisible()
    return window
  }
  try {
    page = await launch()
    expect(await application!.evaluate(({ app }) => app.getPath('userData'))).toBe(
      env.VID_STUDIO_DATA_DIR
    )
    const initial = await page.evaluate(() => window.api.getSettings())
    expect(initial.preferences.detectClipboard).toBe(false)
    expect(initial.preferences.autoImportCookies).toBe(false)
    expect(Object.values(initial.secrets).every((item) => !item.configured)).toBe(true)

    await page.getByRole('button', { name: '打开离线示例', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: '从看过到记住：三步整理学习笔记' })
    ).toBeVisible()
    await page.getByRole('button', { name: '写笔记', exact: true }).first().click()
    await page
      .getByRole('textbox', { name: '我的笔记' })
      .fill('下次读书时，先写下一个想解决的问题，再挑选值得复习的段落。')
    await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '收起笔记', exact: true }).click()
    await page.getByRole('button', { name: '收藏片段', exact: true }).first().click()
    await expect(page.getByRole('button', { name: '取消收藏片段' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await page.screenshot({ path: testInfo.outputPath('offline-demo-native.png') })

    await page.getByLabel('选择字幕或笔记文件').setInputFiles({
      name: '离线课程.srt',
      mimeType: 'text/plain',
      buffer: Buffer.from('\uFEFF' + subtitle, 'utf16le')
    })
    await expect(page.getByRole('article', { name: '导入资料阅读器' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '离线课程', exact: true })).toBeVisible()
    const reader = (): ReturnType<Page['getByRole']> =>
      page!.getByRole('article', { name: '导入资料阅读器' })
    const firstTitle = await reader().getByRole('heading', { level: 2 }).textContent()
    await page.getByRole('button', { name: '写笔记', exact: true }).first().click()
    await page.getByRole('textbox', { name: '我的笔记' }).fill('用缓存失效时间平衡成本和新鲜度。')
    await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '收藏片段', exact: true }).first().click()
    await expect(page.getByRole('button', { name: '取消收藏片段' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    const output = join(directory, 'export.json')
    await application!.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath })
    }, output)
    await page.getByRole('button', { name: '导出', exact: true }).click()
    const exportDialog = page.getByRole('dialog', { name: '导出时间轴' })
    await exportDialog.getByLabel('文件格式').selectOption('json')
    await exportDialog.getByRole('button', { name: '选择保存位置' }).click()
    await expect(exportDialog).not.toBeVisible()
    const exported = JSON.parse(await readFile(output, 'utf8'))
    expect(exported.chunks[0].transcript[0].seconds).toBe(1.25)
    expect(exported.chunks[0].transcript[0].endSeconds).toBe(4.5)
    expect(exported.chunks[0].userNote).toContain('平衡成本')
    expect(exported.chunks[0].bookmarked).toBe(true)

    const pdfOutput = testInfo.outputPath('offline-notes.pdf')
    await application!.evaluate(({ dialog, BrowserWindow }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath })
      BrowserWindow.getAllWindows()[0].setSize(900, 600)
      globalThis.fetch = async () => {
        throw new Error('Network must not be used for offline export')
      }
    }, pdfOutput)
    await page.getByRole('button', { name: '导出', exact: true }).click()
    await exportDialog.getByLabel('文件格式').selectOption('pdf')
    await exportDialog.getByLabel('文档标题', { exact: true }).fill('离线课程：复习讲义')
    await expect(
      exportDialog.getByLabel('使用 AI 重新拟定标题', { exact: false })
    ).not.toBeChecked()
    await expect(exportDialog.getByLabel('包含模型调用信息', { exact: false })).not.toBeChecked()
    await expect(exportDialog.getByRole('button', { name: '选择保存位置' })).toBeInViewport()
    await page.screenshot({ path: testInfo.outputPath('offline-export-small.png') })
    await exportDialog.getByRole('button', { name: '选择保存位置' }).click()
    await expect(exportDialog).not.toBeVisible()
    const pdf = await readFile(pdfOutput)
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF')
    expect(pdf.length).toBeGreaterThan(1000)
    await application!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1440, 820)
    )

    await reader().getByRole('button', { name: '下一片段' }).click()
    await expect(reader().getByText('阅读位置已保存', { exact: true })).toBeVisible()
    const secondTitle = await reader().getByRole('heading', { level: 2 }).textContent()
    expect(secondTitle).not.toBe(firstTitle)

    await page.getByRole('button', { name: '打开设置与诊断' }).click()
    const settingsDialog = page.getByRole('dialog', { name: '设置与诊断' })
    await settingsDialog.getByRole('tab', { name: '使用偏好' }).click()
    await settingsDialog.getByLabel('允许问答联网搜索', { exact: false }).uncheck()
    await settingsDialog.getByLabel('Python 程序路径').fill(join(directory, 'missing-python'))
    await settingsDialog.getByRole('button', { name: '保存设置', exact: true }).click()
    await expect(settingsDialog.getByText('设置已保存，下次请求会使用新配置。')).toBeVisible()
    await settingsDialog.getByRole('tab', { name: '环境诊断' }).click()
    await settingsDialog.getByRole('button', { name: '运行本地检查' }).click()
    await expect(settingsDialog.getByText('未找到可运行的 Python')).toBeVisible()
    await expect(settingsDialog.getByText('引擎文件完整')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('settings-native.png') })
    await settingsDialog.getByRole('button', { name: '关闭设置' }).click()

    await application!.close()
    application = undefined
    page = await launch()
    expect((await page.evaluate(() => window.api.getSettings())).preferences.allowWebSearch).toBe(
      false
    )
    await page.getByRole('button', { name: '打开资料库' }).click()
    const library = page.getByRole('dialog', { name: '资料库', exact: true })
    await library.getByRole('button', { name: '离线课程', exact: true }).click()
    await expect(reader().getByRole('heading', { level: 2 })).toHaveText(secondTitle!)
    await expect(reader().getByText('已回到上次阅读位置')).toBeVisible()
    await reader().getByRole('button', { name: '从头阅读' }).click()
    await expect(reader().getByRole('heading', { level: 2 })).toHaveText(firstTitle!)
    await expect(reader().getByText('阅读位置已保存', { exact: true })).toBeVisible()
    await reader().getByRole('button', { name: '下一片段' }).click()
    await expect(reader().getByText('阅读位置已保存', { exact: true })).toBeVisible()
    await application!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(900, 600)
    )
    await expect(reader().getByRole('button', { name: '从头阅读' })).toBeInViewport()
    await expect(reader().getByRole('button', { name: '上一片段' })).toBeInViewport()
    await page.screenshot({ path: testInfo.outputPath('reading-resume-small.png') })
    await application!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1440, 820)
    )
    await page.getByRole('button', { name: '打开资料库' }).click()
    await library.getByLabel('搜索标题、章节、原文和我的笔记').fill('平衡成本')
    await expect(
      library.getByText('用缓存失效时间平衡成本和新鲜度。', { exact: false })
    ).toBeVisible()
    await library.getByRole('button', { name: '离线课程', exact: true }).click()
    await expect(library).not.toBeVisible()
    await expect(reader().getByRole('heading', { level: 2 })).toHaveText(firstTitle!)
    await expect(page.getByRole('button', { name: '取消收藏片段' })).toBeVisible()
    await expect(
      page
        .locator('[id^="timeline-"]')
        .getByText('用缓存失效时间平衡成本和新鲜度。', { exact: true })
    ).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('library-restored-native.png') })
    expect(rendererErrors).toEqual([])
  } finally {
    await application?.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})
