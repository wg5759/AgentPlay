import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export function classifyAudit(result) {
  const text = `${result.stdout || ''}\n${result.stderr || ''}`
  let data
  try { data = JSON.parse(String(result.stdout || '').trim()) } catch { /* diagnostic text */ }
  const counts = data?.metadata?.vulnerabilities
  if (counts && Object.entries(counts).some(([key, value]) => key !== 'total' && Number(value) > 0)) return 'vulnerabilities'
  if (/ERR_SOCKET_TIMEOUT|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|ERR_PNPM_AUDIT_BAD_RESPONSE|registry.*(?:502|503|504)/i.test(text) || result.error?.code === 'ETIMEDOUT') return 'unavailable'
  if (result.status === 0 && counts && ['info', 'low', 'moderate', 'high', 'critical'].every(key => counts[key] === 0)) return 'clean'
  return 'error'
}

export function runAudit(args = [], run = spawnSync) {
  let last
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = run('pnpm', ['audit', '--json', '--registry=https://registry.npmjs.org', ...(args.includes('--prod') ? ['--prod'] : [])], {
      encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true, timeout: 45000,
      env: { ...process.env, npm_config_fetch_retries: '0', npm_config_fetch_timeout: '20000' }
    })
    last = { status: classifyAudit(result), attempt: attempt + 1 }
    if (last.status === 'clean') { console.log(JSON.stringify(last)); return 0 }
    if (last.status !== 'unavailable') { console.error(result.stdout || result.stderr || '依赖审计未返回有效报告'); return 1 }
  }
  console.error('::error title=Dependency audit service unavailable::安全审计服务暂不可用，未获得漏洞结论；源码检查结果独立保留。')
  console.error(JSON.stringify(last))
  return 75
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = runAudit(process.argv.slice(2))
