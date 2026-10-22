interface ActiveRequest {
  id: string
  controller: AbortController
  timer: ReturnType<typeof setTimeout>
}

/** Each renderer owns its request; stale cancel/finish calls cannot affect newer work. */
export class ChatRequests {
  private active = new Map<number, ActiveRequest>()

  begin(
    owner: number,
    id: string,
    timeoutMs = 180000
  ): { signal: AbortSignal; finish: () => void } {
    this.cancel(owner)
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new DOMException('回答超时，请重试。', 'TimeoutError')),
      timeoutMs
    )
    timer.unref()
    const entry = { id, controller, timer }
    this.active.set(owner, entry)
    return {
      signal: controller.signal,
      finish: () => {
        clearTimeout(timer)
        if (this.active.get(owner) === entry) this.active.delete(owner)
      }
    }
  }

  cancel(owner: number, id?: string): void {
    const entry = this.active.get(owner)
    if (entry && (!id || id === entry.id)) {
      clearTimeout(entry.timer)
      entry.controller.abort(new DOMException('已停止生成', 'AbortError'))
      this.active.delete(owner)
    }
  }
}
