import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') process.exit(0)

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'resources', 'voice-helper', 'Program.cs')
const output = path.join(root, 'resources', 'bin', 'win', 'ai-player-voice.exe')
const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const speechAssembly = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'WPF', 'System.Speech.dll')
if (!fs.existsSync(compiler)) throw new Error(`缺少 Windows C# 编译器：${compiler}`)
if (!fs.existsSync(speechAssembly)) throw new Error(`缺少 Windows SAPI 程序集：${speechAssembly}`)
if (!fs.existsSync(source)) throw new Error(`缺少本机配音源码：${source}`)
if (fs.existsSync(output) && fs.statSync(output).mtimeMs >= fs.statSync(source).mtimeMs) process.exit(0)

const result = spawnSync(compiler, ['/nologo', '/target:exe', '/optimize+', `/out:${output}`, `/reference:${speechAssembly}`, source], {
  cwd: root, windowsHide: true, stdio: 'inherit', shell: false
})
if (result.status !== 0 || !fs.existsSync(output)) throw new Error(`本机配音辅助程序构建失败（退出码 ${result.status}）`)
