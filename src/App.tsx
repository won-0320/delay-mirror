import { useCallback, useEffect, useRef, useState } from 'react'
import { useCamera, type Facing } from './hooks/useCamera.ts'
import { FrameBuffer, frameAt, type Frame } from './lib/frameBuffer.ts'

const MIN_DELAY = 3
const MAX_DELAY = 20
const KEEP_EXTRA_MS = 10_000 // 지연 시간보다 이만큼 더 보관 → 다시보기에 사용
const MAX_RECORD_MS = 60_000 // 녹화 최대 길이 (태블릿 메모리 보호)
const CAPTURE_MS = 50 // 약 20fps
const CAPTURE_WIDTH = 960
const JPEG_QUALITY = 0.7
const SPEEDS = [0.25, 0.5, 1] as const
const SETTINGS_KEY = 'delay-mirror:settings'

type Mode = 'delay' | 'record'
type Settings = { mode: Mode; delay: number; facing: Facing; mirror: boolean }
const DEFAULT_SETTINGS: Settings = { mode: 'delay', delay: 8, facing: 'environment', mirror: false }

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    // 저장소를 못 쓰면 기본값
  }
  return DEFAULT_SETTINGS
}

function saveSettings(s: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
  } catch {
    // 무시
  }
}

type Replay = { frames: Frame[]; start: number; end: number }

const fullscreenSupported =
  typeof document !== 'undefined' &&
  !!(document.fullscreenEnabled || (document as { webkitFullscreenEnabled?: boolean }).webkitFullscreenEnabled)

function formatClock(ms: number) {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const { mode, delay, facing, mirror } = settings
  const { videoRef, ready, error } = useCamera(facing)

  const [replay, setReplay] = useState<Replay | null>(null)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState<number>(0.5)
  const [playheadView, setPlayheadView] = useState(0)
  const [waitLeft, setWaitLeft] = useState<number | null>(null)
  const [recStart, setRecStart] = useState<number | null>(null)
  const [recElapsed, setRecElapsed] = useState(0)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const bufferRef = useRef(new FrameBuffer())
  const recordRef = useRef<Frame[]>([])
  const recStartRef = useRef<number | null>(null)
  const playheadRef = useRef(0)
  const stopRecordingRef = useRef<() => void>(() => {})

  // 렌더 루프에서 최신 값을 읽기 위한 ref
  const live = useRef({ mode, delay, replay, playing, speed })
  live.current = { mode, delay, replay, playing, speed }
  recStartRef.current = recStart

  const update = (patch: Partial<Settings>) =>
    setSettings((s) => {
      const next = { ...s, ...patch }
      saveSettings(next)
      return next
    })

  const startRecording = useCallback(() => {
    recordRef.current = []
    setReplay(null)
    setRecElapsed(0)
    setRecStart(performance.now())
  }, [])

  const stopRecording = useCallback(() => {
    const frames = recordRef.current
    recordRef.current = []
    setRecStart(null)
    if (frames.length < 2) return
    const start = frames[0].t
    const end = frames[frames.length - 1].t
    playheadRef.current = start
    setPlayheadView(start)
    setPlaying(true)
    setReplay({ frames, start, end })
  }, [])
  stopRecordingRef.current = stopRecording

  // 카메라나 모드가 바뀌면 이전 영상과 진행 중인 녹화는 버린다
  useEffect(() => {
    bufferRef.current.clear()
    recordRef.current = []
    setRecStart(null)
    setReplay(null)
  }, [facing, mode])

  // ── 캡처: 카메라 프레임을 JPEG로 압축해 버퍼에 쌓기 ──
  useEffect(() => {
    if (!ready) return
    const video = videoRef.current
    if (!video) return
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let pending = 0

    const id = window.setInterval(() => {
      if (pending > 2 || video.readyState < 2 || !video.videoWidth) return
      // 녹화 모드에서는 녹화 중일 때만 캡처
      if (live.current.mode === 'record' && recStartRef.current === null) return
      const scale = Math.min(1, CAPTURE_WIDTH / video.videoWidth)
      const w = Math.round(video.videoWidth * scale)
      const h = Math.round(video.videoHeight * scale)
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      const t = performance.now()
      ctx.drawImage(video, 0, 0, w, h)
      pending++
      canvas.toBlob(
        (blob) => {
          pending--
          if (!blob) return
          if (live.current.mode === 'record') {
            const started = recStartRef.current
            if (started !== null && t >= started) recordRef.current.push({ t, blob })
            return
          }
          const buf = bufferRef.current
          buf.push({ t, blob })
          buf.prune(performance.now() - MAX_DELAY * 1000 - KEEP_EXTRA_MS)
        },
        'image/jpeg',
        JPEG_QUALITY,
      )
    }, CAPTURE_MS)

    return () => window.clearInterval(id)
  }, [ready, videoRef])

  // ── 화면 출력 루프 ──
  useEffect(() => {
    let raf = 0
    let prev = performance.now()
    let drawn: Frame | undefined
    let decoding = false
    let lastUiUpdate = 0
    let lastWait: number | null = null

    const draw = (frame: Frame) => {
      decoding = true
      createImageBitmap(frame.blob)
        .then((bmp) => {
          const canvas = canvasRef.current
          const ctx = canvas?.getContext('2d')
          if (canvas && ctx) {
            if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
              canvas.width = bmp.width
              canvas.height = bmp.height
            }
            ctx.drawImage(bmp, 0, 0)
          }
          bmp.close()
          drawn = frame
        })
        .catch(() => {})
        .finally(() => {
          decoding = false
        })
    }

    const tick = (now: number) => {
      const dt = now - prev
      prev = now
      const { mode, delay, replay, playing, speed } = live.current
      let frame: Frame | undefined
      let wait: number | null = null
      const uiDue = now - lastUiUpdate > 100
      if (uiDue) lastUiUpdate = now

      if (replay) {
        if (playing) {
          let p = playheadRef.current + dt * speed
          if (p > replay.end) p = replay.start
          playheadRef.current = p
        }
        frame = frameAt(replay.frames, playheadRef.current)
        if (uiDue) setPlayheadView(playheadRef.current)
      } else if (mode === 'record') {
        const started = recStartRef.current
        if (started !== null) {
          const elapsed = now - started
          if (elapsed >= MAX_RECORD_MS) stopRecordingRef.current()
          else if (uiDue) setRecElapsed(elapsed)
        }
      } else {
        const buf = bufferRef.current
        frame = buf.at(now - delay * 1000)
        const first = buf.first
        if (!frame) wait = first ? Math.ceil((first.t + delay * 1000 - now) / 1000) : delay
      }

      if (wait !== lastWait) {
        lastWait = wait
        setWaitLeft(wait)
      }
      if (frame && frame !== drawn && !decoding) draw(frame)
      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  // ── 화면 꺼짐 방지 ──
  useEffect(() => {
    let lock: WakeLockSentinel | null = null
    const request = () => {
      if (document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return
      navigator.wakeLock
        .request('screen')
        .then((l) => (lock = l))
        .catch(() => {})
    }
    request()
    document.addEventListener('visibilitychange', request)
    return () => {
      document.removeEventListener('visibilitychange', request)
      lock?.release().catch(() => {})
    }
  }, [])

  const startDelayReplay = useCallback(() => {
    const buf = bufferRef.current
    if (!buf.first || !buf.last) return
    const frames = buf.frames.slice()
    const start = frames[0].t
    const end = frames[frames.length - 1].t
    // 멈춘 순간 화면에 보이던 장면부터
    playheadRef.current = Math.max(start, performance.now() - delay * 1000)
    setPlayheadView(playheadRef.current)
    setPlaying(false)
    setReplay({ frames, start, end })
  }, [delay])

  const backToLive = useCallback(() => {
    setReplay(null)
    setPlaying(true)
  }, [])

  const recording = recStart !== null

  // 스페이스바 (PC에서 사용할 때)
  // 지연 화면: 멈춤/실시간 전환 · 녹화: 녹화 시작/멈춤
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.target instanceof HTMLInputElement) return
      e.preventDefault()
      if (mode === 'record') {
        if (recording) stopRecording()
        else if (ready) startRecording()
      } else if (replay) backToLive()
      else startDelayReplay()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, recording, ready, replay, startRecording, stopRecording, startDelayReplay, backToLive])

  const toggleFullscreen = () => {
    const doc = document as Document & { webkitExitFullscreen?: () => void; webkitFullscreenElement?: Element }
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void }
    if (document.fullscreenElement || doc.webkitFullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {})
      else doc.webkitExitFullscreen?.()
    } else if (el.requestFullscreen) {
      el.requestFullscreen().catch(() => {})
    } else {
      el.webkitRequestFullscreen?.()
    }
  }

  // 녹화 모드에서 다시보기가 아닐 때는 카메라 영상을 지연 없이 바로 보여준다
  const showLiveVideo = mode === 'record' && !replay
  const mirrorClass = mirror ? ' mirrored' : ''

  let badge
  if (replay && mode === 'record') {
    badge = (
      <span className="badge-replay">
        ▶ 녹화 다시보기 · {((playheadView - replay.start) / 1000).toFixed(1)} /{' '}
        {((replay.end - replay.start) / 1000).toFixed(1)}초
      </span>
    )
  } else if (replay) {
    badge = <span className="badge-replay">⏸ 다시보기 · {((replay.end - playheadView) / 1000).toFixed(1)}초 전</span>
  } else if (mode === 'record') {
    badge = recording ? (
      <span className="badge-rec">
        <span className="rec-dot" /> 녹화 중 {formatClock(recElapsed)}
      </span>
    ) : (
      <span>실시간 화면</span>
    )
  } else {
    badge = (
      <span>
        <b>{delay}</b>초 전 모습
      </span>
    )
  }

  const settingsRow = (
    <div className="row">
      <button
        className="btn"
        disabled={recording}
        onClick={() => update({ facing: facing === 'user' ? 'environment' : 'user' })}
      >
        🔄 {facing === 'user' ? '전면' : '후면'} 카메라
      </button>
      <button className={mirror ? 'btn on' : 'btn'} onClick={() => update({ mirror: !mirror })}>
        ↔ 좌우 반전
      </button>
      {fullscreenSupported && (
        <button className="btn" onClick={toggleFullscreen}>
          ⛶ 전체화면
        </button>
      )}
      <span className="note">영상은 이 기기 메모리에만 잠깐 머물며 저장·전송되지 않습니다</span>
    </div>
  )

  let controls
  if (replay) {
    controls = (
      <div className="controls">
        <input
          className="scrub"
          type="range"
          min={replay.start}
          max={replay.end}
          step={10}
          value={playheadView}
          onChange={(e) => {
            playheadRef.current = Number(e.target.value)
            setPlayheadView(playheadRef.current)
            setPlaying(false)
          }}
          aria-label="되감기 위치"
        />
        <div className="row">
          <button className="btn big" onClick={() => setPlaying((p) => !p)}>
            {playing ? '⏸ 일시정지' : '▶ 재생'}
          </button>
          <div className="seg">
            {SPEEDS.map((s) => (
              <button
                key={s}
                className={s === speed ? 'btn on' : 'btn'}
                onClick={() => {
                  setSpeed(s)
                  setPlaying(true)
                }}
              >
                {s === 1 ? '보통' : `${s}배`}
              </button>
            ))}
          </div>
          {mode === 'record' ? (
            <>
              <button className="btn rec big" onClick={startRecording} disabled={!ready}>
                ● 다시 녹화
              </button>
              <button className="btn big" onClick={backToLive}>
                카메라 화면
              </button>
            </>
          ) : (
            <button className="btn primary big" onClick={backToLive}>
              ● 실시간으로
            </button>
          )}
        </div>
      </div>
    )
  } else if (mode === 'record') {
    controls = (
      <div className="controls">
        <div className="row">
          {recording ? (
            <button className="btn rec big wide" onClick={stopRecording}>
              ■ 멈춤 ({formatClock(recElapsed)})
            </button>
          ) : (
            <button className="btn rec big wide" onClick={startRecording} disabled={!ready}>
              ● 녹화 시작
            </button>
          )}
          <span className="note">최대 {MAX_RECORD_MS / 1000}초까지 녹화되고, 멈추면 바로 다시보기가 나옵니다</span>
        </div>
        {settingsRow}
      </div>
    )
  } else {
    controls = (
      <div className="controls">
        <div className="row">
          <div className="delay">
            <button
              className="btn"
              onClick={() => update({ delay: Math.max(MIN_DELAY, delay - 1) })}
              aria-label="지연 시간 줄이기"
            >
              −
            </button>
            <input
              type="range"
              min={MIN_DELAY}
              max={MAX_DELAY}
              value={delay}
              onChange={(e) => update({ delay: Number(e.target.value) })}
              aria-label="지연 시간"
            />
            <button
              className="btn"
              onClick={() => update({ delay: Math.min(MAX_DELAY, delay + 1) })}
              aria-label="지연 시간 늘리기"
            >
              +
            </button>
            <span className="delay-label">{delay}초</span>
          </div>
          <button className="btn primary big" onClick={startDelayReplay} disabled={!ready || waitLeft !== null}>
            ⏸ 멈추고 다시보기
          </button>
        </div>
        {settingsRow}
      </div>
    )
  }

  return (
    <div className="app">
      <div className="stage">
        <video
          ref={videoRef}
          className={showLiveVideo ? 'view' + mirrorClass : 'source'}
          muted
          playsInline
        />
        <canvas ref={canvasRef} className={'view' + mirrorClass} hidden={showLiveVideo} />

        {error && <div className="overlay center error">{error}</div>}
        {!error && !ready && <div className="overlay center">카메라 켜는 중…</div>}
        {!error && ready && mode === 'delay' && !replay && waitLeft !== null && (
          <div className="overlay center">
            <div className="wait-num">{Math.max(waitLeft, 0)}</div>
            <div>초 후부터 지연 화면이 나옵니다</div>
          </div>
        )}

        <div className="badge">{badge}</div>

        <div className="mode-switch seg">
          <button
            className={mode === 'delay' ? 'btn on' : 'btn'}
            disabled={recording}
            onClick={() => update({ mode: 'delay' })}
          >
            지연 화면
          </button>
          <button
            className={mode === 'record' ? 'btn on' : 'btn'}
            disabled={recording}
            onClick={() => update({ mode: 'record' })}
          >
            녹화
          </button>
        </div>
      </div>

      {controls}
    </div>
  )
}
