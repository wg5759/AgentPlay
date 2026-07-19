import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const workflow = fs.readFileSync('.github/workflows/mpv-gpl-bundle.yml', 'utf8')
const packager = fs.readFileSync('scripts/package-mpv-corresponding-source.ps1', 'utf8')
const policy = JSON.parse(fs.readFileSync('release-public-policy.json', 'utf8'))

test('GPL rebuild pins mpv and emits matched binary and corresponding-source archives', () => {
  assert.match(workflow, /MPV_COMMIT: 41f6a645068483470267271e1d09966ca3b9f413/)
  assert.match(workflow, /runs-on: windows-2022/)
  assert.match(workflow, /timeout-minutes: 180/)
  assert.match(workflow, /uses: actions\/cache@v4/)
  assert.match(workflow, /vswhere\.exe/)
  assert.doesNotMatch(workflow, /Visual Studio\\2022\\Enterprise/)
  assert.match(workflow, /SHADERC_COMMIT: [0-9a-f]{40}/)
  assert.match(workflow, /FFMPEG_MESON_COMMIT: [0-9a-f]{40}/)
  assert.match(workflow, /WRAPDB_COMMIT: [0-9a-f]{40}/)
  assert.match(workflow, /Pin every moving source dependency/)
  assert.doesNotMatch(workflow, /meson wrap update-db/)
  assert.match(workflow, /package-mpv-corresponding-source\.ps1/)
  assert.match(workflow, /mpv-v0\.41\.0-windows-x64-gpl-complete/)
  assert.match(packager, /build-fetched-git/)
  assert.match(packager, /build-fetched-cmake/)
  assert.match(packager, /robocopy\.exe/)
  assert.match(packager, /if \(\$code -gt 7\)/)
  assert.match(packager, /\$_\.PSIsContainer/)
  assert.match(packager, /\$_\.Directory\.FullName/)
  assert.match(packager, /SOURCE-MANIFEST\.json/)
  assert.match(packager, /GPL-BUNDLE-MANIFEST\.json/)
  assert.match(packager, /subprojects\/ffmpeg/)
  assert.match(packager, /redistributor-build\/\.github\/workflows\/mpv-gpl-bundle\.yml/)
})

test('public binary release remains fail-closed until the source archive is hosted', () => {
  assert.equal(policy.sourceRelease.allowed, true)
  assert.equal(policy.binaryRelease.allowed, false)
  assert.deepEqual(policy.binaryRelease.requiredEvidence, [
    'correspondingSourceUrl',
    'correspondingSourceBytes',
    'correspondingSourceSha256',
  ])
})
