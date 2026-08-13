const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

test('public onboarding keeps stable downloads separate from the 0.8.0 source candidate', () => {
  const readme = read('README.md')
  const quickStart = read('docs/QUICK_START.md')

  for (const content of [readme, quickStart]) {
    assert.match(content, /(?:公开)?稳定版[^。\n]*0\.7\.6|0\.7\.6[^。\n]*(?:公开)?稳定版/)
    assert.match(content, /0\.8\.0[^。\n]*(?:源码)?候选|(?:源码)?候选[^。\n]*0\.8\.0/)
    assert.match(content, /尚未.*签名|未经签名|未取得 Authenticode 签名/s)
  }
  assert.match(readme, /5 分钟上手/)
  assert.match(readme, /discussions/)
  assert.match(readme, /resources\/icons\/agentplay-mark\.svg/)
})

test('community guidance distinguishes real adoption from maintainer and bot activity', () => {
  const community = read('docs/COMMUNITY.md')
  assert.match(community, /浏览量、克隆量、维护者自己创建的 Issue\/Discussion、CI 机器人和 Dependabot 活动都不等于真实用户采用/)
  assert.match(community, /真实外部参与/)
  assert.match(community, /不能伪造/)
})

test('structured issue forms collect reproducible evidence without secrets', () => {
  const templateDir = path.join(root, '.github', 'ISSUE_TEMPLATE')
  const bug = read('.github/ISSUE_TEMPLATE/bug_report.yml')
  const feature = read('.github/ISSUE_TEMPLATE/feature_request.yml')
  const config = read('.github/ISSUE_TEMPLATE/config.yml')

  assert.equal(fs.existsSync(path.join(templateDir, 'bug_report.md')), false)
  assert.equal(fs.existsSync(path.join(templateDir, 'feature_request.md')), false)
  assert.match(bug, /^name: Bug 报告$/m)
  assert.match(bug, /id: reproduce/)
  assert.match(bug, /id: logs/)
  assert.match(bug, /API Key、Cookie、私密媒体/)
  assert.match(feature, /^name: 功能建议$/m)
  assert.match(feature, /id: problem/)
  assert.match(feature, /id: outcome/)
  assert.match(config, /^blank_issues_enabled: false$/m)
  assert.match(config, /security\/advisories\/new/)
})

test('local links in onboarding documents resolve to repository files', () => {
  const documents = ['README.md', 'SUPPORT.md', 'docs/QUICK_START.md', 'docs/COMMUNITY.md']
  const markdownLink = /!?\[[^\]]*\]\(([^)]+)\)/g

  for (const document of documents) {
    const content = read(document)
    for (const match of content.matchAll(markdownLink)) {
      const target = match[1].trim().replace(/^<|>$/g, '')
      if (/^(?:https?:|#)/i.test(target)) continue
      const fileTarget = decodeURIComponent(target.split('#')[0])
      const resolved = path.resolve(root, path.dirname(document), fileTarget)
      assert.equal(fs.existsSync(resolved), true, `${document} has a missing local link: ${target}`)
    }
  }
})
