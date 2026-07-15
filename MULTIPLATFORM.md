# AI播放器 多平台构建指南

## E1 Mac 打包（需 macOS）

```bash
cd D:\Ai工具升级\ai-player   # 或 Mac 上的对应路径
pnpm install
pnpm build:electron -- --mac dmg
# 产出：release/AI播放器-0.1.0.dmg
```

## E2 Linux 打包（需 Linux 或 WSL）

```bash
# 在 Linux/WSL 中：
cd /mnt/d/Ai工具升级/ai-player   # WSL 路径
pnpm install
pnpm build:electron -- --linux AppImage deb
# 产出：release/AI播放器-0.1.0.AppImage + .deb
```

Windows 直接构建 Linux 失败原因：缺 mksquashfs（Linux 工具）。
解决方案：安装 WSL2 Ubuntu -> 在 WSL 中执行上述命令。

## E3 安卓 APK（需 Android SDK）

```bash
cd D:\Ai工具升级\ai-player
# Capacitor 已初始化，android 平台已添加
pnpm build:web          # 构建 Web 前端到 dist/
npx cap copy android    # 复制到 Android 项目
npx cap open android    # 在 Android Studio 中打开
# 在 Android Studio 中：Build -> Build APK
```

需安装：Android Studio + Android SDK (API 33+) + JDK 17

## E4 iOS App（需 Mac + Xcode）

```bash
cd D:\Ai工具升级\ai-player   # 在 Mac 上
pnpm build:web
npx cap add ios
npx cap copy ios
npx cap open ios       # 在 Xcode 中打开
# 在 Xcode 中：选择签名 -> Build -> Run
```

需安装：Xcode 15+ + CocoaPods + Apple Developer 账号

## 当前已完成

| 平台 | 状态 |
|---|---|
| Windows | ✅ 已打包（免安装版 + 安装包）在 `D:\Ai工具升级\AI播放器\` |
| Web PWA | ✅ 已构建（vite build 产出 dist/） |
| Android | ✅ Capacitor 脚手架就位（需 Android Studio 构建 APK） |
| Mac | ⬜ 构建脚本就绪（需 Mac 执行） |
| Linux | ⬜ 构建脚本就绪（需 Linux/WSL 执行） |
| iOS | ⬜ 构建脚本就绪（需 Mac+Xcode 执行） |
