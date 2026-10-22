import { existsSync, globSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'

const explicit = process.argv[2] || process.env.VID_STUDIO_PACKAGED_EXECUTABLE
const candidates = explicit
  ? [explicit]
  : globSync([
      'dist/mac*/VidStudio 视析工作站.app/Contents/MacOS/VidStudio 视析工作站',
      'dist/win*-unpacked/vid-studio.exe',
      'dist/linux*-unpacked/vid-studio'
    ])

if (candidates.length !== 1 || !existsSync(candidates[0])) {
  console.error('请先生成应用目录，或传入可执行文件路径：npm run test:packaged -- "/path/to/app"')
  process.exit(1)
}

const executable = resolve(candidates[0])
const child = spawn(
  process.execPath,
  ['node_modules/@playwright/test/cli.js', 'test', '--project=electron'],
  {
    stdio: 'inherit',
    env: { ...process.env, VID_STUDIO_PACKAGED_EXECUTABLE: executable }
  }
)
child.on('error', (error) => {
  console.error(error.message)
  process.exitCode = 1
})
child.on('exit', (code) => {
  process.exitCode = code ?? 1
})
