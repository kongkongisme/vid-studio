import { randomUUID } from 'node:crypto'
import { rename, rm, stat } from 'node:fs/promises'
import { dirname, extname, basename, join } from 'node:path'

/** Incomplete media must never look like a reusable cached preview. */
export async function writeStagedOutput(
  destination: string,
  generate: (temporaryPath: string) => Promise<void>
): Promise<void> {
  const extension = extname(destination)
  const temporary = join(
    dirname(destination),
    `${basename(destination, extension)}.${randomUUID()}.partial${extension}`
  )
  try {
    await generate(temporary)
    const result = await stat(temporary)
    if (!result.isFile() || result.size === 0) throw new Error('未生成有效的播放预览')
    await rename(temporary, destination)
  } finally {
    await rm(temporary, { force: true })
  }
}
