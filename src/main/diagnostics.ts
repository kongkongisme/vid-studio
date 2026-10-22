import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { SettingsSnapshot, DiagnosticItem, DiagnosticReport } from '../shared/settings'
import { PYTHON_MODULES, type PythonProbe } from './python-runtime'

const execute = promisify(execFile)
export async function probeMediaTool(command: 'ffmpeg' | 'ffprobe'): Promise<string | null> {
  try {
    const { stdout } = await execute(command, ['-version'], {
      timeout: 4000,
      maxBuffer: 32768,
      windowsHide: true
    })
    return stdout.match(/version\s+([^\s]+)/)?.[1] ?? '已安装'
  } catch {
    return null
  }
}

export function buildDiagnosticReport(input: {
  appVersion: string
  platform: string
  python: PythonProbe
  enginePresent: boolean
  ffmpeg: string | null
  ffprobe: string | null
  settings: SettingsSnapshot
}): DiagnosticReport {
  const { settings, python } = input
  const missing = PYTHON_MODULES.filter(
    (name) => !python.modules.some((module) => module.name === name && module.available)
  )
  const items: DiagnosticItem[] = [
    {
      id: 'offline',
      title: '字幕与笔记',
      status: 'ok',
      detail: '导入、阅读、笔记和文档导出可离线使用。'
    },
    {
      id: 'engine',
      title: '处理引擎',
      status: input.enginePresent ? 'ok' : 'error',
      detail: input.enginePresent ? '引擎文件完整' : '缺少 Python 引擎文件',
      help: input.enginePresent
        ? undefined
        : '开发环境请确认 vid-engine 目录存在；安装版请重新安装完整发行包。'
    },
    {
      id: 'python',
      title: 'Python',
      status: python.supported ? 'ok' : 'error',
      detail: python.version
        ? `已找到 ${python.version}${python.supported ? '' : '，需要 3.10 或更新版本'}`
        : '未找到可运行的 Python',
      help: python.supported
        ? undefined
        : '安装 Python 3.10+，或在设置中选择已有虚拟环境的 Python 程序。'
    },
    {
      id: 'packages',
      title: 'Python 依赖',
      status: missing.length ? 'error' : 'ok',
      detail: missing.length
        ? `缺少或无法加载：${missing.map((name) => python.modules.find((module) => module.name === name)?.package ?? name).join('、')}`
        : '处理引擎所需依赖可以加载',
      help: missing.length
        ? '使用选定环境执行 python -m pip install -r vid-engine/requirements.txt，然后重新检查。'
        : undefined
    },
    {
      id: 'media',
      title: 'FFmpeg / FFprobe',
      status: input.ffmpeg && input.ffprobe ? 'ok' : 'warning',
      detail:
        input.ffmpeg && input.ffprobe
          ? `FFmpeg ${input.ffmpeg} · FFprobe ${input.ffprobe}`
          : '缺少媒体处理工具；音频提取和播放转码可能不可用。',
      help:
        input.ffmpeg && input.ffprobe
          ? undefined
          : 'macOS 可通过 Homebrew 安装 ffmpeg；Windows/Linux 请安装并加入 PATH。'
    },
    ...(
      [
        'DEEPSEEK_API_KEY',
        'GPT_API_KEY',
        'SILICONFLOW_API_KEY',
        'ZHIPUAI_API_KEY',
        'TAVILY_API_KEY'
      ] as const
    ).map((key): DiagnosticItem => {
      const labels = {
        DEEPSEEK_API_KEY: 'DeepSeek',
        GPT_API_KEY: '兼容模型接口',
        SILICONFLOW_API_KEY: '语音识别与语义分块',
        ZHIPUAI_API_KEY: '视觉分析（可选）',
        TAVILY_API_KEY: '联网搜索（可选）'
      }
      return {
        id: key,
        title: labels[key],
        status: settings.secrets[key].configured ? 'ok' : 'warning',
        detail: settings.secrets[key].configured
          ? '已配置密钥；尚未验证连通性或额度'
          : '未配置密钥',
        help: settings.secrets[key].configured
          ? undefined
          : key === 'DEEPSEEK_API_KEY' || key === 'GPT_API_KEY'
            ? '在模型配置中至少配置一种用于解析和问答的服务。'
            : undefined
      }
    }),
    {
      id: 'keychain',
      title: '本机密钥存储',
      status: settings.encryptionAvailable ? 'ok' : 'warning',
      detail: settings.encryptionAvailable
        ? '可使用系统密钥库加密保存 API Key'
        : '系统密钥库不可用，不能通过界面加密保存新密钥。'
    }
  ]
  return {
    generatedAt: new Date().toISOString(),
    appVersion: input.appVersion,
    platform: input.platform,
    items
  }
}

export async function engineAvailable(enginePath: string): Promise<boolean> {
  try {
    await Promise.all(
      ['main.py', 'src/pipeline.py', 'extract_cookies.py'].map((file) =>
        access(join(enginePath, file))
      )
    )
    return true
  } catch {
    return false
  }
}
