export type Frame = { t: number; blob: Blob }

// 시간순으로 쌓이는 JPEG 프레임 버퍼. 오래된 프레임은 prune으로 버린다.
export class FrameBuffer {
  frames: Frame[] = []

  push(frame: Frame) {
    this.frames.push(frame)
  }

  prune(before: number) {
    let i = 0
    while (i < this.frames.length && this.frames[i].t < before) i++
    if (i > 0) this.frames.splice(0, i)
  }

  clear() {
    this.frames = []
  }

  get first(): Frame | undefined {
    return this.frames[0]
  }

  get last(): Frame | undefined {
    return this.frames[this.frames.length - 1]
  }

  // t 이전(같거나 작은) 프레임 중 가장 최근 것
  at(t: number): Frame | undefined {
    return frameAt(this.frames, t)
  }
}

export function frameAt(frames: Frame[], t: number): Frame | undefined {
  let lo = 0
  let hi = frames.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (frames[mid].t <= t) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found >= 0 ? frames[found] : undefined
}
