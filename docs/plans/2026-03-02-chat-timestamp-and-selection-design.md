# 设计文档：AI 对话时间点跳转 + 文本选中复制

**日期**：2026-03-02
**状态**：已批准

---

## 需求

1. AI 对话输出中的时间点（格式：`[MM:SS]` 或 `[HH:MM:SS]`）可点击跳转
2. 对话内容可以被选中并复制

---

## 方案：后处理 HTML + 事件委托（方案 A）

### 1. 时间点检测与渲染

**位置**：`renderMarkdown` 函数（App.vue 第 435-447 行）

流程：
1. `marked.parse(content)` 得到 HTML 字符串
2. 用正则匹配所有 `[HH:MM:SS]` / `[MM:SS]` 格式（含可选小时位）
3. 将匹配替换为带 `data-seconds` 属性的 `<a>` 标签：
   ```
   [01:23] → <a class="ts-link" data-seconds="83">[01:23]</a>
   ```
4. 计算秒数：`HH*3600 + MM*60 + SS`

正则表达式：
```
/\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/g
```

### 2. 点击事件处理

**位置**：`.markdown-body` 父 div 上添加 `@click.prevent` 事件委托

```typescript
function handleMarkdownClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  const link = target.closest('[data-seconds]')
  if (!link) return
  e.preventDefault()
  const seconds = Number((link as HTMLElement).dataset.seconds)
  if (!isNaN(seconds)) seekTo(seconds)
}
```

`.markdown-body` div 改为：
```html
<div class="markdown-body" v-html="renderMarkdown(msg.content, msg.streaming)"
     @click="handleMarkdownClick" />
```

### 3. 时间戳链接样式

在现有 `.markdown-body` 样式块中添加：
```css
.markdown-body .ts-link {
  color: #3b82f6;       /* blue-500 */
  font-family: monospace;
  font-size: 0.8em;
  background: #eff6ff;  /* blue-50 */
  padding: 1px 4px;
  border-radius: 3px;
  cursor: pointer;
  text-decoration: none;
  white-space: nowrap;
}
.markdown-body .ts-link:hover {
  background: #dbeafe;  /* blue-100 */
  text-decoration: underline;
}
```

### 4. 启用文本选中

**位置**：聊天消息内容区域

- 保留根元素的 `select-none`（不影响拖拽等全局行为）
- 在 AI 和用户消息气泡内容区加 `select-text` Tailwind 类：
  - 用户消息 `<p>` 元素：加 `select-text`
  - AI 消息 `.markdown-body` div：加 `select-text`

---

## 改动范围

| 位置 | 改动类型 | 说明 |
|------|----------|------|
| `renderMarkdown` 函数 | 修改 | 后处理 HTML，替换时间戳为链接 |
| `handleMarkdownClick` 函数 | 新增 | 事件委托处理时间戳点击 |
| `.markdown-body` div | 修改 | 加 `@click` 和 `select-text` |
| 用户消息 `<p>` | 修改 | 加 `select-text` |
| `<style>` 块 | 修改 | 添加 `.ts-link` 样式 |

**涉及文件**：仅 `src/renderer/src/App.vue`

---

## 不需要改动的部分

- `seekTo()` 函数（直接复用）
- marked 配置
- IPC / 主进程代码
