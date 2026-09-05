# AgentPlay quick start

[中文](QUICK_START.md)

## 1. Choose the current public preview

Start with [0.9.1 Preview 3](https://github.com/wg5759/AgentPlay/releases/tag/v0.9.1-preview.3), an unsigned prerelease (NotSigned) for early testers. The historical stable tag 0.7.6 is also unsigned; it is a rollback reference, not this guide's recommended test build.

Choose one asset from that official release:

- **Installer:** AgentPlay-0.9.1-Windows-x64-Standard.exe for a normal Windows installation.
- **Portable:** AgentPlay-0.9.1-Windows-x64-Portable.zip. Extract the complete folder, then run AgentPlay.exe; do not run it inside the ZIP.

Download AgentPlay-0.9.1-SHA256SUMS.txt from the same page and compare the matching filename's hash:

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath '.\AgentPlay-0.9.1-Windows-x64-Standard.exe'
```

Continue only when the source and hash match. Windows may show an unknown-publisher warning. A matching checksum does not remove SmartScreen; do not disable system protection or run unreviewed remote scripts.

## 2. A three-minute first task: play a local video

This is a small workflow, not a speed guarantee; download, installation and first-time compatibility preparation are additional.

1. Open AgentPlay and drag in a short video you already own and can play.
2. Check that the picture keeps its original aspect ratio. A file with an audio track should also have sound; a silent source need not.
3. Press Space to pause/resume and drag the progress bar. If you enter fullscreen, press Escape (ESC) to leave it and check playback again.
4. Find the original video in playback history. A spinner or highlighted progress dot alone is not success.

No cloud model, API key or language-model download is needed for this task. Some formats need a decoder-component download or a local compatibility cache; the original stays unchanged. If playback, proportions, fullscreen exit or component installation fails, stop and report the step rather than resubmitting repeatedly.

Public Preview 3 is not the unpublished candidate: further startup-component, window and subtitle fixes are in [PR #44](https://github.com/wg5759/AgentPlay/pull/44). Update only when the new release is actually available; a source branch is not a public Preview 4 installer.

## 3. Connect AI only when you need it

Choose Smart, Local only or Quality first in the model connection screen. Smart selects among connections you have configured; Local only depends on your hardware and optional components; Quality first uses a configured cloud service with task-level permission. Installing AgentPlay does not grant cloud credits.

Paste API keys only into the model connection form, never an issue, chat, screenshot or log. After basic playback works, try a link with Download only; Download + analyze also produces a two-part content and audiovisual/AI-recreation report, not the original author's hidden prompt.

## 4. Get help without sharing private media

Report the build, Windows version, intended action, extension/codec if known, failed step and a redacted screenshot. You do not need to attach the original media or document. Logs usually live at %APPDATA%\ai-player\logs\; remove keys, cookies, account data, private paths and file contents before sharing.

- [Bug report](https://github.com/wg5759/AgentPlay/issues/new?template=bug_report.yml)
- [Questions](https://github.com/wg5759/AgentPlay/discussions/categories/q-a)
- [Private security report](https://github.com/wg5759/AgentPlay/security/advisories/new)

See [Support](../SUPPORT.md), [Privacy](../PRIVACY.md) and [Platform status](../MULTIPLATFORM.md).
