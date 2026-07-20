<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  IconAlertTriangle,
  IconLoader2,
  IconMaximize,
  IconPlayerPause,
  IconPlayerPlay,
  IconVolume,
  IconVolumeOff
} from '@tabler/icons-vue'

type PlaybackStatus = 'idle' | 'checking' | 'converting' | 'ready' | 'error'

const props = withDefaults(
  defineProps<{
    src: string
    title: string
    status?: PlaybackStatus
    progress?: number
    message?: string
  }>(),
  {
    status: 'idle',
    progress: 0,
    message: ''
  }
)

const emit = defineEmits<{
  playbackError: []
}>()

const videoRef = ref<HTMLVideoElement | null>(null)
const shellRef = ref<HTMLDivElement | null>(null)
const currentTime = ref(0)
const duration = ref(0)
const playing = ref(false)
const muted = ref(false)
const volume = ref(0.85)
const rate = ref(1)
const playerError = ref('')

const progressPercent = computed(() => {
  if (!duration.value) return 0
  return Math.min(100, Math.max(0, (currentTime.value / duration.value) * 100))
})

const statusVisible = computed(() => props.status === 'checking' || props.status === 'converting')
const blockedByStatus = computed(() => props.status === 'checking' || props.status === 'converting')
const errorText = computed(() => (props.status === 'error' ? props.message : playerError.value))

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '00:00'
  const rounded = Math.floor(seconds)
  const h = Math.floor(rounded / 3600)
  const m = Math.floor((rounded % 3600) / 60)
  const s = rounded % 60
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

async function togglePlay(): Promise<void> {
  const video = videoRef.value
  if (!video || blockedByStatus.value) return
  if (video.paused) {
    await video.play().catch(() => {})
  } else {
    video.pause()
  }
}

function syncTime(): void {
  const video = videoRef.value
  if (!video) return
  currentTime.value = video.currentTime
}

function syncMeta(): void {
  const video = videoRef.value
  if (!video) return
  duration.value = video.duration || 0
}

function seekFromRange(event: Event): void {
  const video = videoRef.value
  if (!video || !duration.value) return
  const input = event.target as HTMLInputElement
  video.currentTime = (Number(input.value) / 1000) * duration.value
  syncTime()
}

function toggleMute(): void {
  const video = videoRef.value
  if (!video) return
  video.muted = !video.muted
  muted.value = video.muted
}

function setVolume(event: Event): void {
  const video = videoRef.value
  if (!video) return
  const input = event.target as HTMLInputElement
  volume.value = Number(input.value)
  video.volume = volume.value
  video.muted = volume.value === 0
  muted.value = video.muted
}

function syncVolume(): void {
  const video = videoRef.value
  if (!video) return
  muted.value = video.muted
  volume.value = video.volume
}

function setRate(event: Event): void {
  const video = videoRef.value
  if (!video) return
  const select = event.target as HTMLSelectElement
  rate.value = Number(select.value)
  video.playbackRate = rate.value
}

async function toggleFullscreen(): Promise<void> {
  const shell = shellRef.value
  if (!shell) return
  if (document.fullscreenElement) {
    await document.exitFullscreen().catch(() => {})
  } else {
    await shell.requestFullscreen().catch(() => {})
  }
}

async function seekTo(seconds: number): Promise<void> {
  const video = videoRef.value
  if (!video) return
  video.currentTime = seconds
  await video.play().catch(() => {})
}

function handleVideoError(): void {
  if (props.status === 'converting') return
  playerError.value = '当前视频无法直接播放，正在等待可播放预览'
  emit('playbackError')
}

watch(
  () => props.src,
  () => {
    playerError.value = ''
    currentTime.value = 0
    duration.value = 0
    playing.value = false
  }
)

defineExpose({ seekTo })
</script>

<template>
  <div
    ref="shellRef"
    class="group relative h-full w-full overflow-hidden bg-black text-white"
    tabindex="0"
    @keydown.space.prevent="togglePlay"
  >
    <video
      ref="videoRef"
      :key="src"
      :src="src"
      class="h-full w-full bg-black object-contain"
      playsinline
      @click="togglePlay"
      @loadedmetadata="syncMeta"
      @durationchange="syncMeta"
      @timeupdate="syncTime"
      @play="playing = true"
      @pause="playing = false"
      @volumechange="syncVolume"
      @error="handleVideoError"
    />

    <div class="pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/70 to-transparent px-4 py-3">
      <p class="max-w-[70%] truncate text-sm font-medium text-white/90">{{ title }}</p>
    </div>

    <button
      v-if="!blockedByStatus && !errorText"
      class="absolute left-1/2 top-1/2 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white opacity-0 backdrop-blur transition-opacity hover:bg-black/65 group-hover:opacity-100"
      type="button"
      @click="togglePlay"
    >
      <IconPlayerPause v-if="playing" class="h-7 w-7" />
      <IconPlayerPlay v-else class="h-7 w-7 translate-x-0.5" />
    </button>

    <div
      v-if="statusVisible"
      class="absolute inset-0 flex flex-col items-center justify-center bg-black/82 px-8 text-center"
    >
      <IconLoader2 class="mb-4 h-8 w-8 animate-spin text-blue-300" />
      <p class="text-sm font-medium">{{ message || '正在准备播放预览' }}</p>
      <div class="mt-4 h-1.5 w-72 max-w-full overflow-hidden rounded-full bg-white/15">
        <div
          class="h-full rounded-full bg-blue-400 transition-all duration-300"
          :style="{ width: `${Math.max(0, Math.min(100, progress))}%` }"
        />
      </div>
      <p class="mt-2 font-mono text-xs text-white/50">{{ Math.round(progress) }}%</p>
    </div>

    <div
      v-else-if="errorText"
      class="absolute inset-0 flex flex-col items-center justify-center bg-black/82 px-8 text-center"
    >
      <IconAlertTriangle class="mb-3 h-8 w-8 text-amber-300" />
      <p class="max-w-sm text-sm font-medium leading-relaxed text-white/85">{{ errorText }}</p>
    </div>

    <div
      class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/55 to-transparent px-3 pb-3 pt-10"
    >
      <input
        class="player-range mb-2 w-full"
        type="range"
        min="0"
        max="1000"
        :value="duration ? (currentTime / duration) * 1000 : 0"
        :disabled="!duration || blockedByStatus"
        :style="{ '--progress': `${progressPercent}%` }"
        @input="seekFromRange"
      />

      <div class="flex items-center gap-2">
        <button
          class="flex h-8 w-8 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/12 hover:text-white disabled:text-white/30"
          type="button"
          :disabled="blockedByStatus"
          @click="togglePlay"
        >
          <IconPlayerPause v-if="playing" class="h-5 w-5" />
          <IconPlayerPlay v-else class="h-5 w-5 translate-x-0.5" />
        </button>

        <div class="min-w-[105px] font-mono text-[11px] text-white/70">
          {{ formatDuration(currentTime) }} / {{ formatDuration(duration) }}
        </div>

        <button
          class="flex h-8 w-8 items-center justify-center rounded-md text-white/75 transition-colors hover:bg-white/12 hover:text-white"
          type="button"
          @click="toggleMute"
        >
          <IconVolumeOff v-if="muted || volume === 0" class="h-[18px] w-[18px]" />
          <IconVolume v-else class="h-[18px] w-[18px]" />
        </button>

        <input
          class="player-volume w-20"
          type="range"
          min="0"
          max="1"
          step="0.01"
          :value="volume"
          @input="setVolume"
        />

        <select
          class="ml-auto h-8 rounded-md border border-white/10 bg-black/30 px-2 text-xs text-white/75 outline-none hover:bg-white/10"
          :value="rate"
          @change="setRate"
        >
          <option value="0.75">0.75x</option>
          <option value="1">1x</option>
          <option value="1.25">1.25x</option>
          <option value="1.5">1.5x</option>
          <option value="2">2x</option>
        </select>

        <button
          class="flex h-8 w-8 items-center justify-center rounded-md text-white/75 transition-colors hover:bg-white/12 hover:text-white"
          type="button"
          @click="toggleFullscreen"
        >
          <IconMaximize class="h-[18px] w-[18px]" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.player-range,
.player-volume {
  height: 4px;
  cursor: pointer;
  appearance: none;
  border-radius: 999px;
  background: linear-gradient(
    to right,
    #60a5fa 0%,
    #60a5fa var(--progress, 0%),
    rgba(255, 255, 255, 0.24) var(--progress, 0%),
    rgba(255, 255, 255, 0.24) 100%
  );
}

.player-volume {
  background: rgba(255, 255, 255, 0.24);
}

.player-range::-webkit-slider-thumb,
.player-volume::-webkit-slider-thumb {
  width: 12px;
  height: 12px;
  appearance: none;
  border-radius: 999px;
  background: #ffffff;
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.35);
}
</style>
