const { execFile, spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const APP_BY_EXT = {
  '.doc': 'Word', '.docx': 'Word', '.rtf': 'Word', '.odt': 'Word',
  '.xls': 'Excel', '.xlsx': 'Excel', '.csv': 'Excel', '.ods': 'Excel',
  '.ppt': 'PowerPoint', '.pptx': 'PowerPoint', '.odp': 'PowerPoint'
}
const OFFICE_PROCESS = { Word: 'WINWORD.EXE', Excel: 'EXCEL.EXE', PowerPoint: 'POWERPNT.EXE' }
const TIMEOUT_MS = 120000

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim()))
      else resolve(String(stdout))
    })
  })
}

async function officePids(imageName) {
  try {
    const output = await run('tasklist.exe', ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'])
    return new Set([...output.matchAll(/"[^"]+","(\d+)"/g)].map((match) => Number(match[1])))
  } catch {
    return new Set()
  }
}

class OfficeConvertService {
  constructor({ scriptPath, powershellPath, spawnImpl, timeoutMs } = {}) {
    this.scriptPath = scriptPath || path.join(__dirname, 'office-convert.ps1')
    this.powershellPath = powershellPath || 'powershell.exe'
    this.spawnImpl = spawnImpl || spawn
    this.timeoutMs = timeoutMs || TIMEOUT_MS
    this.detectPromise = null
  }

  async detect() {
    if (process.platform !== 'win32') return { available: false, engines: [], reason: '高保真转换引擎仅支持 Windows' }
    if (!fs.existsSync(this.scriptPath)) return { available: false, engines: [], reason: '转换脚本缺失' }
    if (!this.detectPromise) {
      this.detectPromise = this.runPs(['-ProbeEngines']).then((output) => {
        const engines = []
        for (const line of output.split(/\r?\n/)) {
          const match = /^ENGINE-OK (\w+) (.+)$/.exec(line.trim())
          if (match) engines.push({ app: match[1].charAt(0) + match[1].slice(1).toLowerCase(), version: match[2] })
        }
        return engines.length > 0
          ? { available: true, engines }
          : { available: false, engines: [], reason: '未检测到 Office/WPS/LibreOffice 转换引擎' }
      }).catch((error) => ({ available: false, engines: [], reason: error.message }))
    }
    return this.detectPromise
  }

  async convertToPdf(sourcePath, targetPath) {
    const app = APP_BY_EXT[path.extname(sourcePath).toLowerCase()]
    if (!app) throw new Error(`高保真转换不支持该格式：${path.extname(sourcePath) || '未知'}`)
    const status = await this.detect()
    if (!status.available) {
      throw new Error('高保真转换需要本机安装 Office、WPS 或 LibreOffice；当前未检测到可用引擎（可改用普通转换）')
    }
    if (!status.engines.some((engine) => engine.app === app)) {
      throw new Error(`高保真转换该格式需要本机安装 Microsoft ${app}（或 WPS 对应组件）；当前未检测到（可改用普通转换）`)
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    const tempTarget = `${targetPath}.${process.pid}.tmp.pdf`
    try {
      await this.runPsGuarded(['-Source', sourcePath, '-Target', tempTarget, '-App', app], OFFICE_PROCESS[app])
      const stat = fs.statSync(tempTarget)
      if (!stat.isFile() || stat.size === 0) throw new Error('转换引擎没有产出文件')
      fs.renameSync(tempTarget, targetPath)
      return { engine: app, bytes: stat.size }
    } finally {
      if (fs.existsSync(tempTarget)) fs.rmSync(tempTarget, { force: true })
    }
  }

  runPs(args) {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(this.powershellPath, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath, ...args], { windowsHide: true })
      let stdout = ''
      let stderr = ''
      let settled = false
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* 忽略 */ }
        if (!settled) {
          settled = true
          const error = new Error('高保真转换超时')
          error.timeout = true
          reject(error)
        }
      }, this.timeoutMs)
      child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
      child.on('error', (error) => {
        if (!settled) { settled = true; clearTimeout(timer); reject(error) }
      })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (code === 0) resolve(stdout)
        else reject(new Error(stderr.trim() || `转换进程退出 (${code})`))
      })
    })
  }

  async runPsGuarded(args, officeImage) {
    const before = officeImage ? await officePids(officeImage) : new Set()
    try {
      return await this.runPs(args)
    } catch (error) {
      if (error.timeout && officeImage) {
        // 超时被强杀后 Office 进程可能残留：只清理本次新产生的实例，用户已打开的不动
        const after = await officePids(officeImage)
        for (const pid of after) {
          if (!before.has(pid)) {
            try { await run('taskkill.exe', ['/PID', String(pid), '/T', '/F']) } catch { /* 已退出 */ }
          }
        }
      }
      throw error
    }
  }
}

module.exports = { OfficeConvertService, APP_BY_EXT }
