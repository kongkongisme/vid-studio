import { describe, expect, it, vi } from 'vitest'
import {
  PythonRuntime,
  pythonCandidates,
  PYTHON_MODULES,
  type PythonProbe
} from '../src/main/python-runtime'
import { buildDiagnosticReport } from '../src/main/diagnostics'
import {
  DEFAULT_MODELS,
  DEFAULT_PREFERENCES,
  SECRET_KEYS,
  diagnosticText,
  type SettingsSnapshot
} from '../src/shared/settings'

const complete = (command: string): PythonProbe => ({
  command,
  version: '3.12.2',
  supported: true,
  modules: PYTHON_MODULES.map((name) => ({ name, package: name, available: true }))
})

describe('Python discovery', () => {
  it('honors an explicit interpreter without silently using another environment', () => {
    expect(pythonCandidates('/engine', '/chosen/python', { PATH: '/bin' }, 'darwin')).toEqual([
      '/chosen/python'
    ])
    expect(
      pythonCandidates(
        '/engine',
        '/chosen/python',
        { VID_STUDIO_PYTHON: '/env/python', PATH: '/bin' },
        'darwin'
      )
    ).toEqual(['/env/python'])
    const candidates = pythonCandidates('C:\\engine', '', { PATH: 'C:\\Python;C:\\Tools' }, 'win32')
    expect(candidates[0]).toBe('C:\\engine\\.venv\\Scripts\\python.exe')
    expect(candidates).toContain('C:\\Python\\python.exe')
    expect(candidates.some((candidate) => candidate.includes('/bin'))).toBe(false)
  })

  it('prefers supported environments with complete imports and caches concurrent probes', async () => {
    const probe = vi.fn(async (command) =>
      command === 'old-python'
        ? { ...complete(command), version: '3.9.6', supported: false }
        : complete(command)
    )
    const runtime = new PythonRuntime(async () => ['old-python', 'new-python'], probe)
    const [first, second] = await Promise.all([runtime.resolve(), runtime.resolve()])
    expect(first.command).toBe('new-python')
    expect(second).toEqual(first)
    expect(probe).toHaveBeenCalledTimes(2)
    await runtime.resolve()
    expect(probe).toHaveBeenCalledTimes(2)
    runtime.invalidate()
    await runtime.resolve()
    expect(probe).toHaveBeenCalledTimes(4)
  })

  it('returns the most useful incomplete environment for actionable diagnostics', async () => {
    const probe = vi.fn(async (command) =>
      command === 'missing'
        ? { command, supported: false, modules: [], error: 'not found' }
        : { ...complete(command), modules: [] }
    )
    const result = await new PythonRuntime(async () => ['missing', 'partial'], probe).resolve()
    expect(result.command).toBe('partial')
    expect(result.supported).toBe(true)
  })

  it('does not reuse or cache an outdated probe after the interpreter changes', async () => {
    let finishOld!: (probe: PythonProbe) => void
    let beginOld!: () => void
    const started = new Promise<void>((resolve) => {
      beginOld = resolve
    })
    const delayed = new Promise<PythonProbe>((resolve) => {
      finishOld = resolve
    })
    let chosen = 'old-python'
    const probe = vi.fn(async (command) => {
      if (command === 'old-python') {
        beginOld()
        return delayed
      }
      return complete(command)
    })
    const runtime = new PythonRuntime(async () => [chosen], probe)
    const previous = runtime.resolve()
    await started
    chosen = 'new-python'
    runtime.invalidate()
    expect((await runtime.resolve()).command).toBe('new-python')
    finishOld(complete('old-python'))
    await previous
    expect((await runtime.resolve()).command).toBe('new-python')
    expect(probe).toHaveBeenCalledTimes(2)
  })
})

describe('shareable diagnostic reports', () => {
  it('omits paths, endpoints and credential values while explaining local-only limits', () => {
    const secrets = Object.fromEntries(
      SECRET_KEYS.map((key) => [key, { configured: true, stored: false, source: 'environment' }])
    ) as SettingsSnapshot['secrets']
    const report = buildDiagnosticReport({
      appVersion: '0.2.0',
      platform: 'darwin',
      enginePresent: true,
      ffmpeg: '8.0',
      ffprobe: '8.0',
      python: {
        ...complete('/Users/private/person/python'),
        executable: '/Users/private/person/python'
      },
      settings: {
        preferences: { ...DEFAULT_PREFERENCES, pythonPath: '/Users/private/person/python' },
        models: { ...DEFAULT_MODELS, GPT_BASE_URL: 'https://private-host.example/v1?key=secret' },
        secrets,
        encryptionAvailable: true
      }
    })
    const copied = diagnosticText(report)
    expect(copied).not.toContain('/Users/')
    expect(copied).not.toContain('private-host')
    expect(copied).not.toContain('key=secret')
    expect(copied).toContain('未测试网络连通性')
    expect(copied).toContain('3.12.2')
  })
})
