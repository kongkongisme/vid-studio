# Chat Timestamp Seek + Text Selection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 AI 对话消息中的时间戳（`[MM:SS]`/`[HH:MM:SS]`）可点击跳转，同时允许对话内容被选中复制。

**Architecture:** 在 `renderMarkdown` 函数中后处理 HTML，将时间戳正则替换为带 `data-seconds` 属性的 `<a>` 标签；通过事件委托在 `.markdown-body` 父 div 上捕获点击后调用已有的 `seekTo()`；用 Tailwind `select-text` 覆盖根元素的 `select-none`。

**Tech Stack:** Vue 3, TypeScript, Tailwind CSS, marked (已有)

---

### Task 1：在 `renderMarkdown` 中后处理时间戳

**Files:**
- Modify: `src/renderer/src/App.vue:435-447`

**Step 1：在 `renderMarkdown` 函数中插入时间戳替换逻辑**

找到第 435-447 行的 `renderMarkdown` 函数，将其替换为：

```typescript
function renderMarkdown(content: string, streaming = false): string {
  if (!content) return ''
  let html = (marked.parse(content) as string).trim()

  // 将 [MM:SS] 或 [HH:MM:SS] 替换为可点击的时间戳链接
  html = html.replace(/\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/g, (match, p1, p2, p3) => {
    const hours = p3 !== undefined ? Number(p1) : 0
    const minutes = p3 !== undefined ? Number(p2) : Number(p1)
    const seconds = p3 !== undefined ? Number(p3) : Number(p2)
    const total = hours * 3600 + minutes * 60 + seconds
    return `<a class="ts-link" data-seconds="${total}" href="#">${match}</a>`
  })

  if (streaming) {
    // 在最后一个 </p> 前插入光标，使其显示在段落文字末尾
    const lastP = html.lastIndexOf('</p>')
    const cursor = '<span class="md-cursor">▌</span>'
    html = lastP !== -1
      ? html.slice(0, lastP) + cursor + html.slice(lastP)
      : html + cursor
  }
  return html
}
```

**Step 2：验证改动区域**

阅读 App.vue 第 433-447 行，确认函数已正确替换，没有多余内容。

---

### Task 2：添加 `handleMarkdownClick` 事件委托函数

**Files:**
- Modify: `src/renderer/src/App.vue`（在 `renderMarkdown` 函数下方，第 448 行后）

**Step 1：在 `renderMarkdown` 函数后立即插入新函数**

在第 447 行（`renderMarkdown` 的结束括号）后，紧接着插入：

```typescript
// 处理 markdown 区域的点击（事件委托：时间戳跳转）
function handleMarkdownClick(e: MouseEvent): void {
  const target = e.target as HTMLElement
  const link = target.closest('[data-seconds]') as HTMLElement | null
  if (!link) return
  e.preventDefault()
  const seconds = Number(link.dataset.seconds)
  if (!isNaN(seconds)) seekTo(seconds)
}
```

**Step 2：验证**

读取 App.vue 第 447-460 行，确认函数已插入，且没有破坏周边代码。

---

### Task 3：在模板中绑定事件与启用文本选中

**Files:**
- Modify: `src/renderer/src/App.vue:1562-1566`（`.markdown-body` div）
- Modify: `src/renderer/src/App.vue:1548`（用户消息 `<p>`）

**Step 1：修改 `.markdown-body` div**

将第 1562-1566 行：
```html
                  <div
                    v-else
                    class="markdown-body"
                    v-html="renderMarkdown(msg.content, msg.streaming)"
                  />
```
替换为：
```html
                  <div
                    v-else
                    class="markdown-body select-text"
                    v-html="renderMarkdown(msg.content, msg.streaming)"
                    @click="handleMarkdownClick"
                  />
```

**Step 2：修改用户消息 `<p>`**

将第 1548 行：
```html
                  <p class="whitespace-pre-wrap">{{ msg.content }}</p>
```
替换为：
```html
                  <p class="whitespace-pre-wrap select-text">{{ msg.content }}</p>
```

**Step 3：验证模板**

读取 App.vue 第 1544-1570 行，确认两处改动正确，没有破坏缩进或结构。

---

### Task 4：添加 `.ts-link` 样式

**Files:**
- Modify: `src/renderer/src/App.vue:1703`（`.markdown-body a` 行后）

**Step 1：在第 1703 行（`.markdown-body a { ... }`）后插入时间戳链接样式**

在这一行：
```css
.markdown-body a { color: #3b82f6; text-decoration: underline; }
```
后面插入：
```css
.markdown-body .ts-link {
  display: inline-block;
  color: #3b82f6;
  font-family: ui-monospace, monospace;
  font-size: 0.8em;
  background: #eff6ff;
  padding: 1px 5px;
  border-radius: 3px;
  cursor: pointer;
  text-decoration: none;
  white-space: nowrap;
  vertical-align: baseline;
}
.markdown-body .ts-link:hover {
  background: #dbeafe;
  text-decoration: underline;
}
```

**Step 2：验证样式区域**

读取 App.vue 第 1700-1720 行，确认样式已正确插入，没有破坏 CSS 语法。

---

### Task 5：提交

**Step 1：运行类型检查**
```bash
npm run typecheck
```
预期：无错误输出。

**Step 2：提交**
```bash
git add src/renderer/src/App.vue docs/plans/2026-03-02-chat-timestamp-seek-and-text-selection.md
git commit -m "feat: AI 对话时间戳可点击跳转 + 启用文本选中复制"
```
