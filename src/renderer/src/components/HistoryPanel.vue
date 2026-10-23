<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted } from 'vue'
import {
  IconSearch,
  IconX,
  IconLoader2,
  IconStar,
  IconPencil,
  IconTrash,
  IconFileText,
  IconVideo,
  IconBrandBilibili,
  IconBrandYoutube
} from '@tabler/icons-vue'
import type { HistoryItem } from '../../../shared/history'
import type { LibraryEntry, LibraryMatch, LibraryResult } from '../../../shared/library'
import { formatTimecode } from '../../../shared/timeline'
import { MAX_LIBRARY_EXPORT_SOURCES } from '../../../shared/library-export'

const api = window.api
const props = defineProps<{ open: boolean; busy: boolean; openError: string }>()
const emit = defineEmits<{ close: []; select: [item: HistoryItem, match?: LibraryMatch] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
const renameInput = ref<HTMLInputElement[] | null>(null)
const query = ref('')
const favoritesOnly = ref(false)
const loading = ref(false)
const mutating = ref(false)
const error = ref('')
const result = ref<LibraryResult>({ entries: [], total: 0, totalSources: 0, unavailableSources: 0 })
const editingId = ref('')
const titleDraft = ref('')
const removingId = ref('')
const selecting = ref(false)
const selectedIds = ref<string[]>([])
const exportFormat = ref<'markdown' | 'json'>('markdown')
const includeTranscript = ref(true)
const includeAnnotations = ref(true)
const exporting = ref(false)
const exportMessage = ref('')
const selectable = computed(() => result.value.entries.filter((entry) => entry.cached))
const bulkSelectable = computed(() => selectable.value.slice(0, MAX_LIBRARY_EXPORT_SOURCES))
const allSelected = computed(
  () =>
    bulkSelectable.value.length > 0 &&
    bulkSelectable.value.every((entry) => selectedIds.value.includes(entry.item.id))
)
let request = 0
let debounce: ReturnType<typeof setTimeout> | undefined
const labels: Record<LibraryMatch['kind'], string> = {
  title: '章节',
  summary: '要点',
  transcript: '原文',
  note: '我的笔记',
  tags: '标签',
  'legacy-note': '旧版本笔记'
}

async function search(append = false): Promise<void> {
  const current = ++request
  loading.value = true
  error.value = ''
  try {
    const response = await window.api.searchLibrary({
      query: query.value,
      favoritesOnly: favoritesOnly.value,
      offset: append ? result.value.entries.length : 0
    })
    if (current !== request || !props.open) return
    result.value = append
      ? { ...response, entries: [...result.value.entries, ...response.entries] }
      : response
    if (!append)
      selectedIds.value = selectedIds.value.filter((id) =>
        response.entries.some((entry) => entry.item.id === id && entry.cached)
      )
  } catch (reason) {
    if (current === request) error.value = String(reason)
  } finally {
    if (current === request) loading.value = false
  }
}

watch(
  () => props.open,
  async (open) => {
    clearTimeout(debounce)
    request++
    editingId.value = ''
    removingId.value = ''
    selecting.value = false
    selectedIds.value = []
    exportMessage.value = ''
    await nextTick()
    if (open) {
      dialog.value?.showModal()
      searchInput.value?.focus()
      void search()
    } else dialog.value?.close()
  }
)
watch([query, favoritesOnly], () => {
  selectedIds.value = []
  exportMessage.value = ''
  clearTimeout(debounce)
  request++
  if (!props.open) return
  loading.value = true
  debounce = setTimeout(() => {
    void search()
  }, 250)
})
onUnmounted(() => {
  clearTimeout(debounce)
  request++
})

function close(): void {
  if (!props.busy && !mutating.value && !exporting.value) dialog.value?.close()
}

function toggleSelection(id: string, checked: boolean): void {
  if (checked && selectedIds.value.length >= MAX_LIBRARY_EXPORT_SOURCES) {
    error.value = `每次最多选择 ${MAX_LIBRARY_EXPORT_SOURCES} 份资料，请分批导出`
    return
  }
  selectedIds.value = checked
    ? [...selectedIds.value, id]
    : selectedIds.value.filter((value) => value !== id)
  exportMessage.value = ''
}

function toggleAll(): void {
  selectedIds.value = allSelected.value ? [] : bulkSelectable.value.map((entry) => entry.item.id)
  exportMessage.value = ''
}

function toggleSelecting(): void {
  selecting.value = !selecting.value
  selectedIds.value = []
  exportMessage.value = ''
  editingId.value = ''
  removingId.value = ''
}

async function exportSelected(): Promise<void> {
  if (!selectedIds.value.length || exporting.value || loading.value) return
  exporting.value = true
  error.value = ''
  exportMessage.value = ''
  try {
    const response = await api.exportLibrary({
      ids: [...selectedIds.value],
      format: exportFormat.value,
      includeTranscript: includeTranscript.value,
      includeAnnotations: includeAnnotations.value
    })
    if (response.success) exportMessage.value = `已导出 ${response.count} 份资料：${response.path}`
    else if (!response.canceled) error.value = response.error || '批量导出失败，请重试'
  } catch (reason) {
    error.value = String(reason)
  } finally {
    exporting.value = false
  }
}

function beginRemove(id: string): void {
  removingId.value = id
  editingId.value = ''
}

async function edit(item: HistoryItem): Promise<void> {
  removingId.value = ''
  editingId.value = item.id
  titleDraft.value = item.title
  await nextTick()
  renameInput.value?.[0]?.focus()
  renameInput.value?.[0]?.select()
}

async function mutate(action: () => Promise<void>): Promise<void> {
  if (mutating.value) return
  mutating.value = true
  error.value = ''
  try {
    await action()
    editingId.value = ''
    removingId.value = ''
    await search()
  } catch (reason) {
    error.value = String(reason)
  } finally {
    mutating.value = false
  }
}

function parts(text: string): string[] {
  const needle = query.value.trim()
  const index = text.toLowerCase().indexOf(needle.toLowerCase())
  return needle && index >= 0
    ? [
        text.slice(0, index),
        text.slice(index, index + needle.length),
        text.slice(index + needle.length)
      ]
    : [text, '', '']
}

function select(entry: LibraryEntry, match?: LibraryMatch): void {
  if (!props.busy && !loading.value && !mutating.value) {
    emit('select', entry.item, match ?? (query.value.trim() ? entry.matches[0] : undefined))
  }
}
</script>

<template>
  <dialog
    ref="dialog"
    class="library-dialog w-[720px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-48px)] overflow-hidden rounded-2xl border border-slate-200 p-0 text-slate-800 shadow-xl"
    aria-labelledby="library-title"
    @close="emit('close')"
    @cancel="(busy || mutating || exporting) && $event.preventDefault()"
    @keydown.esc.prevent.stop="close"
    @click="$event.target === dialog && close()"
  >
    <div class="flex max-h-[calc(100vh-48px)] flex-col">
      <header class="shrink-0 border-b border-slate-200 px-6 pt-5 pb-4">
        <div class="flex items-center justify-between gap-4">
          <h2 id="library-title" class="text-lg font-semibold">资料库</h2>
          <button
            aria-label="关闭资料库"
            class="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"
            :disabled="busy || mutating || exporting"
            @click="close"
          >
            <IconX class="h-5 w-5" />
          </button>
        </div>
        <label for="library-search" class="mt-3 block text-sm text-slate-500"
          >搜索标题、章节、原文和我的笔记</label
        >
        <div class="relative mt-2">
          <IconSearch class="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" />
          <input
            id="library-search"
            ref="searchInput"
            v-model="query"
            :disabled="exporting"
            type="search"
            maxlength="200"
            placeholder="输入学过的概念…"
            class="w-full rounded-lg border border-slate-200 bg-slate-50 py-2.5 pr-9 pl-9 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
          />
          <IconLoader2
            v-if="loading"
            class="absolute right-3 top-3 h-4 w-4 animate-spin text-blue-500"
          />
        </div>
        <div class="mt-3 flex items-center justify-between gap-3 text-xs text-slate-500">
          <label class="flex items-center gap-2 text-sm"
            ><input
              v-model="favoritesOnly"
              :disabled="exporting"
              type="checkbox"
              class="accent-blue-500"
            />仅看收藏资料</label
          >
          <button
            class="rounded px-2 py-1 text-sm text-blue-600 hover:bg-blue-50 disabled:opacity-50"
            :disabled="busy || mutating || exporting"
            :aria-pressed="selecting"
            @click="toggleSelecting"
          >
            {{ selecting ? '退出多选' : '批量导出' }}
          </button>
        </div>
      </header>
      <section
        v-if="selecting"
        aria-label="批量导出选项"
        class="shrink-0 space-y-3 border-b border-slate-200 bg-slate-50 px-6 py-3 text-sm"
      >
        <div class="flex flex-wrap items-center justify-between gap-3">
          <label class="flex items-center gap-2">
            <input
              type="checkbox"
              class="accent-blue-500"
              :checked="allSelected"
              :indeterminate="selectedIds.length > 0 && !allSelected"
              :disabled="loading || busy || exporting || !selectable.length"
              @change="toggleAll"
            />
            {{
              selectable.length > MAX_LIBRARY_EXPORT_SOURCES
                ? `选择前 ${MAX_LIBRARY_EXPORT_SOURCES} 份已显示资料`
                : '选择已显示资料'
            }}
          </label>
          <span class="text-xs text-slate-500"
            >已选 {{ selectedIds.length }} / 最多 {{ MAX_LIBRARY_EXPORT_SOURCES }} 份</span
          >
        </div>
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
          <label class="flex items-center gap-2"
            >导出格式
            <select
              v-model="exportFormat"
              :disabled="exporting"
              class="rounded border border-slate-200 bg-white px-2 py-1"
            >
              <option value="markdown">Markdown 笔记</option>
              <option value="json">JSON 时间轴</option>
            </select>
          </label>
          <label class="flex items-center gap-2"
            ><input
              v-model="includeTranscript"
              :disabled="exporting"
              type="checkbox"
              class="accent-blue-500"
            />附带原文</label
          >
          <label class="flex items-center gap-2"
            ><input
              v-model="includeAnnotations"
              :disabled="exporting"
              type="checkbox"
              class="accent-blue-500"
            />附带个人笔记与收藏</label
          >
        </div>
        <p class="text-xs leading-5 text-slate-500">
          每份资料生成一个文件，附资料目录；导出完整章节，不受搜索关键词裁剪。切换搜索会清空选择。缺少缓存的资料不可选。
        </p>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-xs text-slate-500">不含视频、聊天记录和设置。</p>
          <button
            class="rounded-lg bg-blue-600 px-3 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
            :disabled="!selectedIds.length || loading || busy || exporting"
            @click="exportSelected"
          >
            {{ exporting ? '正在导出…' : `导出所选（${selectedIds.length}）` }}
          </button>
        </div>
      </section>
      <p
        v-if="exportMessage"
        role="status"
        class="mx-6 mt-3 break-all rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
      >
        {{ exportMessage }}
      </p>
      <div
        v-if="error || openError"
        role="alert"
        class="mx-6 mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700"
      >
        {{ error || openError }}
        <button v-if="error" class="ml-2 underline" :disabled="loading" @click="search()">
          重试
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-3 py-2" :aria-busy="loading || busy">
        <p
          v-if="!result.entries.length && !loading && !error"
          class="px-3 py-12 text-center text-sm leading-7 text-slate-500"
        >
          {{
            !result.totalSources
              ? '解析视频或导入字幕后，资料会自动保存在这里。'
              : query.trim()
                ? '没有找到匹配内容，试试更短的关键词。'
                : '还没有收藏资料，点击资料旁的星标即可收藏。'
          }}
        </p>
        <article
          v-for="entry in result.entries"
          :key="entry.item.id"
          class="border-b border-slate-100 px-3 py-4 last:border-0"
        >
          <div class="flex items-start gap-3">
            <input
              v-if="selecting"
              type="checkbox"
              :aria-label="`选择资料：${entry.item.title}`"
              :checked="selectedIds.includes(entry.item.id)"
              :disabled="
                !entry.cached ||
                loading ||
                busy ||
                exporting ||
                (!selectedIds.includes(entry.item.id) &&
                  selectedIds.length >= MAX_LIBRARY_EXPORT_SOURCES)
              "
              class="mt-1.5 h-4 w-4 shrink-0 accent-blue-500"
              @change="toggleSelection(entry.item.id, ($event.target as HTMLInputElement).checked)"
            />
            <component
              :is="
                entry.item.platform === 'document'
                  ? IconFileText
                  : entry.item.platform === 'local'
                    ? IconVideo
                    : entry.item.platform === 'youtube'
                      ? IconBrandYoutube
                      : IconBrandBilibili
              "
              class="mt-1 h-5 w-5 shrink-0 text-slate-400"
            />
            <div class="min-w-0 flex-1">
              <form
                v-if="editingId === entry.item.id"
                class="flex flex-wrap items-center gap-2"
                @submit.prevent="mutate(() => api.renameHistory(entry.item.id, titleDraft))"
              >
                <input
                  ref="renameInput"
                  v-model="titleDraft"
                  aria-label="资料标题"
                  maxlength="200"
                  class="min-w-0 flex-1 rounded border border-blue-300 px-2 py-1 text-sm"
                />
                <button
                  type="submit"
                  class="text-sm text-blue-600"
                  :disabled="mutating || !titleDraft.trim()"
                >
                  保存
                </button>
                <button
                  type="button"
                  class="text-sm text-slate-500"
                  :disabled="mutating"
                  @click="editingId = ''"
                >
                  取消
                </button>
              </form>
              <button
                v-else
                class="block max-w-full text-left text-sm font-medium leading-6 hover:text-blue-600 disabled:opacity-60"
                :disabled="busy || loading || mutating || selecting || exporting"
                @click="select(entry)"
              >
                <span class="break-words"
                  >{{ parts(entry.item.title)[0]
                  }}<mark class="bg-amber-100 text-inherit">{{ parts(entry.item.title)[1] }}</mark
                  >{{ parts(entry.item.title)[2] }}</span
                >
              </button>
              <p class="mt-1 text-xs text-slate-400">
                {{ new Date(entry.item.createdAt).toLocaleDateString('zh-CN') }} ·
                {{
                  entry.item.mode === 'imported'
                    ? '导入资料'
                    : entry.item.mode === 'asr'
                      ? '语音解析'
                      : '视觉解析'
                }}
                · {{ entry.cached ? '已保存' : '缺少解析缓存' }}
              </p>
            </div>
            <div v-if="!selecting" class="flex shrink-0 gap-0.5">
              <button
                :aria-label="`${entry.item.favorited ? '取消收藏' : '收藏资料'}：${entry.item.title}`"
                :aria-pressed="entry.item.favorited"
                class="rounded-md p-1.5 hover:bg-slate-100"
                :disabled="mutating || busy"
                @click="mutate(() => api.toggleFavorite(entry.item.id))"
              >
                <IconStar
                  class="h-4 w-4"
                  :class="entry.item.favorited ? 'fill-amber-400 text-amber-400' : 'text-slate-400'"
                />
              </button>
              <button
                :aria-label="`重命名：${entry.item.title}`"
                class="rounded-md p-1.5 text-slate-400 hover:bg-slate-100"
                :disabled="mutating || busy"
                @click="edit(entry.item)"
              >
                <IconPencil class="h-4 w-4" />
              </button>
              <button
                :aria-label="`移除记录：${entry.item.title}`"
                class="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500"
                :disabled="mutating || busy"
                @click="beginRemove(entry.item.id)"
              >
                <IconTrash class="h-4 w-4" />
              </button>
            </div>
          </div>
          <div
            v-if="removingId === entry.item.id"
            class="mt-3 rounded-lg bg-slate-50 px-3 py-3 text-sm"
          >
            <p>从资料库移除这条记录？解析缓存和个人笔记仍保留在本机。</p>
            <div class="mt-2 flex justify-end gap-4">
              <button :disabled="mutating" class="text-slate-500" @click="removingId = ''">
                取消
              </button>
              <button
                :disabled="mutating"
                class="text-red-600"
                @click="mutate(() => api.deleteHistory(entry.item.id))"
              >
                移除记录
              </button>
            </div>
          </div>
          <div
            v-if="entry.matches.length"
            class="mt-3 ml-8 space-y-2 border-l-2 border-slate-100 pl-3"
          >
            <button
              v-for="match in entry.matches"
              :key="`${match.kind}:${match.chunkId}`"
              class="block w-full rounded-lg px-2 py-1.5 text-left hover:bg-blue-50 disabled:opacity-60"
              :disabled="busy || loading || mutating || selecting || exporting"
              @click="select(entry, match)"
            >
              <p class="text-xs text-slate-500">
                <span class="font-mono text-blue-600">{{
                  formatTimecode(match.startSeconds)
                }}</span>
                · {{ labels[match.kind] }} · {{ match.title }}
              </p>
              <p class="mt-1 break-words text-sm leading-6 text-slate-600">
                {{ parts(match.excerpt)[0]
                }}<mark class="bg-amber-100 text-inherit">{{ parts(match.excerpt)[1] }}</mark
                >{{ parts(match.excerpt)[2] }}
              </p>
            </button>
            <p v-if="entry.moreMatches" class="px-2 text-xs text-slate-400">
              还有其他命中，打开资料后可继续搜索。
            </p>
          </div>
        </article>
        <button
          v-if="result.entries.length < result.total"
          class="my-3 w-full rounded-lg py-2 text-sm text-blue-600 hover:bg-blue-50 disabled:opacity-50"
          :disabled="loading || busy || exporting"
          @click="search(true)"
        >
          加载更多（已显示 {{ result.entries.length }} / {{ result.total }}）
        </button>
      </div>
      <footer
        class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-6 py-3 text-xs text-slate-500"
        aria-live="polite"
      >
        <span>{{
          busy
            ? '正在打开资料…'
            : loading
              ? '正在搜索…'
              : `找到 ${result.total} 份资料 / 共 ${result.totalSources} 份`
        }}</span>
        <span v-if="result.unavailableSources"
          >{{ result.unavailableSources }} 份资料缺少可检索正文</span
        >
        <button
          class="rounded px-2 py-1 hover:bg-slate-100"
          :disabled="busy || mutating || exporting"
          @click="close"
        >
          关闭 · Esc
        </button>
      </footer>
    </div>
  </dialog>
</template>

<style scoped>
.library-dialog {
  margin: auto;
}
.library-dialog::backdrop {
  background: rgb(15 23 42 / 35%);
}
</style>
