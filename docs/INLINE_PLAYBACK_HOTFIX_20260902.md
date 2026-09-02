# 原播放区域通用音视频修复（2026-09-02）

状态：已完成桌面同步与 [Preview 3 公开发布](https://github.com/wg5759/AgentPlay/releases/tag/v0.9.1-preview.3)。用户明确豁免本轮异源复审；安装路径 14 场景、发布源码双平台 CI、安装器/便携包载荷与全部 9 项匿名下载哈希均通过。最终结果以 [发布回执](RELEASE_0.9.1_PREVIEW3.md) 为准，下文保留前期诊断和候选历史。

实现提交：`f597ddc`，分支 `agent/0.9.1-inline-playback-20260902`。本记录不提高版本完成率。

## 实现范围

- 文件选择、外部打开、媒体库与播放视图共用音视频扩展名表。
- 播放前核对视频编码、音频编码及像素格式。浏览器可完整处理的文件直接播放，其余由本机 FFmpeg 或随包 mpv 准备 H.264/AAC 播放缓存，仍使用原区域的播放器及字幕、暂停、拖动、全屏控件。
- 不再自动打开独立 mpv 窗口；旧 `mpv:load` 非嵌入入口也回到原播放区。
- 原文件不改写；历史、字幕与 AI 操作继续绑定原始路径。缓存按源 SHA-256、输出 SHA-256、版本校验，源文件变化时拒收，取消等待进程关闭后清理本次半成品。
- 冷启动先注册播放 IPC，再创建窗口，避免文件打开早于可选服务初始化。快速切换按完整取消链串行收尾。
- 全屏只切换工作区样式，不再重建媒体元素，避免缓存重探测、字幕重载和画面中断。

这不是 libmpv 渲染器直接嵌入。首次准备需要时间、CPU 和磁盘；缓存是兼容预览，不承诺无损/HDR/多音轨完整保真。当前缓存上限 4 GiB，不自动删除用户原片。不承诺损坏、加密/DRM 或解码器本身不支持的文件可以播放；失败仍留在原区域说明原因。

## 实证与反例

1. 旧安装版打开完整 mp4v 宣传片：`DEMUXER_ERROR_NO_SUPPORTED_STREAMS`，duration=0，exit 1。源片经 FFmpeg 和随包 mpv 完整解码均通过，不能误判为损坏。
2. 仅在 HTML5 error 后转换仍不够：MPEG-4/AAC、FFV1/FLAC、ProRes/PCM 可只留下音轨而不报错。收紧为必须有视频尺寸/解码帧、有音频样本的 UI 红测，锁定该缺陷后加入预检。
3. 开机预检曾先于 IPC 注册，真实报 `No handler registered`；已前移注册。
4. 影院模式旧条件分支导致真实媒体元素被重建；`release/inline-fullscreen-red-20260902.log` 锁定该红测。新 UI 测试对比全屏前后同一 DOM 对象，并检查 ESC 后继续播放。
5. Chromium 会暂停被工具窗口遮挡的无声视频。可见 UI 验收进程单独关闭原生遮挡优化，生产应用没有修改该策略。不能把此类测试暂停当成文件损坏。

## 前期候选证据（最终闭环见发布回执）

- 解码矩阵：`release/inline-playback-smoke-8N1j3u/receipt.json`，16 项通过：13 个合成媒体样本、2 个无 FFmpeg 的随包 mpv 路径、1 个用户原片；源文件哈希保持不变。
- 最终严格 UI：`release/inline-ui-6JVUKq/receipt.json`，14 项通过。覆盖 mp4v/MP4、AVI、WMV、MPEG-2/TS、FFV1/MKV、ProRes/MOV、H.264/AAC、H.264/AC3、WMA、AIFF、AC3、FLAC、Opus 和原片。视频均解出真实画面，有声样本均解出音频数据，暂停/恢复、历史原路径、双击全屏、ESC、快速三请求取消链通过；本应用 mpv 无独立窗口。
- 截图：`release/inline-ui-6JVUKq/original-in-player.png`，退出全屏后原区域正常显示瀑布画面，不是加载占位图。
- 候选：`release/inline-candidate-kzpjCX/AgentPlay.exe`；对应 `inline-build-receipt.json` 校验 150 个源码/前端文件字节一致。
- 候选 ASAR SHA-256：`838490c5681019eab9c2808377f4adfcd998a14c7a63eea4bbabc19edf0002c0`。
- 未改动的现装 ASAR SHA-256：`5d5faccaca17aa298050c49ebf1a8c1ba0ca0399b86735829f7e5d29daedf8af`。
- 聚焦回归 14/14、TypeScript、ESLint、前端构建通过。全量最终回归 1028 项：1026 通过、0 失败、2 跳过；日志：`release/inline-regression-accepted-20260902.log`。两项跳过是 Internet Archive 外网暂不可用的电子书/音乐目录真实请求，跳过不计通过。
- 安全扫描：`release/inline-security-20260902.log`，success=true，currentFiles=583、historyBlobs=2306；不代表签名或公开发布。

## 后续交接

用户对本轮复审的明确豁免仅适用于此次修复；不修改全机规则。继续完成安装位回归、双平台 CI、未签名 Preview 3 安装器与便携包、SBOM、校验清单和公开下载哈希回读。保留原文件、配置及可恢复备份，不把未签名 Preview 写成 Stable。

安装位验收另发现第二实例在调用 app.quit 后仍继续 CommonJS 初始化。已加立即 return，并以真实模块片段红绿测试及第二实例限时退出验收锁定；原始 WMV 的独立探测为785ms成功，不能把该竞争误判为文件损坏。
