# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

vid-studio 是一个 Electron 桌面应用，将 B 站视频转换为结构化知识时间轴（Markdown 格式）。前端为 Electron + Vue 3 + TypeScript，后端为 Python 处理管道（位于 `vid-engine/`，有独立的 `CLAUDE.md`）。

## 常用命令

```bash
# 开发（前端）
npm run dev          # 启动 Electron 开发服务器（热更新）
npm run typecheck    # 运行所有 TypeScript 类型检查
npm run lint         # ESLint 检查
npm run format       # Prettier 格式化

# 构建
npm run build        # 完整构建（含 typecheck）
npm run build:mac    # 打包 macOS
npm run build:win    # 打包 Windows
npm run build:linux  # 打包 Linux

# Python 后端（在 vid-engine/ 目录下）
pip install -r requirements.txt
python main.py "https://www.bilibili.com/video/BV1xxxxxx" --skip-video
```

## 代码风格

- `.prettierrc.yaml`：单引号、无分号、100 字符宽度、无尾逗号
- ESLint：`@electron-toolkit/eslint-config-ts` + `eslint-plugin-vue`
- Vue `<script>` 必须使用 TypeScript

## 架构

### 三进程模型

```
Renderer (Vue 3 UI)
  ↕ contextBridge API
Preload (IPC 桥接)
  ↕ ipcRenderer / ipcMain
Main Process (Electron)
  ↕ child_process.spawn
Python (vid-engine)
```

### IPC API（`src/preload/index.ts` → `src/main/index.ts`）

| 方法 | 方向 | 说明 |
|------|------|------|
| `api.importBrowserCookies()` | 渲染→主 | 从 Edge/Chrome 提取 B 站 Cookies |
| `api.parseVideo(url, options)` | 渲染→主 | 启动 Python 解析，输出写入 `/tmp` |
| `api.stopParse()` | 渲染→主 | Kill Python 子进程 |
| `api.onParseProgress(cb)` | 主→渲染 | 实时流式进度输出（Python stdout/stderr） |

### 前端核心文件

- **`src/main/index.ts`**（165 行）：窗口创建、IPC Handler、Python 子进程生命周期
- **`src/preload/index.ts`**（51 行）：通过 `contextBridge` 暴露 `window.api`
- **`src/renderer/src/App.vue`**（695 行）：单文件组件，含全部 UI 逻辑

### App.vue 结构

`App.vue` 是主要工作区，含三个区域：
1. **顶部栏**：URL 输入、模式切换（仅 ASR / 视觉精析）、Cookie 状态指示
2. **左侧**：webview 嵌入 B 站（`persist:bilibili` session），含跳转/播放控制和注入脚本
3. **右侧**：知识时间轴，包含实时进度日志和 Markdown 解析后的时间轴卡片

**Markdown 解析**（App.vue 内嵌）：正则匹配 `## HH:MM - HH:MM | 标题` 格式，解析出总结、核心观点、标签、原文记录，组装为时间轴卡片对象。

**webview 注入脚本**：
- `HOLD_PLAY_SCRIPT`：全屏前拦截自动播放
- `fullscreenScript`：点击全屏按钮（兼容多个选择器）
- `seekScript`：执行 `video.currentTime = seconds` 跳转

### 路径别名

- `@renderer` → `src/renderer/src`（配置于 `tsconfig.web.json` + `electron.vite.config.ts`）

## Python 后端

详见 `vid-engine/CLAUDE.md`，关键点：
- API Keys 配置在 `vid-engine/.env`（参考 `.env.example`）
- 必需：`SILICONFLOW_API_KEY`（ASR + Embedding）、`DEEPSEEK_API_KEY`（LLM）
- 可选：`ZHIPUAI_API_KEY`（视觉理解，`--visual-per-segment` 时需要）
- 主进程通过 `spawn` 调用 `vid-engine/main.py`，用 `stdout` 流式传递进度

## 构建产物

- macOS：DMG 安装包
- Windows：NSIS 安装器
- Linux：AppImage / Snap / Deb
- 配置见 `electron-builder.yml`
