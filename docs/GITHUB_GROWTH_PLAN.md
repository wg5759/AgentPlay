# AgentPlay GitHub 增长方案

> 证据快照：2026-08-28。目标是获得真实用户、问题与贡献，不购买 Star、不互刷、不把 CI 克隆冒充采用。

## 执行进度（2026-08-28）

- P0 完成率：**9/10**。PR #22/#24/#31/#32/#40 已合并；0.9.1 Preview 2、双语 README、45 秒真实界面演示、三图画廊、GitHub Pages、16 个 Topics、公开维护者资料、AgentPlay 置顶和 6 个可领取 Issue 均已完成。
- 唯一未完成 P0：仓库 Social Preview 图片已生成并通过 1280×640 检查；用户截图证明 Chrome ChatGPT 扩展的文件 URL 访问早已开启，但 GitHub Settings 上传仍没有公开回读，因此继续按未完成记账，不能用本地图片或浏览器权限状态冒充仓库已展示。
- 第一轮公开发布：GitHub Prerelease、8 资产、Draft 回读、匿名安装器/便携包哈希验收与 Discussion #30 均完成；Stable 仍由有效 Authenticode 签名硬门阻断。
- 第二轮真实结果：Product Hunt 已通过 GitHub OAuth 建立维护者账号，AgentPlay 0.9.1 的主信息、开源仓库、缩略图、两张图库、三个标签、制造商身份与首条评论均已创建；发布清单必需项 100%，产品页为 `https://www.producthunt.com/products/agentplay-0-9-1?launch=agentplay-0-9-1`。已确认最早的 2026-08-28 太平洋时间排期并出现 launch-day 控制面板；因平台尚未日切且匿名读取受当前网络出口限制，状态为“已排期、待公开验收”，不得提前写“已上线”。Show HN 账号已由用户注册并登录，标题、GitHub 链接与技术说明填写后只提交一次，但 HN 重定向到 `/showlim`，明确限制新账号发布 Show HN；没有帖子 URL，不改成普通投稿、不重复提交绕过社区门槛。Electron 官方 `electron/apps` 条目按规范生成并通过 10,279 项 human-data 测试，但上游网页明确限制只有协作者可以创建 PR，因此没有绕过权限提交。
- 初始外部反馈：新增 `VedantMadane` 与 `Ap-0007` 两个真实用户 Fork，目前为 **1 个真实外部 Star、3 个真实外部 Fork、0 个外部 Issue/Discussion/PR**。Release 下载计数包含维护者的 Draft/匿名哈希验收，不得计为真实采用。
- 仓库公开描述已改为英文定位：`One local AI workspace for links, media, and documents`；官网、个人资料与置顶仓库均已公开回读。

## 推广前基线与当前差异

- 当前仓库：1 个真实外部 Star、3 个真实外部 Fork、0 个外部 Issue/讨论/PR；社区健康度 100%。
- 近 14 天 Traffic：28 views / 13 unique visitors；483 clones / 137 unique cloners。Clone 数包含 Actions、维护与机器人活动，不能直接当作用户采用。
- 历史入口缺口已关闭：仓库 homepage、维护者 profile、双语 README、真实演示、截图画廊与 0.9.1 Preview 均已公开；当前只剩 GitHub Social Preview 的网页上传回读和 Stable Authenticode 签名门。
- 已有优势：Apache-2.0、Issue forms、Discussions、贡献/安全/支持文档、双平台CI、SBOM/哈希/安全扫描和可恢复任务证据。

## 不能只把自己定义成“AI 视频编辑器”

`OpenChatCut`、`Timeline Studio`、`OpenCut` 与 `LosslessCut` 已分别占据对话式AI时间线、浏览器AI编辑、开源CapCut替代和无损剪辑心智。AgentPlay应固定为：

> **一个本地 AI 工作入口：打开文件或粘贴链接，完成下载、理解、字幕、拉片、编辑、文档与可验证交付。**

英文一句话：

> **One local AI workspace for links, media, and documents—download, understand, subtitle, edit, and deliver with recoverable tasks.**

差异点不是“功能比剪映多”，而是任意输入、同一对话、来源不被覆盖、审批可见、任务可恢复、成果有质量回执。

## 发布前 P0（缺一项都不要集中推广）

1. 经维护者确认后合并 PR #22，让默认分支真实包含 0.9.1，而不是只在 Draft PR 里可见。
2. 发布明确标注 `NotSigned` 的 0.9.1 Preview/Beta：Windows安装器、便携包、SHA-256、SBOM、安全报告、已知限制和最短升级说明齐全；没有签名时不得标 Stable。
3. 把 README 改为英文主文档＋`README.zh-CN.md`，首屏只回答“是什么、给谁、为什么不同、立即下载/看演示”。GitHub 官方也把 usefulness、getting started、help、maintainers列为README核心信息。
4. 用真实桌面程序制作 45–60 秒演示：粘贴链接→选择下载/下载并拉片；拖入视频→一句话剪片/字幕；拖入文档→立即预览并继续提要求；最后展示任务重启恢复和质量100回执。
5. README 首屏加入一张真实产品全景图和三张结果对比图；不得使用静态概念稿冒充运行界面。
6. 建立免费落地页（优先 GitHub Pages）：演示视频、下载、五个核心场景、隐私/本地边界、FAQ、路线图；把仓库 homepage 指向它。
7. 上传 1280×640 自定义 Social Preview。GitHub说明自定义图能让仓库链接在社交平台更容易被识别。
8. Topics 调整为高意图组合：`ai-video-editor`、`video-editor`、`video-editing`、`local-first`、`ffmpeg`、`electron`、`subtitles`、`video-analysis`、`video-downloader`、`document-ai`、`ai-agent`、`desktop-app`、`open-source`、`natural-language-video-editing`、`text-based-video-editing`、`agent-skills`。GitHub说明 Topics 会进入同主题发现页。
9. 完成维护者 GitHub profile：真实显示名、两句简介、项目站点，并把 AgentPlay 固定到个人主页。
10. 建立 5–8 个真正可独立领取的 `good first issue` / `help wanted`：英文快速上手、macOS实机、Linux AppImage、字幕样式样本、下载站点适配、文档翻译。每项必须给复现、验收和不允许修改的边界。

## 一次集中发布，而不是天天贴链接

| 顺序 | 渠道 | 内容 | 成功回执 |
|---|---|---|---|
| 1 | GitHub Preview Release＋Discussion | 真实演示、安装资产、哈希、限制、迁移说明 | Release下载、外部回复 |
| 2 | Product Hunt | 有落地页和视频后再发，定位“local AI workspace” | 产品页、评论与引流 |
| 3 | Show HN | 工程故事：为什么把审批、恢复和质量证据放进本地AI工作台 | 有意义评论，不追求一次爆榜 |
| 4 | LINUX DO / V2EX | 中文实测帖：一个链接/文件如何走到成果；完整披露Windows与未签名边界 | 真实问题与复现 |
| 5 | X / Reddit | 30秒GIF/视频＋两句话；只进允许自荐的相关社区 | GitHub referrer与讨论 |
| 6 | YouTube / B站 | 3–5分钟完整工作流，不做功能列表念稿 | 视频完播、Release点击 |
| 7 | Awesome/目录 | `awesome-electron`、开源替代、AI工具目录、AlternativeTo/OpenAlternative等逐个提交 | 合并PR或正式列表页 |

竞品的真实做法可验证：OpenChatCut 使用英文/中文README、官网、Product Hunt、Discord/微信群、真实产品巡览、频繁Release和SEO比较文章；Timeline Studio 使用11种README语言、在线Demo、YouTube、Hugging Face Space、skills.sh、Trendshift、Product Hunt Release和明确Help Wanted。AgentPlay现阶段最缺的不是更多功能，而是可视演示、英文入口、当前Preview和可领取贡献任务。

## 持续增长节奏

- 每周最多一次功能/修复 Release；每次只讲一个用户成果，附演示与回执。
- 每两周发布一次“真实问题→修复→证据”开发日志，回链到Issue/PR。
- 24小时内响应外部Issue，72小时内完成分诊；首个外部PR优先辅导，不用大改架构吓退贡献者。
- 每月更新场景画廊：用户授权素材、输入指令、输出、耗时、模型/本机边界；不得编造用户案例。
- Skill生态成熟后，再发布独立可安装的 AgentPlay 工作流 Skill 并提交 skills.sh/相关目录；当前没有跨Agent可执行合同前不抢跑。

## 只看真实增长指标

每周记录：GitHub unique visitors、有效 referrer uniques、Release独立下载、外部Issue/Discussion作者、首次贡献者、外部PR、演示点击到下载转化。Star只作附带指标；clone数据必须剔除CI/维护行为后才能讨论采用。

首月合理目标不是“冲1000 Star”，而是：50+外部独立访客、20+Preview下载、5个外部问题/讨论、1个外部PR、3个愿意复测的真实用户。

## 证据来源

- [GitHub：README应该回答项目用途、价值、上手、帮助与维护者](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)
- [GitHub：Repository Topics帮助项目进入主题发现](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics)
- [GitHub：自定义Social Preview](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview)
- [GitHub：Release可带资产、贡献者与关联Discussion](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)
- [OpenChatCut](https://github.com/0xsline/OpenChatCut)
- [Timeline Studio](https://github.com/MartinDelophy/ai-video-editor)
- [OpenCut](https://github.com/OpenCut-app/OpenCut)
- [LosslessCut](https://github.com/mifi/lossless-cut)
- [Cap](https://github.com/CapSoftware/Cap)
