import { useEffect, useRef, useState } from 'react'

export type Facing = 'user' | 'environment'

export function useCamera(facing: Facing) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let stream: MediaStream | null = null
    let cancelled = false
    setReady(false)
    setError(null)

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('이 브라우저에서는 카메라를 쓸 수 없습니다. https 주소로 접속했는지 확인하세요.')
      return
    }

    navigator.mediaDevices
      .getUserMedia({
        audio: false,
        video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
      })
      .then(async (s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop())
          return
        }
        stream = s
        const video = videoRef.current
        if (!video) return
        video.srcObject = s
        await video.play().catch(() => {})
        setReady(true)
      })
      .catch((e: unknown) => {
        const name = e instanceof DOMException ? e.name : ''
        setError(
          name === 'NotAllowedError'
            ? '카메라 권한이 거부되었습니다. 주소창의 카메라 아이콘에서 허용해 주세요.'
            : name === 'NotFoundError'
              ? '카메라를 찾을 수 없습니다.'
              : '카메라를 켤 수 없습니다. 다른 앱이 카메라를 쓰고 있지 않은지 확인하세요.',
        )
      })

    return () => {
      cancelled = true
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [facing])

  return { videoRef, ready, error }
}
