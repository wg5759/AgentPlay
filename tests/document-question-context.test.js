const test = require('node:test')
const assert = require('node:assert/strict')
const { questionContext } = require('../electron/document-question-context')
test('document questions get bounded, located evidence even near the end of a long line', () => {
  const text = '普通内容'.repeat(5000) + '。租赁到期日为2030年3月1日。'
  const result = questionContext([{ name: '合同.txt', text }], '这份合同的到期日是什么？', 600)
  assert.match(result, /2030年3月1日/)
  assert.match(result, /合同.txt:L1/)
  assert.ok(result.length <= 600)
  assert.ok(text.endsWith('。租赁到期日为2030年3月1日。'))
})
