const path = require('path')
const crypto = require('crypto')

const { planEditInstruction, resolveEditClarification } = require('./media-edit-decision')
const { attachEditDecisionList } = require('./edit-decision-list')

class MediaEditConversation {
  constructor({ idFactory = () => crypto.randomUUID(), now = () => Date.now(), ttlMs = 5 * 60 * 1000 } = {}) {
    this.idFactory = idFactory
    this.now = now
    this.ttlMs = ttlMs
    this.pending = new Map()
  }

  plan({ instruction, sourcePath, clarificationId } = {}) {
    const source = String(sourcePath || '')
    if (!clarificationId) return this.remember(planEditInstruction({ instruction, sourcePath: source }))
    const id = String(clarificationId)
    const record = this.pending.get(id)
    this.pending.delete(id)
    if (!record || record.expiresAt <= this.now()) throw new Error('剪辑追问已失效，请重新说明')
    if (path.resolve(record.clarification.sourcePath) !== path.resolve(source)) throw new Error('剪辑追问与当前源视频不一致')
    return this.remember(resolveEditClarification({ clarification: record.clarification, answer: instruction }), id)
  }

  remember(result, existingId = '') {
    if (result?.decision) return { ...result, decision: attachEditDecisionList(result.decision) }
    if (!result?.clarification) return result || { matched: false }
    const id = existingId || this.idFactory()
    const expiresAt = this.now() + this.ttlMs
    this.pending.set(id, { clarification: result.clarification, expiresAt })
    return {
      matched: true,
      clarification: {
        id,
        reason: result.clarification.reason,
        question: result.clarification.question,
        sourcePath: result.clarification.sourcePath,
        expiresAt
      }
    }
  }
}

module.exports = { MediaEditConversation }
