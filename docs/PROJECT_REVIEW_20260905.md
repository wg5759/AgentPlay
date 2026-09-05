# AgentPlay 整体审视（2026-09-05）

## 判断与核验边界

方向值得继续，但产品成熟度尚未跟上功能广度。已有本地素材、自然语言操作、模型替换、任务恢复、非破坏性编辑及成果追溯等长期资产；应定位为仍需加固的 Windows 内容工作台，不宜宣称成熟的通用个人 Agent 或专业剪辑软件。

没有统一的“未来标准”认证。本报告从意图理解、可靠执行、易用性、成果可编辑、开放互操作和持续交付六个维度判断。建议主线：**一句话，把现有素材变成可交付的视频与内容成果**。保留一个入口，重点打磨视频理解、双向字幕、自然语言剪辑、成片及镜头提示词蓝图。办公能力保留为配套，新增通用能力按真实需求扩展。

基线为本地 `be47866`，分支 `agent/0.9.1-window-mode-20260904`，开工干净。检查了模块目录、对话分发、模型与工具、持久任务、编辑规范、播放缓存、质量评分、插件、CI、发布文档，并执行两项隔离诊断。没有重新实机验收每项功能，也没有改动业务代码、真实任务、模型配置或远端状态。

公开 master 为 PR43 合并提交 `43758741f8c5ef3f644be0814cbc9ac274be9ca0`。最新公开包为 [0.9.1 Preview 3](https://github.com/wg5759/AgentPlay/releases/tag/v0.9.1-preview.3)，未签名 Prerelease；GitHub Latest 仍为 v0.7.6。桌面当日 ASAR 哈希为 `038E1FD598C5D85E773DF0F82D648A83C308A6A3A6275E839D62EA83536368DC`，含6493f01窗口补丁，尚未公开交付。仓库总量2 Stars、3 Forks，不等于活跃用户或采用者。

## 已有资产，应继续复用

| 能力 | 当前依据 | 判断 |
| --- | --- | --- |
| 持久任务、检查点、绑定审批和恢复令牌 | electron/persistent-task-runtime.js、media-edit-governance.js | 已实现，修复保留策略后继续用 |
| 模型工具调用循环、预算及回执 | electron/llm-service.js、agent-tool-registry.js、agent-run-ledger.js | 已有Agent执行机制，不能误报为没有 |
| 模型能力与授权过滤、速度用量质量记录 | electron/model-performance-router.js、model-config-store.js | 已有路由，重点校准评价与错误分类 |
| EDL、另存、撤销重做和项目版本 | electron/edit-decision-list.js、media-edit-project-store.js | 适合继续做可视化编辑及工程导出 |
| 项目胶囊、素材来源与证据定位 | electron/project-capsule-store.js、evidence-reference.js | 有持续工作基础 |
| 音画、字幕和成片技术校验 | electron/task-result-quality.js及音频/视觉质量模块 | 技术质量门有价值，需另评内容质量 |
| 声明式Skill、插件权限和凭据封装 | docs/PLUGINS_AND_SKILLS.md、electron/plugin-service.js | 适合小规模开放扩展 |

0.9.0与0.9.1固定规划各25项已有实现及既往验收，不重标为“没开发”。规划完成率、当前版本健康和真实用户成功率需要分别记录。

## 当前问题与证据

### P1：部分咨询和否定在模型理解前被关键词截走

位置：`src/components/agent-panel/intentRouter.ts:34–42、65–79、96–111`。把当前TypeScript转译后运行，仅注入内存状态和记录调用的任务桩，其他检测返回未匹配。在允许任务分发的模式下：

| 输入 | 实际分发 |
| --- | --- |
| 不要录屏，我只是想知道这个功能怎么用 | 发出record界面事件，并说已打开屏幕录制 |
| 屏幕录制支持哪些格式？ | 打开录屏入口 |
| 查重会不会删除我的原文件？ | runDedupTask |
| 先别压缩，视频太大是不是因为码率？（有当前视频） | runCompressTask |
| 不要批量压缩，我只是在问文件大小（有附件） | runBatchTask |
| 先不要处理这个文档，我只是打开看看（有附件） | runDocumentTask |
| 今天怎么样？ | send普通对话 |

这是路由误分发的复现，没有实际录屏、查重、压缩或文档写入。局部编辑规划已有咨询/否定保护，问题是主入口与任务族不一致。

改进：咨询、否定、条件、转述、歧义先走语义判断；明确的暂停、精确截取可保留快速路径。模型输出绑定素材的结构化计划，代码校验权限和参数。对主入口建立正反例，不继续用扩大的关键词表代替理解。咨询/否定负例要求零误执行。

### P1：任务超过200条会截掉尚未完成的记录

位置：`electron/persistent-task-runtime.js:65–66、152–154`，读取和入队均直接slice(-200)，没有按终态区分。

隔离运行真实PersistentTaskRuntime源码，只把文件系统替换成内存Map，不注册执行器。创建201条排队任务，再用同一内存文件重启实例：

```json
{"created":201,"beforeRestart":200,"afterRestart":200,"firstPendingRetained":false,"newestRetained":true,"allRemainingQueued":true,"diskFilesWritten":0}
```

改进：保留全部未完成任务，只归档满足保留策略的终态历史；容量不足则明确拒绝新任务。补充损坏主文件的备份恢复，不能静默退回空任务列表。先修边界，无需立即重做数据库。验收超过200条、长期待审批、重启、取消恢复并发及损坏主文件，未完任务不丢、完成步骤不重复。

### P1：复杂格式首开仍受完整缓存转换限制

`electron/inline-playback-service.js:86–190`：不支持直放的媒体经过整源哈希、完整转换、探针及输出哈希后才返回播放路径；默认4GiB缓存，满后要求用户去目录清理，转换超时一小时。这解决了原播放区域问题，却可能让大文件、旧CPU和长期缓存积累影响体验；本轮没有重新测首帧耗时。

短期统一播放会话/窗口状态，做首帧、寻址、字幕、切片、结束、ESC和重开矩阵，提供应用内缓存管理。中期对原生嵌入后端做限期验证，比较首帧、CPU/GPU、字幕叠层、硬解与打包。mpv官方推荐libmpv用于嵌入其他应用，但需验证Electron桥接和第三方许可，不能把库存在当作替换完成。已有HTML5及缓存路径可保留作兼容回退。

### P2：成果检查存在大文件同步整读

`electron/task-result-quality.js:48–56`先fs.readFileSync读整个文件，再subarray取256KiB；评分器在`electron/main.js:1308`接入持久任务。这不是有界文件头读取，大视频可能增加主进程内存与阻塞。本轮只确认代码路径，未测卡顿或内存峰值。应改有界读取，重处理放异步或受控工作进程，再测性能。

### P2：技术质量分不能代表内容满意度

`electron/task-result-quality.js:765–771`已有技术/语义profile，但TaskCenter通用显示“质量评分”，main.js:1320又把该分记入模型表现。格式、音画、字幕布局、报告结构和时间覆盖可检查，但不足以证明译文自然、剪辑好看或镜头提示词可执行。

保留已有E5合成及真实素材标定；界面改为“技术检查通过/内容核对状态/待确认项”，成果优先、账本折叠。建立真实留出集，分别评事实、翻译、镜头方案和用户返工；按任务类别选择模型评价指标，避免主要用导出技术分排名内容模型。已有模型自动路由无需重建，硬编码名称及把504等泛错误当视觉不支持的回退也应按错误类别整理（llm-service.js的completeVisionMulti）。

### P2：公开交付与文档有漂移

[最新Source Quality Gate](https://github.com/wg5759/AgentPlay/actions/runs/33865535840)整体失败；两平台pnpm check成功，npm生产安全审计均因ERR_SOCKET_TIMEOUT失败，后续全依赖审计未执行。不能称发现漏洞，也不能称审计通过。应分别呈现源码结果、审计服务可用性和漏洞发现，网络失败有界重试而不绕过检查。

README同时呈现旧Latest v0.7.6和新Preview3；本地新增补丁却仍显示0.9.1。应明确推荐下载、可见构建号、更新渠道、回滚点和发布字节一致性。签名证明来源信任，稳定性靠功能与运行验收；两者分开治理，并说明历史Stable标签与当前政策的区别。

build.yml两平台仍用Node20；当日官方已列20为EOL、24为LTS，应验证后升级开发/CI基线。这不等于Electron内嵌Node也使用20。MULTIPLATFORM.md仍保留0.8.0及历史三平台CI文字，应与当前Ubuntu/Windows源码质量配置对齐，不能据此宣称其他桌面端已交付。

## 架构、界面与生态建议

含空行：main.js6022行、PlayerView1467行、media-edit-service2251行、AgentPanel580行。行数本身不是缺陷，关注播放、字幕、窗口、服务注册的耦合。按职责抽离稳定接口，让主进程装配、播放会话、窗口状态、后台任务分别只有一个状态来源。优先修真实问题，随修改逐步拆分。

模型可见内置工具26个，另有20类编辑治理任务，二者职责不同，不要求数量相等；应减少新增能力时在多张分发表重复补名称。IPC已有主窗口sender检查、contextIsolation与nodeIntegration控制；后续评估框架来源及参数schema覆盖。本轮不是渗透测试或安全认证。

保留“对话＋内容画布＋折叠任务区”，让用户能直接选字幕、片段或镜头卡，再说“把这一段改短”。技术证据和模型高级选项按需展开，常用操作、错误恢复和撤销保持可见。一次连接模型后自动检测文本/视觉/工具能力，普通用户选择效果和隐私偏好即可。

插件目前是声明式Skill和内置工具映射，尚非任意执行器市场。将来按真实需求增加MCP适配器，复用任务、审批与结果协议；MCP不自动解决语义理解和操作系统沙箱。自有EDL可试点OTIO工程导出，用户在专业软件继续加工；OTIO引用媒体而不携带媒体，效果/字幕互通受适配器限制，需明确不支持项。

## 有限三轮计划（建议，未改总规划或实现）

| 顺序 | 范围 | 完成条件 |
| --- | --- | --- |
| 1 可靠交付 | 未完任务保留、大文件有界检查、窗口补丁公开同步、CI超时分类和受支持Node基线 | 对应红测转绿，候选及真实安装核心流程通过，源码/构建号/公开字节和回滚点一致 |
| 2 理解与使用 | 咨询/否定/执行分流、附件上下文、自动模型能力检测、内容画布和直接修改 | 主入口负例零误执行；新用户无需懂模型术语即可得到首个成果；结果能看见、修改、撤销 |
| 3 真实效果 | 留出素材评测、独立试用、复杂格式原生后端小范围验证 | 在声明硬件及语料上记录首帧、P95延迟、恢复及任务完成率，达到明确门槛再扩大推广 |

建议后续安排5–10位真实创作者，测试参考视频→两部分拉片与提示词、长视频→字幕与短版、已有素材→一句话修改并导出。此规模是建议，不是已招募或已验证市场。指标先测基线：首个可用成果时间、独立完成比例、播放无卡死、字幕准确与同步、返工次数和恢复率；不要凭空宣称速度或成功率。

硬条件可立即确定：未完任务不丢、原件不覆盖、否定不执行、任何全屏可退出。多Agent大编队、六端齐发、通用电脑管家、更多无关模型入口和完整自由NLE暂缓，保留现有能力维护。下一轮重点是收敛可靠性和体验，不是再加几十项功能。

## 一手资料

- [Anthropic：Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)：工作流与动态规划的区别、复杂度应有可测收益；文章提示2024年工具描述已变化，本文只借架构原则。
- [Anthropic：Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)：组合确定性、模型和人工评价，校准真实结果。
- [MCP Tools 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)：输入输出schema及失败反馈；这是本轮核对的修订。
- [mpv嵌入文档](https://mpv.io/manual/master/#embedding-into-other-programs-libmpv)：libmpv嵌入路线。
- [OpenTimelineIO](https://opentimelineio.readthedocs.io/en/latest/)：剪辑结构交换与外部媒体引用。
- [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security)：隔离、IPC与运行时维护。
- [Node.js Releases](https://nodejs.org/en/about/previous-releases)：当日20 EOL、24 LTS。

检查日期2026-09-05。官方资料支持实现原则；产品定位、优先级和试用规模属于建议。已复现问题本轮未修复。
