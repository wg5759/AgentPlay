const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8')

test('SignPath re-application evidence is public, honest and excludes personal fields', () => {
  const evidence = read('docs/SIGNPATH_REAPPLICATION.md')
  for (const marker of ['prior rejection', 'one genuine non-maintainer Star', 'three genuine non-maintainer Forks', 'No paid certificate', 'Remaining human-only fields']) {
    assert.match(evidence, new RegExp(marker, 'i'))
  }
  assert.match(evidence, /does not present maintainer-created Issues.*as independent community adoption/i)
  assert.match(evidence, /Approval remains solely at SignPath Foundation's discretion/i)
  assert.match(evidence, /Form submitted — Thank you, we'll be in touch soon\./)
  assert.match(evidence, /proof of form delivery only[\s\S]*not approval/i)
  assert.match(evidence, /v0\.9\.1-preview\.2[\s\S]*eight release assets/i)
  assert.match(evidence, /no external Issues, Discussions or pull requests/i)
  assert.doesNotMatch(evidence, /@[a-z0-9.-]+\.(com|cn|net)\b/i)
})

test('manual SignPath v2 workflow builds a GitHub artifact before signing and never publishes', () => {
  const workflow = read('.github/workflows/signpath-release.yml')
  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /github\.ref == 'refs\/heads\/master'/)
  assert.match(workflow, /runs-on: windows-latest/)
  assert.match(workflow, /id: upload-unsigned[\s\S]*uses: actions\/upload-artifact@v7/)
  assert.match(workflow, /uses: signpath\/github-action-submit-signing-request@v2/)
  assert.match(workflow, /github-artifact-id: \$\{\{ needs\.build-unsigned\.outputs\.artifact-id \}\}/)
  assert.match(workflow, /SIGNPATH_ENABLED != 'true'/)
  assert.doesNotMatch(workflow, /gh release create|softprops\/action-gh-release|contents: write/)
  assert.doesNotMatch(workflow, /SIGNPATH_API_TOKEN:\s*[^$\s]/)
})

test('pinned mpv restore verifies the public archive before copying only runtime files', () => {
  const script = read('scripts/prepare-pinned-mpv-runtime.ps1')
  assert.match(script, /162DECE1C36816F8F72791CCCAC9052DDE596C765557996AAF3D8580AEAF9893/)
  assert.match(script, /Get-FileHash[\s\S]*SHA256/)
  assert.match(script, /mpv\.exe[\s\S]*mpv\.com[\s\S]*vulkan-1\.dll/)
  assert.doesNotMatch(script, /\.pdb/)
})
