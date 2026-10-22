import { describe, expect, it } from 'vitest'
import { once } from 'node:events'
import { ManagedProcesses } from '../src/main/managed-processes'
import { PlaybackRequests } from '../src/main/playback-requests'

const probeScript = "console.log('ready'); setInterval(() => {}, 1000)"

describe('local playback request ownership', () => {
  it('stops an old probe and prevents its late completion from starting a transcode', async () => {
    const processes = new ManagedProcesses()
    const requests = new PlaybackRequests(processes)
    try {
      const first = requests.begin()
      await first.ready
      const probe = first.spawn(process.execPath, ['-e', probeScript])
      await once(probe.stdout, 'data')
      const lateCompletion = once(probe, 'close').then(() =>
        first.spawn(process.execPath, ['-e', probeScript])
      )
      const rejected = expect(lateCompletion).rejects.toThrow('已取消生成播放预览')
      const second = requests.begin()
      await second.ready
      await rejected
      expect(probe.exitCode !== null || probe.signalCode !== null).toBe(true)
      const current = second.spawn(process.execPath, ['-e', probeScript])
      await once(current.stdout, 'data')
      expect(second.signal.aborted).toBe(false)
      await requests.cancel()
      expect(current.exitCode !== null || current.signalCode !== null).toBe(true)
    } finally {
      await processes.shutdown()
    }
  })

  it('keeps only the newest request when files change again during cleanup', async () => {
    const processes = new ManagedProcesses()
    const requests = new PlaybackRequests(processes)
    try {
      const first = requests.begin()
      await first.ready
      const old = first.spawn(process.execPath, ['-e', probeScript])
      await once(old.stdout, 'data')
      const intermediate = requests.begin()
      const latest = requests.begin()
      await Promise.all([intermediate.ready, latest.ready])
      expect(() => intermediate.spawn(process.execPath, ['-v'])).toThrow('已取消生成播放预览')
      expect(old.exitCode !== null || old.signalCode !== null).toBe(true)
      const current = latest.spawn(process.execPath, ['-e', probeScript])
      await once(current.stdout, 'data')
      expect(latest.signal.aborted).toBe(false)
      await requests.cancel()
    } finally {
      await processes.shutdown()
    }
  })

  it('cancels work that has not spawned yet and allows a later request', async () => {
    const processes = new ManagedProcesses()
    const requests = new PlaybackRequests(processes)
    try {
      const pending = requests.begin()
      await requests.cancel()
      await pending.ready
      expect(() => pending.spawn(process.execPath, ['-v'])).toThrow('已取消生成播放预览')
      const later = requests.begin()
      await later.ready
      const child = later.spawn(process.execPath, ['-v'])
      await once(child, 'close')
      expect(child.exitCode).toBe(0)
      await requests.cancel()
    } finally {
      await processes.shutdown()
    }
  })
})
