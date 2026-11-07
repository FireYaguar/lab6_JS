// Token bucket: `rate` токенів за секунду, не більше `burst` у запасі. Кожне повідомлення — один токен.
export interface TokenBucket {
  take(): boolean
}

export function createTokenBucket({
  rate,
  burst,
  now = () => performance.now(),
}: {
  rate: number
  burst: number
  now?: () => number
}): TokenBucket {
  let tokens = burst
  let last = now()
  return {
    take() {
      const t = now()
      tokens = Math.min(burst, tokens + ((t - last) / 1000) * rate)
      last = t
      if (tokens < 1) return false
      tokens -= 1
      return true
    },
  }
}
