import { describe, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManagedProcesses } from '../src/main/managed-processes'

// The child writes a heartbeat rather than relying on kill(pid, 0), which also
// reports unreaped zombies as alive on Linux CI.
const descendantScript = `
const fs = require('node:fs')
process.on('SIGTERM', () => {})
let value = 0
setInterval(() => fs.writeFileSync(process.argv[1], String(++value)), 25)
console.log('ready')
`
const parentScript = `
const { spawn } = require('node:child_process')
spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}, process.argv[1]], { stdio: 'inherit' })
setInterval(() => {}, 1000)
`

describe('owned background process trees', () => {
  it('stops descendants that ignore SIGTERM even when their parent exits first', async () => {
    const processes = new ManagedProcesses()
    const directory = await mkdtemp(join(tmpdir(), 'vidstudio-process-test-'))
    const heartbeat = join(directory, 'heartbeat')
    const parent = processes.spawn(process.execPath, ['-e', parentScript, heartbeat])
    const errors: Error[] = []
    parent.on('error', (error) => errors.push(error))
    try {
      await once(parent.stdout, 'data')
      await expect.poll(async () => readFile(heartbeat, 'utf8')).toMatch(/\d+/)
      const firstStop = processes.stop(parent)
      expect(processes.stop(parent)).toBe(firstStop)
      await firstStop
      const stoppedValue = await readFile(heartbeat, 'utf8')
      // Polling over multiple writes would expose a surviving descendant.
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(await readFile(heartbeat, 'utf8')).toBe(stoppedValue)
      expect(parent.exitCode !== null || parent.signalCode !== null).toBe(true)
      expect(errors).toEqual([])
      await processes.stop(parent)
    } finally {
      await processes.shutdown()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('stops all owned jobs on shutdown and refuses late launches', async () => {
    const processes = new ManagedProcesses()
    const jobs = [0, 1].map(() =>
      processes.spawn(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"])
    )
    try {
      await Promise.all(jobs.map((job) => once(job.stdout, 'data')))
      await processes.shutdown()
      expect(jobs.every((job) => job.exitCode !== null || job.signalCode !== null)).toBe(true)
      expect(() => processes.spawn(process.execPath, ['-v'])).toThrow('应用正在退出')
    } finally {
      await processes.shutdown()
    }
  })

  it('handles a missing executable without leaving a tracked job', async () => {
    const processes = new ManagedProcesses()
    const job = processes.spawn(join(tmpdir(), 'vidstudio-nonexistent-executable'), [])
    const error = await once(job, 'error')
    expect(error[0]).toMatchObject({ code: 'ENOENT' })
    await processes.stop(job)
    await processes.shutdown()
  })

  it.skipIf(process.platform !== 'darwin')('retries a transient macOS group EPERM', async () => {
    const processes = new ManagedProcesses()
    const child = processes.spawn(process.execPath, [
      '-e',
      "console.log('ready'); setInterval(() => {}, 1000)"
    ])
    const originalKill = process.kill.bind(process)
    let attempts = 0
    let mock: ReturnType<typeof vi.spyOn> | undefined
    try {
      await once(child.stdout, 'data')
      mock = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === -child.pid! && signal === 'SIGTERM' && attempts++ === 0) {
          throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
        }
        return originalKill(pid, signal)
      })
      await processes.stop(child)
      expect(attempts).toBe(2)
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    } finally {
      mock?.mockRestore()
      await processes.shutdown()
    }
  })

  it.skipIf(process.platform !== 'darwin')(
    'does not swallow persistent permission failures',
    async () => {
      const processes = new ManagedProcesses()
      const child = processes.spawn(process.execPath, [
        '-e',
        "console.log('ready'); setInterval(() => {}, 1000)"
      ])
      const originalKill = process.kill.bind(process)
      let attempts = 0
      let mock: ReturnType<typeof vi.spyOn> | undefined
      try {
        await once(child.stdout, 'data')
        mock = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          if (pid === -child.pid!) {
            attempts++
            throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
          }
          return originalKill(pid, signal)
        })
        await expect(processes.stop(child)).rejects.toMatchObject({ code: 'EPERM' })
        expect(attempts).toBe(3)
        expect(child.exitCode).toBeNull()
      } finally {
        mock?.mockRestore()
        await processes.shutdown()
      }
    }
  )
})
