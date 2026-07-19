# 参与贡献

感谢参与 AgentPlay。提交改动前请先确认问题边界，并把“测试通过”“发行包完整”“公开发布安全”作为三个独立结论。

## 开发规则

1. 从单一问题或纵向功能切片开始，避免把无关格式化混入提交。
2. 新功能必须有可失败的自动化测试；播放、IPC、网络和文件处理改动还需真实应用冒烟测试。
3. 不提交 API Key、证书、用户媒体、大模型、构建缓存或安装包。
4. 网络监听、麦克风、屏幕捕获和电脑操作必须默认关闭并由用户显式启用。
5. 新增第三方二进制、字体、媒体或模型时，必须记录来源、版本、哈希和许可证。

## 提交前检查

```powershell
pnpm exec tsc --noEmit
pnpm exec eslint src --max-warnings=0
pnpm test
pnpm build:web
pnpm audit --prod --registry=https://registry.npmjs.org
```

影响安装包时还应运行 `pnpm release:verify`、`node scripts/smoke-packaged-ui.mjs` 和真实媒体渲染验收。

安全漏洞不要提交公开 Issue，请按 [SECURITY.md](SECURITY.md) 私密报告。
