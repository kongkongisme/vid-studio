<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { IconX, IconLoader2, IconCheck, IconAlertCircle, IconFolderOpen } from '@tabler/icons-vue'
import {
  DEFAULT_PREFERENCES,
  DEFAULT_MODELS,
  SECRET_KEYS,
  MODEL_KEYS,
  diagnosticText,
  type Preferences,
  type SettingsSnapshot,
  type SettingsUpdate,
  type DiagnosticReport,
  type SecretKey,
  type ModelKey
} from '../../../shared/settings'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; saved: [settings: SettingsSnapshot] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const tab = ref<'models' | 'environment' | 'preferences'>('models')
const tabs = [
  { id: 'models', label: '模型与服务' },
  { id: 'environment', label: '环境诊断' },
  { id: 'preferences', label: '使用偏好' }
] as const
const snapshot = ref<SettingsSnapshot | null>(null)
const preferences = ref<Preferences>({ ...DEFAULT_PREFERENCES })
const models = ref<Record<ModelKey, string>>({ ...DEFAULT_MODELS })
const secrets = ref<Partial<Record<SecretKey, string>>>({})
const clearing = ref(new Set<SecretKey>())
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const notice = ref('')
const diagnosing = ref(false)
const report = ref<DiagnosticReport | null>(null)
let generation = 0
let diagnosticGeneration = 0
const services: Array<{ key: SecretKey; title: string; description: string }> = [
  {
    key: 'DEEPSEEK_API_KEY',
    title: 'DeepSeek',
    description: '用于视频解析、资料问答和 PDF 标题。'
  },
  {
    key: 'GPT_API_KEY',
    title: '自定义兼容接口',
    description: '使用你自己的兼容服务，模型名称需要与服务商保持一致。'
  },
  {
    key: 'SILICONFLOW_API_KEY',
    title: 'SiliconFlow',
    description: '用于语音识别和语义分块；仅阅读已有字幕时不需要。'
  },
  {
    key: 'ZHIPUAI_API_KEY',
    title: '智谱 · 可选',
    description: '用于视觉精析，不影响字幕和语音模式。'
  },
  {
    key: 'TAVILY_API_KEY',
    title: 'Tavily · 可选',
    description: '允许问答助手检索互联网，可在使用偏好中关闭。'
  }
]

function apply(settings: SettingsSnapshot): void {
  snapshot.value = settings
  preferences.value = { ...settings.preferences }
  models.value = { ...settings.models }
  secrets.value = {}
  clearing.value = new Set()
}

async function load(): Promise<void> {
  const ticket = ++generation
  loading.value = true
  snapshot.value = null
  error.value = ''
  try {
    const settings = await window.api.getSettings()
    if (ticket === generation && props.open) apply(settings)
  } catch (reason) {
    if (ticket === generation) error.value = String(reason)
  } finally {
    if (ticket === generation) loading.value = false
  }
}

watch(
  () => props.open,
  async (open) => {
    generation++
    diagnosticGeneration++
    secrets.value = {}
    clearing.value = new Set()
    notice.value = ''
    report.value = null
    diagnosing.value = false
    await nextTick()
    if (open) {
      dialog.value?.showModal()
      await load()
    } else dialog.value?.close()
  }
)

function close(): void {
  if (!saving.value) {
    secrets.value = {}
    dialog.value?.close()
  }
}
function switchTab(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const index = tabs.findIndex((item) => item.id === tab.value)
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  tab.value = tabs[next].id
  void nextTick(() => document.getElementById(`settings-tab-${tab.value}`)?.focus())
}
function toggleClear(key: SecretKey): void {
  secrets.value[key] = ''
  if (clearing.value.has(key)) clearing.value.delete(key)
  else clearing.value.add(key)
}
async function save(): Promise<void> {
  if (!snapshot.value || saving.value) return
  saving.value = true
  error.value = ''
  notice.value = ''
  const update: SettingsUpdate = { preferences: { ...preferences.value }, models: {}, secrets: {} }
  for (const key of MODEL_KEYS)
    if (models.value[key] !== snapshot.value.models[key]) update.models![key] = models.value[key]
  for (const key of SECRET_KEYS) {
    if (clearing.value.has(key)) update.secrets![key] = null
    else if (secrets.value[key]?.trim()) update.secrets![key] = secrets.value[key]!.trim()
  }
  try {
    const saved = await window.api.saveSettings(update)
    diagnosticGeneration++
    report.value = null
    diagnosing.value = false
    apply(saved)
    emit('saved', saved)
    notice.value = '设置已保存，下次请求会使用新配置。'
  } catch (reason) {
    error.value = String(reason)
  } finally {
    saving.value = false
  }
}
async function choosePython(): Promise<void> {
  const ticket = generation
  try {
    const selected = await window.api.choosePython()
    if (ticket === generation && props.open && selected) preferences.value.pythonPath = selected
  } catch (reason) {
    if (ticket === generation) error.value = String(reason)
  }
}
async function diagnose(): Promise<void> {
  const ticket = ++diagnosticGeneration
  diagnosing.value = true
  error.value = ''
  try {
    const result = await window.api.diagnoseEnvironment()
    if (ticket === diagnosticGeneration && props.open) report.value = result
  } catch (reason) {
    if (ticket === diagnosticGeneration) error.value = String(reason)
  } finally {
    if (ticket === diagnosticGeneration) diagnosing.value = false
  }
}
async function copyReport(): Promise<void> {
  if (!report.value) return
  try {
    await navigator.clipboard.writeText(diagnosticText(report.value))
    notice.value = '诊断信息已复制，不含密钥、接口地址或本机文件路径。'
  } catch (reason) {
    error.value = `复制失败：${String(reason)}`
  }
}
async function openData(): Promise<void> {
  try {
    const reason = await window.api.openDataDirectory()
    if (reason) throw new Error(reason)
  } catch (reason) {
    error.value = String(reason)
  }
}
</script>

<template>
  <dialog
    ref="dialog"
    aria-labelledby="settings-title"
    class="settings-dialog w-[720px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-48px)] overflow-hidden rounded-2xl border border-slate-200 bg-white p-0 text-slate-800 shadow-xl"
    @close="emit('close')"
    @cancel="saving && $event.preventDefault()"
    @click="$event.target === dialog && close()"
  >
    <div class="flex max-h-[calc(100vh-48px)] flex-col">
      <header class="shrink-0 border-b border-slate-200 px-6 pt-5">
        <div class="flex items-center justify-between gap-4">
          <h2 id="settings-title" class="text-lg font-semibold">设置与诊断</h2>
          <button
            aria-label="关闭设置"
            class="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"
            :disabled="saving"
            @click="close"
          >
            <IconX class="h-5 w-5" />
          </button>
        </div>
        <div role="tablist" aria-label="设置分类" class="mt-4 flex gap-6" @keydown="switchTab">
          <button
            v-for="item in tabs"
            :id="`settings-tab-${item.id}`"
            :key="item.id"
            role="tab"
            :aria-controls="`settings-panel-${item.id}`"
            :aria-selected="tab === item.id"
            :tabindex="tab === item.id ? 0 : -1"
            class="border-b-2 pb-3 text-sm"
            :class="
              tab === item.id
                ? 'border-blue-500 font-medium text-blue-600'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            "
            @click="tab = item.id"
          >
            {{ item.label }}
          </button>
        </div>
      </header>
      <div class="min-h-[220px] flex-1 overflow-y-auto px-6 py-5">
        <div
          v-if="loading"
          role="status"
          class="flex items-center gap-2 py-12 text-sm text-slate-500"
        >
          <IconLoader2 class="h-4 w-4 animate-spin" />正在读取设置…
        </div>
        <fieldset v-else-if="snapshot" :disabled="saving" class="min-w-0">
          <section
            v-show="tab === 'models'"
            id="settings-panel-models"
            role="tabpanel"
            aria-labelledby="settings-tab-models"
          >
            <p class="text-sm leading-6 text-slate-500">
              至少配置一种模型即可问答。密钥留空会保留原配置；保存到本机的密钥使用系统密钥库加密。
            </p>
            <p
              v-if="!snapshot.encryptionAvailable"
              class="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800"
            >
              系统密钥库当前不可用，暂时不能通过界面保存新密钥。已有环境变量配置仍可使用。
            </p>
            <div
              v-for="service in services"
              :key="service.key"
              class="border-b border-slate-100 py-5 last:border-0"
            >
              <div class="flex items-center justify-between gap-3">
                <label :for="`key-${service.key}`" class="text-sm font-semibold"
                  >{{ service.title }} API Key</label
                >
                <span
                  class="text-xs"
                  :class="
                    snapshot.secrets[service.key].configured ? 'text-emerald-700' : 'text-slate-400'
                  "
                  >{{ snapshot.secrets[service.key].configured ? '已配置' : '未配置' }}</span
                >
              </div>
              <p class="mt-1 text-xs leading-5 text-slate-500">{{ service.description }}</p>
              <input
                :id="`key-${service.key}`"
                v-model="secrets[service.key]"
                type="password"
                autocomplete="off"
                spellcheck="false"
                maxlength="4096"
                :disabled="saving || clearing.has(service.key)"
                :placeholder="
                  snapshot.secrets[service.key].configured ? '已配置，留空保留' : '粘贴 API Key'
                "
                class="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
              />
              <div class="mt-1.5 flex items-center justify-between text-xs text-slate-500">
                <span>{{
                  snapshot.secrets[service.key].source === 'environment'
                    ? '当前使用环境变量，优先于本机设置。'
                    : snapshot.secrets[service.key].source === 'legacy'
                      ? '当前使用原有 .env 配置。'
                      : ''
                }}</span>
                <button
                  v-if="snapshot.secrets[service.key].stored"
                  class="text-slate-500 underline hover:text-red-600"
                  :disabled="saving"
                  @click="toggleClear(service.key)"
                >
                  {{ clearing.has(service.key) ? '保存后清除 · 撤销' : '移除已保存密钥' }}
                </button>
              </div>
              <details v-if="service.key === 'DEEPSEEK_API_KEY'" class="mt-3 text-sm">
                <summary class="cursor-pointer text-slate-500">模型与接口</summary>
                <label class="mt-3 block text-xs text-slate-500"
                  >模型名称<input
                    v-model="models.DEEPSEEK_MODEL"
                    class="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    placeholder="deepseek-chat"
                /></label>
                <label class="mt-3 block text-xs text-slate-500"
                  >接口地址<input
                    v-model="models.DEEPSEEK_BASE_URL"
                    class="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    placeholder="https://api.deepseek.com"
                /></label>
              </details>
              <div v-if="service.key === 'GPT_API_KEY'" class="mt-3 space-y-3">
                <label class="block text-xs text-slate-500"
                  >接口地址<input
                    v-model="models.GPT_BASE_URL"
                    class="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    placeholder="https://your-provider.com/v1"
                /></label>
                <label class="block text-xs text-slate-500"
                  >模型名称<input
                    v-model="models.GPT_MODEL"
                    class="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                /></label>
                <label class="block text-xs text-slate-500"
                  >推理强度<select
                    v-model="models.GPT_REASONING_EFFORT"
                    class="mt-1 block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
                  >
                    <option value="omit">不发送推理参数</option>
                    <option value="none">无（none，需接口支持）</option>
                    <option value="minimal">极低</option>
                    <option value="low">低</option>
                    <option value="medium">中</option>
                    <option value="high">高</option>
                    <option value="xhigh">极高</option>
                  </select></label
                >
                <p class="text-xs leading-5 text-slate-400">
                  接口需要支持当前选用的模型和推理参数。留空地址或模型会恢复环境配置或默认值。
                </p>
              </div>
            </div>
          </section>
          <section
            v-show="tab === 'preferences'"
            id="settings-panel-preferences"
            role="tabpanel"
            aria-labelledby="settings-tab-preferences"
            class="space-y-6"
          >
            <label class="flex items-start gap-3"
              ><input
                v-model="preferences.detectClipboard"
                type="checkbox"
                class="mt-1 accent-blue-500"
              /><span class="text-sm"
                >自动检测剪贴板中的视频链接<span class="mt-1 block text-xs leading-5 text-slate-500"
                  >开启后，应用处于前台时检查剪贴板；仍需手动确认开始解析。</span
                ></span
              ></label
            >
            <label class="flex items-start gap-3"
              ><input
                v-model="preferences.autoImportCookies"
                type="checkbox"
                class="mt-1 accent-blue-500"
              /><span class="text-sm"
                >启动时同步浏览器账号<span class="mt-1 block text-xs leading-5 text-slate-500"
                  >读取已登录浏览器的 B 站 / YouTube
                  Cookies，系统可能提示解锁密钥库。也可通过顶部账号按钮手动同步。</span
                ></span
              ></label
            >
            <label class="flex items-start gap-3"
              ><input
                v-model="preferences.allowWebSearch"
                type="checkbox"
                class="mt-1 accent-blue-500"
              /><span class="text-sm"
                >允许问答联网搜索<span class="mt-1 block text-xs leading-5 text-slate-500"
                  >需要 Tavily API Key；关闭后仅使用当前资料与模型已有知识。</span
                ></span
              ></label
            >
            <div class="border-t border-slate-100 pt-5">
              <label for="python-path" class="text-sm font-medium">Python 程序路径</label>
              <div class="mt-2 flex gap-2">
                <input
                  id="python-path"
                  v-model="preferences.pythonPath"
                  class="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  placeholder="留空自动检测虚拟环境与系统 Python"
                /><button
                  class="flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50"
                  @click="choosePython"
                >
                  <IconFolderOpen class="h-4 w-4" />选择
                </button>
              </div>
              <p class="mt-2 text-xs leading-5 text-slate-500">
                选择 Python 可执行文件，不包含命令参数。修改后先保存，再到环境诊断中检查。
              </p>
            </div>
            <button class="text-sm text-blue-600 hover:underline" @click="openData">
              打开本机数据目录
            </button>
          </section>
          <section
            v-show="tab === 'environment'"
            id="settings-panel-environment"
            role="tabpanel"
            aria-labelledby="settings-tab-environment"
          >
            <p class="text-sm leading-6 text-slate-500">
              检查已保存的配置、Python
              和媒体工具。不会联网或消耗模型额度；配置了密钥不代表服务已经连通。
            </p>
            <div class="my-4 flex items-center gap-3">
              <button
                class="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                :disabled="diagnosing || saving"
                @click="diagnose"
              >
                <IconLoader2 v-if="diagnosing" class="h-4 w-4 animate-spin" />{{
                  diagnosing ? '正在检查…' : '运行本地检查'
                }}</button
              ><button
                v-if="report"
                class="rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50"
                @click="copyReport"
              >
                复制诊断
              </button>
            </div>
            <div v-if="report" class="divide-y divide-slate-100">
              <div v-for="item in report.items" :key="item.id" class="flex gap-3 py-3">
                <IconCheck
                  v-if="item.status === 'ok'"
                  class="mt-0.5 h-4 w-4 shrink-0 text-emerald-600"
                /><IconAlertCircle
                  v-else
                  class="mt-0.5 h-4 w-4 shrink-0"
                  :class="item.status === 'error' ? 'text-red-500' : 'text-amber-500'"
                />
                <div class="min-w-0">
                  <h3 class="text-sm font-medium">{{ item.title }}</h3>
                  <p class="mt-1 text-sm leading-6 text-slate-600">{{ item.detail }}</p>
                  <p v-if="item.help" class="mt-1 text-xs leading-5 text-slate-500">
                    {{ item.help }}
                  </p>
                </div>
              </div>
            </div>
          </section>
        </fieldset>
      </div>
      <p
        v-if="error"
        role="alert"
        class="mx-6 mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700"
      >
        {{ error }} <button v-if="!snapshot" class="underline" @click="load">重新读取</button>
      </p>
      <p v-if="notice" role="status" class="mx-6 mb-3 text-xs text-emerald-700">{{ notice }}</p>
      <footer
        class="flex shrink-0 items-center justify-between gap-3 border-t border-slate-200 px-6 py-4"
      >
        <span class="text-xs text-slate-400">设置仅保存在此设备</span>
        <div class="flex gap-2">
          <button
            class="rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50"
            :disabled="saving"
            @click="close"
          >
            关闭</button
          ><button
            class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            :disabled="saving || loading || !snapshot"
            @click="save"
          >
            {{ saving ? '正在保存…' : '保存设置' }}
          </button>
        </div>
      </footer>
    </div>
  </dialog>
</template>
<style scoped>
.settings-dialog {
  margin: auto;
}
.settings-dialog::backdrop {
  background: rgb(15 23 42 / 35%);
}
</style>
