# AgentPlay

<p align="center">
  <img src="resources/icons/agentplay-mark.svg" width="88" alt="AgentPlay bird mark">
</p>

<p align="center">
  <strong>One local AI workspace for links, media, and documents.</strong><br>
  Download, understand, subtitle, edit, and deliver with recoverable tasks.
</p>

<p align="center">
  <a href="https://wg5759.github.io/AgentPlay/">Website</a> ·
  <a href="docs/assets/promo/agentplay-demo.mp4">45-second demo</a> ·
  <a href="https://github.com/wg5759/AgentPlay/releases">Downloads</a> ·
  <a href="docs/QUICK_START.md">Quick start</a> ·
  <a href="README.zh-CN.md">中文</a>
</p>

<p align="center">
  <a href="https://github.com/wg5759/AgentPlay/actions/workflows/build.yml"><img alt="Source quality" src="https://github.com/wg5759/AgentPlay/actions/workflows/build.yml/badge.svg?branch=master"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/License-Apache--2.0-blue.svg"></a>
  <img alt="Windows 11 x64 verified" src="https://img.shields.io/badge/Windows_11_x64-verified-2ea44f">
  <img alt="Local-first" src="https://img.shields.io/badge/local--first-default-39c6ff">
</p>

![AgentPlay workspace](docs/assets/promo/social-preview.png)

<table>
  <tr>
    <td width="33%"><img src="marketing/remotion/public/workspace.png" alt="AgentPlay unified workspace with a local video"></td>
    <td width="33%"><img src="marketing/remotion/public/edit.png" alt="AgentPlay natural-language non-destructive video editing result"></td>
    <td width="33%"><img src="marketing/remotion/public/create.png" alt="AgentPlay AI asset generation result with provenance"></td>
  </tr>
  <tr>
    <td align="center">One calm entry</td>
    <td align="center">Say the edit</td>
    <td align="center">Create with provenance</td>
  </tr>
</table>

AgentPlay is a desktop workspace built around one simple interaction: open a file or paste a link, then describe the result you want. It combines reliable playback with downloads, subtitles, video analysis, natural-language editing, document work, AI creation, and visible delivery evidence.

It is not another hidden automation spinner. Source files are preserved, risky actions require approval, long tasks have checkpoints, and completed work can carry quality scores, failure reasons, repair history, and hashes.

## What you can do

- Paste a YouTube, Bilibili, Douyin, X, or Facebook link and choose **Download only** or **Download + analyze**.
- Open horizontal or vertical video without changing its aspect ratio; control playback, subtitles, speed, fullscreen, and external subtitle files.
- Say “keep seconds 4–20”, “remove this segment”, “add background music”, “repair the audio”, or “make 16:9, 9:16, and 1:1 versions”.
- Translate, shift, style, mux, or burn subtitles while keeping the original media untouched.
- Produce a professional two-part video breakdown: what the video says, then how its camera, editing, sound, rhythm, and visual language can be recreated with AI.
- Drop DOCX, XLSX, PPTX, PDF, images, or text into the same workspace, preview them, and continue with a natural-language request.
- Connect cloud models, OpenAI-compatible APIs, Ollama, LM Studio, vLLM, llama.cpp, or the optional local Qwen component through three simple choices: **Smart**, **Local only**, or **Quality first**.

## Why AgentPlay is different

| Typical AI tool | AgentPlay |
| --- | --- |
| One feature, one screen | Links, media, subtitles, documents, and creation share one entry |
| Progress disappears after a crash | Recoverable long tasks use persistent checkpoints |
| “Done” without proof | Quality gates, receipts, output hashes, and explicit failure reasons |
| Cloud routing is hidden | Local-first defaults and approval before content goes online |
| Editing overwrites the source | Results are saved separately with undo/redo project history |

## Download

The current public stable release is [v0.7.6](https://github.com/wg5759/AgentPlay/releases/tag/v0.7.6). The newer line is available as [v0.9.1 Preview 3](https://github.com/wg5759/AgentPlay/releases/tag/v0.9.1-preview.3), an explicitly **unsigned GitHub Prerelease** for early testers.

Preview 3 keeps local video and audio in the same player area, checks both tracks before playback, and prepares a local compatibility cache when needed. Originals stay unchanged; first-time preparation can take time. Fullscreen and Escape preserve the active media element.

Unsigned Preview/Beta builds are GitHub prereleases and include an installer, portable ZIP, SHA-256 checksums, a release manifest, verification report, security scan, SBOM, and a reviewed installation script. They may trigger Windows SmartScreen because AgentPlay does not yet have an approved Authenticode certificate. Unsigned builds are never labeled Stable.

Use only the [official Releases page](https://github.com/wg5759/AgentPlay/releases) and verify SHA-256 before installing.

## Five-minute start

1. Download the Windows x64 package from the official Releases page and verify its SHA-256.
2. Drop a local video, image, or office file into AgentPlay, or paste a supported video link.
3. For links, choose **Download only** or **Download + analyze**. For files, preview or play them first, then continue in the same input box.
4. Choose **Smart**, **Local only**, or **Quality first** only when an AI task needs a model. Playback, local downloads, and deterministic document conversions do not require a cloud model.
5. Open **Tasks & results** to inspect progress, evidence, failures, and recoverable work.

See the [quick-start guide](docs/QUICK_START.md) for model setup, logs, downloads, and troubleshooting.

## Verified scope

- Windows 11 x64 has real installed-app acceptance for playback, supported downloads, media editing, subtitle workflows, office output, task recovery, and plugin/Skill permissions.
- The E5 professional editing corpus passed 20/20 packaged-app samples at quality 100; eight restart cases repeated zero completed steps and used zero cloud calls.
- Ubuntu and Windows CI validate source quality. CI configuration is not claimed as macOS/Linux desktop delivery.
- macOS, Linux, Android, and iOS do not yet have the same end-to-end release evidence. See [MULTIPLATFORM.md](MULTIPLATFORM.md).

## Security and privacy

- Voice wake, LAN upload, device sync, and DLNA are off by default.
- API keys are stored through the desktop credential boundary and must never be pasted into logs or issues.
- Local document transforms do not use a model. Cloud rewriting, translation, summarization, or generation sends only required selected content after approval.
- Plugins and Skills are declarative and permission-scoped; they cannot silently register arbitrary executable code.

Read [PRIVACY.md](PRIVACY.md), [SECURITY.md](SECURITY.md), and [SUPPORT.md](SUPPORT.md) before deploying AgentPlay in sensitive environments.

## Development

Requirements: Node.js 24 LTS and pnpm 10.32.1.

```powershell
pnpm install
pnpm dev:electron
pnpm check
```

Windows packaging also needs repository-external redistributable media/runtime assets recorded by the release manifest. See [RELEASING.md](RELEASING.md) for reproducibility, signing, Preview/Beta/Stable channels, and public verification gates.

Third-party extensions use the declarative [plugin and Skill interface](docs/PLUGINS_AND_SKILLS.md). Contributions should start with [CONTRIBUTING.md](CONTRIBUTING.md) and a scoped issue.

## Community

- Questions, ideas, and showcases: [GitHub Discussions](https://github.com/wg5759/AgentPlay/discussions)
- Reproducible defects: [Issue forms](https://github.com/wg5759/AgentPlay/issues/new/choose)
- Roadmap and completion status: [ROADMAP.md](ROADMAP.md)
- Version history: [CHANGELOG.md](CHANGELOG.md)

AgentPlay source code is licensed under [Apache License 2.0](LICENSE). Third-party components retain their own licenses in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The AgentPlay name and bird mark are covered by [TRADEMARKS.md](TRADEMARKS.md).
