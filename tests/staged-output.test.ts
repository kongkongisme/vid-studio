import { describe, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeStagedOutput } from '../src/main/staged-output'

describe('preview cache publication', () => {
  it('exposes only a complete file, retaining the media extension during generation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vidstudio-preview-test-'))
    const destination = join(directory, 'preview.mp4')
    try {
      await writeStagedOutput(destination, async (temporary) => {
        expect(temporary).toMatch(/\.partial\.mp4$/)
        await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
        await writeFile(temporary, 'finished video')
      })
      expect(await readFile(destination, 'utf8')).toBe('finished video')
      expect(await readdir(directory)).toEqual(['preview.mp4'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('cleans canceled output and preserves an existing complete preview', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vidstudio-preview-test-'))
    const destination = join(directory, 'preview.mp4')
    try {
      await writeFile(destination, 'original')
      await expect(
        writeStagedOutput(destination, async (temporary) => {
          await writeFile(temporary, 'incomplete video')
          throw new Error('canceled')
        })
      ).rejects.toThrow('canceled')
      expect(await readFile(destination, 'utf8')).toBe('original')
      expect(await readdir(directory)).toEqual(['preview.mp4'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not cache an empty generated file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vidstudio-preview-test-'))
    try {
      await expect(
        writeStagedOutput(join(directory, 'preview.mp4'), (temporary) => writeFile(temporary, ''))
      ).rejects.toThrow('未生成有效的播放预览')
      expect(await readdir(directory)).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
