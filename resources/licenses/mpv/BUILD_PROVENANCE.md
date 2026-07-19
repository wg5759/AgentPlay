# mpv Windows binary provenance

- Upstream project: <https://github.com/mpv-player/mpv>
- Release: `v0.41.0`
- Source commit: `41f6a645068483470267271e1d09966ca3b9f413`
- Reproducible build run: <https://github.com/wg5759/ai-player/actions/runs/29651413999>
- Workflow artifact: `mpv-v0.41.0-windows-x64-gpl-complete`
- Binary archive: `mpv-v0.41.0-windows-x64-gpl.zip`
- Binary archive SHA-256: `162DECE1C36816F8F72791CCCAC9052DDE596C765557996AAF3D8580AEAF9893`
- Complete corresponding source archive: `mpv-v0.41.0-complete-corresponding-source.zip`
- Source archive SHA-256: `162FF8ECA2B321739DCD4D846D3B7F3BEE737D6F71F98FE409419867A2536C1E`
- Source archive inventory: 46,849 files from 35 pinned repositories
- Upstream build script: <https://github.com/mpv-player/mpv/blob/41f6a645068483470267271e1d09966ca3b9f413/ci/build-win32.ps1>

The project workflow pins every moving source dependency and builds with `-Dgpl=true` and `-Dffmpeg:gpl=enabled`. Treat this bundled executable as GPL software; do not describe it as an LGPL build.

The local packaging inputs were compared byte-for-byte by SHA-256 against the verified binary archive on 2026-07-19:

| File | SHA-256 |
|---|---|
| `mpv.exe` | `9ADF2084F8DE4E40C6BC2E6EA099F8F602FCAA478C8CDE5169AED5C7DEA0D02F` |
| `mpv.com` | `B806176C5C1517F4D273C6FA24FDEBF8BCC6FA907288851E450E8318448149A3` |
| `mpv.pdb` | `41368B73560A8EAC2FB97EFFD477BE312581F5C55B0F05F3798F11A3BE5A123D` |
| `vulkan-1.dll` | `9CD597DCA1119ABC535A86BBD42E8BA681D98F00ECB35E616D5691D7AAE23A42` |

Before publishing an installer, attach or host both archives from the same manifest and keep the complete corresponding source available under the applicable GPL terms. A private or expiring Actions artifact is build evidence, not a stable public download location.
