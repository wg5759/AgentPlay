# 首次组件恢复与连续外部打开验收（2026-09-06）

## 范围

本轮仅修复首次组件传输/安装恢复，以及大组件解压期间的主线程响应问题。未新增产品功能、未重新公开发布、未改用户配置或凭据。

## 已复现及修复

- 传输缺少响应头/数据空闲期限；连接中断后缺少有界续传；重试进度重复计数；完整 `.part` 仍联网；错误 Content-Range 可能污染已有进度；同尺寸损坏文件可能被接受。
- 首次安装只看部分可执行文件，旧 done 标记掩盖缺失文件；三次历史失败后永久停止自动恢复。改为完整包验证回执、过期状态复核、分组件结果和退避冷却，下次启动可恢复。
- Whisper tiny/small 共用根目录时完成标记不能互相覆盖。新增按清单 tag 隔离的回执，并绑定清单哈希与文件身份快照。
- ZIP 解压和大块同步写入占用 Electron 主线程。移至可取消、有期限的 Worker；继续固定清单路径、大小、SHA-256 校验，未放宽下载白名单或 TLS。
- 首个真实突发测试收到了全部 12 条 second-instance 消息，但 8 个转交进程在 15 秒后仍未退出：`release/startup-burst-IEnL1h/receipt.json`。早期 `app.quit()` 不足以保证这种未初始化次进程及时结束；改为仅在单实例锁失败、原生转交已完成的分支 `app.exit(0)`，主实例和有工作进程不走该路径。新退出红测在旧代码失败，修复后连同其它相关测试 41/41 通过。

## 证据

- 新传输测试最初 5 项失败，首次安装状态 4 项失败，大文件主线程写入回归失败；修复后聚焦命令 24/24 通过。
- `node --test tests/first-run-components.test.js tests/component-transfer-recovery.test.js tests/component-archive-worker.test.js tests/local-ai-download.test.js tests/single-instance-startup.test.js`
- TypeScript、ESLint、`node --check electron/main.js` 通过。
- 同一个固定 SHA 的真实 FFmpeg ZIP：旧路径最长主循环停顿 6066ms，Worker 路径 286ms。总耗时分别 19735ms/25981ms；不能宣称解压本身更快，也不能据此断言全部历史外部打开超时均已修复。
- 真实 ZIP 对照目录：`release/component-loop-before-LGHMqM`、`release/component-loop-after-6GWeeS/receipt.json`。
- 已安装 Electron 43.3.0 加载 ASAR 内新 Worker 模块验收通过：`release/worker-asar-probe-ndb5Jf/receipt.json`。这不等于已安装整套修复版。
- 独立公开修复分支提交 `5635557`，Draft PR https://github.com/wg5759/AgentPlay/pull/47 。

## 尚待收口

- 第一次连接验收器未到业务阶段，记录为 `release/startup-burst-HK7fE0/receipt.json`，不作为业务失败或成功；改用原生启动期的同步观察连接后抓到上述真实退出失败。
- 第一轮完整本地/CI 回归发现两处旧断言：旧三次永久停用行为与退出处理器固定截取 1200 字符。更新后相关 21 项通过；提交 `1d483e8` 的 Windows/Ubuntu CI 均通过，Actions `33990584734`。这不是后续退出修复的 CI 结果。
- 提交 `d7435c6` 的完整本地回归：1071 总计，1070 通过、0 失败、1 项 archive.org 直链网络跳过；完整日志 `release/startup-recovery-full-20260906.log`。第二候选包已构建。
- 后续次进程退出修复已推送提交 `70a7ea0`，GitHub Windows/Ubuntu CI 均通过：Actions `33990916404`。
- 第二候选实际突发测试仍有 5 个进程超过15秒，虽全部12条请求已收到（`release/startup-burst-fhhE9L/receipt.json`）；立即退出不是充分修复。
- 测试进程中延后/合并 show/focus 的诊断对照12/12退出，最大2788ms；两个完整包 installed=true，最后文件 readyState=4、历史可回读：`release/startup-burst-T2POgj/receipt.json`。因完整回归并行负载已结束，仍需不打诊断补丁的同条件对照，不能凭这一次实验直接归因或发布。
- 随后完全不打诊断补丁、保持相同第二候选包也12/12退出，最大3768ms；整包就绪、最后视频和播放记录验证通过：`release/startup-burst-kMYH5l/receipt.json`。因此尚不能归因为窗口聚焦，不往产品加入该猜测补丁。高并行压力下失败回执仍保留，继续用相同空闲负载复测旧退出候选区分变量。
- 相同无完整回归并行负载的旧 app.quit 候选也12/12通过，最大9059ms：`release/startup-burst-DNYWdY/receipt.json`。这进一步说明普通通过不能掩盖压力失败；单次快慢差不是可靠性能结论。
- 当前结论：组件下载故障恢复、完整包校验和非阻塞解压已有红绿及实际缓存首启证据；普通突发外部打开通过，但完整媒体回归并行负载下仍有15秒退出超时，**连续外部打开压力边界尚未完全解决**。PR保持Draft，不合并、不覆盖桌面或公开安装包。
- 实际首次安装验收使用逐项固定SHA验证的本地缓存，证明恢复/解压/就绪流程，不冒充在所有用户网络条件下首次从远端下载均成功；网络中断/停滞/续传由本地HTTP故障注入测试验证。
- 桌面和公开下载仍是 Preview 4；本文件不代表修复已安装、已发布或数字签名通过。

## 推广核验

- Preview 4、官网入口、双语入门和总方案已经公开。
- GitHub 当前 2 Stars（包含维护者自星；真实外部 Star 仍 1）、3 Forks；没有新增已验证有效反馈，未合并的外部 PR 不计已接受贡献。
- 公开简介已与迭代一致：One local AI workspace for links, media, and documents — download, understand, subtitle, edit, and deliver with recoverable tasks.
- Social Preview 仍未使用自定义图；反馈区置顶、SEO/归因、用例教程、60 秒新演示和真人试用等仍未完成。
- 近期 10 项清单只有版本一致性和下载入门一致性两项勾选；这不是 12 个月长期计划的完成率，也不代表已有真实用户增长。
- 本轮没有重复发帖、外联、点赞或创建推广自动化；先解决可靠性再推进下一项推广。
