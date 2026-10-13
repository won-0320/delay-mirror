export type Frame = { t: number; blob: Blob }

// 시간순 프레임 목록에서 t 이전(같거나 작은) 프레임 중 가장 최근 것
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
