import { app, shell, BrowserWindow, ipcMain, session } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { spawn, type ChildProcess } from 'child_process'
import { readFile } from 'fs/promises'
import { tmpdir } from 'os'
import icon from '../../resources/icon.png?asset'

const pythonBin = process.platform === 'win32' ? 'python' : 'python3'

const vidEnginePath = is.dev
  ? join(process.cwd(), 'vid-engine')
  : join(process.resourcesPath, 'vid-engine')

// ─── 工具：运行 Python 脚本并收集 stdout ──────────────────
function runPython(scriptName: string, args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    const proc = spawn(pythonBin, [scriptName, ...args], { cwd: vidEnginePath })
    proc.stdout.on('data', (d: Buffer) => (out += d.toString()))
    proc.on('close', () => resolve(out))
    proc.on('error', reject)
  })
}

// ─── 窗口创建 ────────────────────────────────────────────
function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webviewTag: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ─── IPC：从浏览器导入 B 站 cookies ──────────────────────
ipcMain.handle('import-browser-cookies', async () => {
  try {
    const raw = await runPython('extract_cookies.py')
    const result = JSON.parse(raw.trim()) as {
      success: boolean
      browser?: string
      count?: number
      cookies?: Electron.CookiesSetDetails[]
      error?: string
    }

    if (!result.success || !result.cookies?.length) {
      return { success: false, error: result.error }
    }

    // 注入到 webview 使用的持久化 session
    const biliSession = session.fromPartition('persist:bilibili')
    let imported = 0
    for (const cookie of result.cookies) {
      try {
        await biliSession.cookies.set(cookie)
        imported++
      } catch {
        // 跳过格式异常的 cookie
      }
    }

    return { success: true, browser: result.browser, count: imported }
  } catch (e) {
    return { success: false, error: String(e) }
  }
})

// ─── IPC：解析视频 ────────────────────────────────────────
interface ParseOptions {
  skipVideo?: boolean
}

// 记录当前解析进程，用于停止
let currentParseProc: ChildProcess | null = null

ipcMain.handle('parse-video', async (event, url: string, options: ParseOptions = {}) => {
  const outputPath = join(tmpdir(), `vid-studio-${Date.now()}.txt`)
  const args = ['main.py', url, '-o', outputPath]
  if (options.skipVideo !== false) args.push('--skip-video')

  return new Promise<{ success: boolean; output?: string; error?: string }>((resolve) => {
    const proc = spawn(pythonBin, args, { cwd: vidEnginePath })
    currentParseProc = proc

    proc.stdout.on('data', (d: Buffer) => event.sender.send('parse-progress', d.toString()))
    proc.stderr.on('data', (d: Buffer) => event.sender.send('parse-progress', d.toString()))

    proc.on('close', async (code, signal) => {
      currentParseProc = null
      // 用户主动停止
      if (signal) {
        resolve({ success: false, error: '已停止解析' })
        return
      }
      if (code === 0) {
        try {
          resolve({ success: true, output: await readFile(outputPath, 'utf-8') })
        } catch {
          resolve({ success: false, error: '读取输出文件失败' })
        }
      } else {
        resolve({ success: false, error: `解析进程异常退出（code: ${code}）` })
      }
    })

    proc.on('error', (err: NodeJS.ErrnoException) => {
      currentParseProc = null
      resolve({
        success: false,
        error: err.code === 'ENOENT' ? '未找到 Python 环境，请确认已安装 python3' : err.message
      })
    })
  })
})

// ─── IPC：停止解析 ────────────────────────────────────────
ipcMain.handle('stop-parse', () => {
  if (currentParseProc) {
    currentParseProc.kill()
    currentParseProc = null
  }
})

// ─── 应用生命周期 ────────────────────────────────────────
app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.vidstudio')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
