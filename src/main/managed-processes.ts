import {
  execFile,
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams
} from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const execute = promisify(execFile)

interface ProcessEntry {
  child: ChildProcessWithoutNullStreams
  exited: boolean
  closed: boolean
  stopping?: Promise<void>
}

/** Only processes created here may be signaled as a group. Never accepts an arbitrary PID. */
export class ManagedProcesses {
  private entries = new Map<ChildProcess, ProcessEntry>()
  private closing = false

  spawn(
    command: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
  ): ChildProcessWithoutNullStreams {
    if (this.closing) throw new Error('应用正在退出，无法启动新的后台任务')
    const child = spawn(command, args, {
      ...options,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: 'pipe'
    })
    const entry: ProcessEntry = { child, exited: false, closed: false }
    this.entries.set(child, entry)
    child.once('exit', () => {
      entry.exited = true
    })
    child.once('close', () => {
      entry.closed = true
      this.entries.delete(child)
    })
    return child
  }

  stop(child: ChildProcess): Promise<void> {
    const entry = this.entries.get(child)
    if (!entry || !child.pid) return Promise.resolve()
    entry.stopping ??= this.terminate(entry).catch((error) => {
      entry.stopping = undefined
      throw error
    })
    return entry.stopping
  }

  async shutdown(): Promise<void> {
    this.closing = true
    const results = await Promise.allSettled(
      [...this.entries.keys()].map((child) => this.stop(child))
    )
    const failures = results.filter((result) => result.status === 'rejected')
    if (failures.length) throw new Error(`${failures.length} 个后台任务未能正常停止`)
  }

  private async terminate(entry: ProcessEntry): Promise<void> {
    const pid = entry.child.pid!
    if (process.platform === 'win32') {
      try {
        // /T includes descendants; child.kill() on Windows only terminates the parent.
        await execute('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          timeout: 4000,
          maxBuffer: 32768
        })
      } catch {
        if (!entry.exited && !entry.closed) throw new Error('无法停止后台进程及其子进程')
      }
    } else {
      const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
        try {
          process.kill(-pid, signal)
          return true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
          throw error
        }
      }
      if (signalGroup('SIGTERM')) {
        const deadline = Date.now() + 600
        while (Date.now() < deadline && signalGroup(0)) await delay(30)
        // A parent can exit while an ffmpeg descendant ignores SIGTERM. Keep the group ID
        // until escalation rather than treating the parent's exit as successful cleanup.
        if (signalGroup(0)) signalGroup('SIGKILL')
      }
    }
    const deadline = Date.now() + 1500
    while (!entry.closed && Date.now() < deadline) await delay(30)
    if (!entry.closed) throw new Error('后台任务停止超时，请重试')
  }
}
