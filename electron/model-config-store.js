const fs = require('fs')
const path = require('path')
const { getProvider, normalizeConfig } = require('./model-providers')

const CONFIG_SCHEMA_VERSION = 2
const SUPPORTED_ROLES = Object.freeze(['chat', 'computerUse'])

function normalizeRole(role) {
  return SUPPORTED_ROLES.includes(role) ? role : 'chat'
}

class ModelConfigStore {
  constructor(userDataDir, safeStorage) {
    this.filePath = path.join(userDataDir, 'model-config.json')
    this.safeStorage = safeStorage
  }

  readRaw() {
    try { return JSON.parse(fs.readFileSync(this.filePath, 'utf8')) } catch { return {} }
  }

  readDocument() {
    const raw = this.readRaw()
    if (raw.schemaVersion === CONFIG_SCHEMA_VERSION && raw.roles && typeof raw.roles === 'object') {
      return { ...raw, schemaVersion: CONFIG_SCHEMA_VERSION, roles: { ...raw.roles } }
    }

    const legacy = raw.providerId || raw.model || raw.baseUrl || raw.encryptedApiKey
      ? {
          providerId: raw.providerId,
          model: raw.model,
          baseUrl: raw.baseUrl,
          encryptedApiKey: raw.encryptedApiKey || '',
          updatedAt: raw.updatedAt
        }
      : null
    return {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      roles: legacy ? { chat: legacy } : {},
      migratedAt: legacy ? new Date().toISOString() : undefined,
      updatedAt: raw.updatedAt
    }
  }

  decrypt(value) {
    if (!value) return ''
    try {
      return this.safeStorage.decryptString(Buffer.from(value, 'base64'))
    } catch {
      return ''
    }
  }

  resolved(role = 'chat') {
    const selectedRole = normalizeRole(role)
    const record = this.readDocument().roles[selectedRole] || {}
    return normalizeConfig({
      ...record,
      role: selectedRole,
      apiKey: this.decrypt(record.encryptedApiKey)
    }, selectedRole)
  }

  publicConfig(role = 'chat') {
    const selectedRole = normalizeRole(role)
    const record = this.readDocument().roles[selectedRole] || {}
    const provider = getProvider(record.providerId, selectedRole)
    return {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      role: selectedRole,
      providerId: provider.id,
      providerName: provider.name,
      model: record.model || provider.models[0],
      baseUrl: record.baseUrl || provider.baseUrl,
      hasApiKey: Boolean(record.encryptedApiKey),
      keyStorage: '系统加密存储',
      capabilities: { ...provider.capabilities }
    }
  }

  publicRoles() {
    return {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      roles: Object.fromEntries(SUPPORTED_ROLES.map((role) => [role, this.publicConfig(role)]))
    }
  }

  save(input = {}) {
    const role = normalizeRole(input.role)
    const document = this.readDocument()
    const previous = document.roles[role] || {}
    const config = normalizeConfig(input, role)
    let encryptedApiKey = previous.encryptedApiKey || ''

    if (previous.providerId && previous.providerId !== config.providerId && !input.apiKey) encryptedApiKey = ''
    if (input.clearApiKey) encryptedApiKey = ''
    else if (input.apiKey) {
      if (!this.safeStorage.isEncryptionAvailable()) throw new Error('当前系统加密服务不可用，API Key 未保存')
      encryptedApiKey = this.safeStorage.encryptString(String(input.apiKey)).toString('base64')
    }

    const now = new Date().toISOString()
    document.schemaVersion = CONFIG_SCHEMA_VERSION
    document.roles[role] = {
      providerId: config.providerId,
      model: config.model,
      baseUrl: config.baseUrl,
      encryptedApiKey,
      updatedAt: now
    }
    document.updatedAt = now

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(document, null, 2), { mode: 0o600 })
    try {
      fs.renameSync(temporary, this.filePath)
    } catch {
      fs.copyFileSync(temporary, this.filePath)
      fs.unlinkSync(temporary)
    }
    return this.publicConfig(role)
  }
}

module.exports = { CONFIG_SCHEMA_VERSION, SUPPORTED_ROLES, ModelConfigStore }
