# AgentPlay 0.9.1 Preview 3 发布回执

收尾边界：产品代码 PR #42 与 Release 已完成；文档 PR #43 于2026-09-04获得用户明确合并授权并合并为 `4375874`。私有知识库历史归档动作仍未执行。9月4日另有[仅桌面窗口修复](WINDOW_MODE_RECOVERY_20260904.md)，不修改此处 Preview 3 的既有发布资产与哈希。

- 发布时间：2026-09-02 14:08:05（北京时间）。
- 公开版本：[v0.9.1-preview.3](https://github.com/wg5759/AgentPlay/releases/tag/v0.9.1-preview.3)，未签名 Prerelease；不是签名 Stable。
- 源码：[PR #42](https://github.com/wg5759/AgentPlay/pull/42) 已合并，发布 tag 指向 `65659f143db8ddaa6034d29c1a63e48c278f5cf1`。
- [发布源码的双平台质量检查](https://github.com/wg5759/AgentPlay/actions/runs/33596612111) 和 [Pages](https://github.com/wg5759/AgentPlay/actions/runs/33596611819) 成功。
- 桌面已同步最终归档，安装路径 14 个真实音视频场景通过；视频帧、音轨解码、暂停/恢复、seek、全屏/ESC 同节点、快速取消与二次进程退出均有验收。
- 安装器和便携包均已解包，所含 ASAR/EXE 与验收桌面字节一致。全部 9 项发布资产完成无登录凭证的完整下载与 SHA-256 校验。
- [公开播放验证](https://github.com/wg5759/AgentPlay/releases/download/v0.9.1-preview.3/AgentPlay-0.9.1-playback-verification.json)、[校验清单](https://github.com/wg5759/AgentPlay/releases/download/v0.9.1-preview.3/AgentPlay-0.9.1-SHA256SUMS.txt)、SPDX SBOM、签名状态与安全报告随 Release 提供；没有用户媒体或凭证。
- 应用归档 SHA-256：`3E7ACCBFCED9353E96F533126DE73B7C666A61199DD80029C27528CAB83686CB`。
- 安装器 SHA-256：`B8D1EE70F55309157D38A4E83B4CC43F59AA8357D9D69BB9160BA2E0464E663C`。
- 便携包 SHA-256：`DFCC4BC9A925E2F25AD3B69219AEE855B7B4FEED4B80CF5EF9CE643FF7B49170`。

## 范围与边界

用户明确豁免的是本轮异源模型复审，不是测试、CI、签名披露或校验。构建依赖 Browserslist 已固定为 4.28.7，修复两条高危告警；无购买证书、付费复审或云端转码。

兼容媒体在原播放区使用本机缓存，原片不变；这不是 libmpv 直接嵌入，不承诺损坏/DRM、HDR、多音轨及所有长度都能无损播放，首次准备与 4 GiB 缓存上限有明确提示。macOS/Linux 实机与签名 Stable 不计为本次完成。

另有两个独立维护项保留：部分空白 profile 的可选组件自动安装返回错误；Dependabot 重建 React 等升级 PR 出现 updater 错误。它们不应冒充本版主线质量门失败或已修复，也不能据此升级不相关大版本。此次匿名下载为维护者验收，不计为外部用户增长。
