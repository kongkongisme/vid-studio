import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpath } from 'node:fs/promises'
import path from 'node:path'

const execute = promisify(execFile)
export const PYTHON_MODULES = ['dotenv', 'numpy', 'openai', 'PIL', 'requests', 'yt_dlp']
export interface PythonProbe {
  command: string
  executable?: string
  version?: string
  supported: boolean
  modules: Array<{ name: string; package: string; version?: string; available: boolean }>
  error?: string
}

export function pythonCandidates(
  enginePath: string,
  preferred: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string[] {
  const explicit = environment.VID_STUDIO_PYTHON?.trim() || preferred.trim()
  if (explicit) return [explicit]
  const windows = platform === 'win32'
  const paths = windows ? path.win32 : path.posix
  const names = windows ? ['python.exe', 'python3.exe'] : ['python3', 'python']
  const candidates = [
    windows
      ? paths.join(enginePath, '.venv', 'Scripts', 'python.exe')
      : paths.join(enginePath, '.venv', 'bin', 'python'),
    ...(environment.CONDA_PREFIX
      ? [paths.join(environment.CONDA_PREFIX, windows ? 'python.exe' : 'bin/python')]
      : []),
    ...(environment.PATH ?? '')
      .split(windows ? ';' : ':')
      .filter(Boolean)
      .flatMap((directory) => names.map((name) => paths.join(directory, name))),
    ...(platform === 'darwin'
      ? ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3']
      : []),
    ...names
  ]
  return [...new Set(candidates)]
}

const PROBE_SCRIPT = `import sys, json, importlib, importlib.metadata
packages = [('dotenv', 'python-dotenv'), ('numpy', 'numpy'), ('openai', 'openai'), ('PIL', 'Pillow'), ('requests', 'requests'), ('yt_dlp', 'yt-dlp')]
modules = []
for name, package in packages:
    item = {'name': name, 'package': package, 'available': False}
    try:
        importlib.import_module(name)
        item['available'] = True
        try:
            item['version'] = importlib.metadata.version(package)
        except Exception:
            pass
    except Exception:
        pass
    modules.append(item)
print(json.dumps({'executable': sys.executable, 'version': '.'.join(map(str, sys.version_info[:3])), 'supported': sys.version_info >= (3, 10), 'modules': modules}))`

export async function probePython(command: string): Promise<PythonProbe> {
  try {
    const { stdout } = await execute(command, ['-c', PROBE_SCRIPT], {
      timeout: 6000,
      maxBuffer: 32768,
      windowsHide: true,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
    })
    const data = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as Omit<PythonProbe, 'command'>
    if (
      typeof data.version !== 'string' ||
      typeof data.supported !== 'boolean' ||
      !Array.isArray(data.modules)
    )
      throw new Error('Invalid probe response')
    return { ...data, command }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException & { killed?: boolean }).code
    return {
      command,
      supported: false,
      modules: [],
      error:
        code === 'ENOENT' ? '未找到此 Python 程序' : 'Python 检查未完成，可能缺少依赖或检查超时'
    }
  }
}

/** Lazy and asynchronous: showing the application never waits on Python imports. */
export class PythonRuntime {
  private revision = 0
  private pending: { revision: number; promise: Promise<PythonProbe> } | null = null
  private cached: { probe: PythonProbe; at: number } | null = null
  constructor(
    private readonly candidates: () => Promise<string[]>,
    private readonly probe = probePython
  ) {}

  invalidate(): void {
    this.revision++
    this.cached = null
  }

  async resolve(refresh = false): Promise<PythonProbe> {
    if (this.pending?.revision === this.revision) return this.pending.promise
    if (!refresh && this.cached && Date.now() - this.cached.at < 60000) return this.cached.probe
    const revision = this.revision
    const promise = this.find()
      .then((probe) => {
        if (revision === this.revision) this.cached = { probe, at: Date.now() }
        return probe
      })
      .finally(() => {
        if (this.pending?.revision === revision) this.pending = null
      })
    this.pending = { revision, promise }
    return promise
  }

  private async find(): Promise<PythonProbe> {
    const commands = await this.candidates()
    const seen = new Set<string>()
    let best: PythonProbe = {
      command: commands[0] ?? 'python3',
      supported: false,
      modules: [],
      error: '未找到 Python，请安装 Python 3.10 或更新版本。'
    }
    let bestScore = -1
    const started = Date.now()
    for (const command of commands) {
      let canonical = command
      if (path.isAbsolute(command)) {
        try {
          canonical = await realpath(command)
        } catch {
          continue
        }
      }
      if (seen.has(canonical)) continue
      seen.add(canonical)
      const found = await this.probe(command)
      const score =
        (found.supported ? 100 : found.version ? 10 : 0) +
        found.modules.filter((module) => module.available).length
      if (score > bestScore) {
        best = found
        bestScore = score
      }
      if (
        found.supported &&
        PYTHON_MODULES.every((name) =>
          found.modules.some((module) => module.name === name && module.available)
        )
      )
        return found
      if (Date.now() - started > 15000) break
    }
    return best
  }
}
