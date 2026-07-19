import path from 'node:path'

export const SECRET_RULES = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['openai-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{30,}\b/g],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['slack-token', /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/g]
]

const TEXT_EXTENSIONS = new Set([
  '.bat', '.cjs', '.cs', '.css', '.html', '.js', '.json', '.jsx', '.md', '.mjs',
  '.ps1', '.ts', '.tsx', '.txt', '.yaml', '.yml'
])

const PLACEHOLDER_MARKERS = /example|placeholder|redacted|replace[_-]?me|your[_-]|dummy|fake|test|xxxx/i

export function isTextPath(filePath) {
  const normalized = String(filePath).replaceAll('\\', '/')
  if (normalized.includes('/node_modules/') || normalized.includes('/.git/')) return false
  return TEXT_EXTENSIONS.has(path.extname(normalized).toLowerCase()) || path.basename(normalized) === 'LICENSE'
}

export function scanText(source, text) {
  const findings = []
  const lines = String(text).split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    for (const [rule, pattern] of SECRET_RULES) {
      pattern.lastIndex = 0
      for (const match of line.matchAll(pattern)) {
        if (PLACEHOLDER_MARKERS.test(match[0])) continue
        findings.push({ source, line: index + 1, rule })
      }
    }
  }
  return findings
}

export function collectSanitizedUrls(source, text) {
  const endpoints = []
  const matches = String(text).matchAll(/https?:\/\/[^\s"'`<>)}\]]+/g)
  for (const match of matches) {
    try {
      const raw = match[0].replace(/[.,;:]$/, '')
      if (raw.includes('${') || raw.includes('...')) continue
      const url = new URL(raw)
      if (!url.hostname || url.hostname.includes('$')) continue
      endpoints.push({ source, endpoint: `${url.origin}${url.pathname}` })
    } catch {}
  }
  return endpoints
}
