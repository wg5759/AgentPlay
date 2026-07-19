const dns = require('dns').promises
const net = require('net')
const { validateProviderUrl, isLoopbackHostname } = require('./model-providers')
const { isLoopbackAddress, isProtectedAddress } = require('./network-policy')

async function assertResolvedAddressAllowed(config, parsed, dnsLookup = dns.lookup) {
  if (config.localOnly || isLoopbackHostname(parsed.hostname)) return
  if (net.isIP(parsed.hostname)) {
    if (isProtectedAddress(parsed.hostname)) throw new Error('已拒绝私网或保留地址')
    return
  }
  const result = await dnsLookup(parsed.hostname, { all: true, verbatim: true })
  const addresses = Array.isArray(result) ? result : [result]
  if (!addresses.length) throw new Error('API 域名没有可用地址')
  if (addresses.some((item) => isProtectedAddress(item?.address || item))) {
    throw new Error('API 域名 DNS 解析到了受保护地址，已拒绝连接')
  }
}

async function safeFetch(config, url, init = {}, dependencies = {}) {
  const base = validateProviderUrl(config)
  const target = new URL(url)
  validateProviderUrl({ ...config, baseUrl: target.toString() })
  if (target.origin !== base.origin) throw new Error('API 请求不得跨来源发送凭据')
  await assertResolvedAddressAllowed(config, target, dependencies.dnsLookup)
  const response = await (dependencies.fetchImpl || globalThis.fetch)(target.toString(), {
    ...init,
    redirect: 'manual'
  })
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`已拒绝 API 重定向 (${response.status})`)
  }
  return response
}

module.exports = {
  isLoopbackAddress,
  isProtectedAddress,
  assertResolvedAddressAllowed,
  safeFetch
}
