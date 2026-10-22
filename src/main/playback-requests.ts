import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ManagedProcesses } from './managed-processes'

export interface PlaybackRequest {
  signal: AbortSignal
  ready: Promise<void>
  spawn: (command: string, args: string[]) => ChildProcessWithoutNullStreams
}

/** A new file supersedes both probing and transcoding for the previous file. */
export class PlaybackRequests {
  private controller: AbortController | null = null
  private children = new Set<ChildProcessWithoutNullStreams>()

  constructor(private processes: ManagedProcesses) {}

  begin(): PlaybackRequest {
    const ready = this.cancel()
    const controller = new AbortController()
    this.controller = controller
    return {
      signal: controller.signal,
      ready,
      spawn: (command, args) => {
        controller.signal.throwIfAborted()
        const child = this.processes.spawn(command, args)
        this.children.add(child)
        child.once('close', () => this.children.delete(child))
        return child
      }
    }
  }

  async cancel(): Promise<void> {
    this.controller?.abort(new DOMException('已取消生成播放预览', 'AbortError'))
    this.controller = null
    await Promise.all([...this.children].map((child) => this.processes.stop(child)))
  }
}
