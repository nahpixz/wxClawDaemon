# 🦞wxClawDaemon

<p align="center">
  <img src="./banner.jpg" alt="wxclaw_daemon banner" width="760" />
</p>

<p align="center">
  企业微信回调地址与可信 IP 自动化守护进程（含浏览器扩展联动）
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-ESM-3C873A?style=flat-square" />
  <img src="https://img.shields.io/badge/Chrome%20Extension-MV3-4285F4?style=flat-square" />
  <img src="https://img.shields.io/badge/Desktop-NodeGui-7B61FF?style=flat-square" />
  <img src="https://img.shields.io/badge/Tunnel-cloudflared-F38020?style=flat-square" />
</p>

---

## ✨ 项目简介

`wxclaw_daemon` 是一个“桌面守护进程 + Chrome 扩展”协同应用，用于自动维护openclaw企业微信后台配置，核心目标是：

- 自动管理公网访问入口（cloudflared 隧道）
- 自动发现并同步可信 IP 变化
- 自动更新企业微信应用回调地址（URL / Token / EncodingAESKey）
- 通过托盘 GUI 展示在线状态与关键运行信息


## 🧩 架构说明

```text
Daemon(NodeGui + WS)  <----WebSocket---->  Chrome Extension(MV3)
        |                                          |
        | 维护隧道 / 检测IP / 下发配置指令           | 在浏览器中自动操作页面
        v                                          v
cloudflared Tunnel                         WeCom Admin Console（企业微信后台）

```

## 🖼️ 界面预览

<p align="center">
  <img src="./screenshot.png" alt="wxclaw_daemon screenshot" width="760" />
</p>

## 🚀 快速开始

### 1) 安装依赖

```bash
cd daemon
pnpm install
```

### 2) 启动守护进程（开发模式）

```bash
pnpm start
```



## 🔌 加载浏览器扩展

1. 打开 Chrome 扩展管理页（`chrome://extensions/`）
2. 开启“开发者模式”
3. 选择“加载已解压的扩展程序”
4. 选择项目中的 `extension/` 目录

> 守护进程与扩展通过 WebSocket 协作，扩展加载成功后才能完成自动化配置闭环。

## 📁 目录结构

```text
wxclaw_daemon/
├─ README.md
├─ banner.jpg
├─ screenshot.png
├─ daemon/        # 守护进程（NodeGui、WS、隧道与打包）
└─ extension/     # Chrome Extension（MV3，页面自动化逻辑）
```

## ⚙️ 运行提示

- 请在 `daemon/` 目录执行脚本命令
- 首次运行前请准备好企业微信应用参数（如 `wxAppId` 等）
- 请确保扩展已加载并有目标后台页面访问权限

## 📄 License

Copyright (c) 2026 wxclaw_daemon contributors.
Licensed under the Apache License, Version 2.0.
