// Детерміновані sin / cos / atan2 / length для симуляції.
//
// Чому: специфікація ECMAScript дозволяє Math.sin/cos/atan2 бути «implementation-approximated». Виміряно:
// Node 22 (V8 12) і Chromium 153 дають різний останній біт приблизно на 3% входів — і детермінізм
// клієнт ↔ сервер ламається вже на 40-му кроці. Тут лише + − × ÷, Math.round і Math.sqrt — їх IEEE-754
// вимагає рахувати однаково (точне округлення) в будь-якому рушії. Поліноми — з fdlibm (Sun Microsystems).

const PIO2_HI = 1.5707963267341256 // π/2 = HI + LO (Cody–Waite: точне зведення аргументу)
const PIO2_LO = 6.077100506506192e-11
const TWO_OVER_PI = 0.6366197723675814

function kernelSin(x: number): number {
  const z = x * x
  const r =
    0.00833333333332249 +
    z *
      (-0.0001984126982985795 +
        z * (2.7557313707070068e-6 + z * (-2.5050760253406863e-8 + z * 1.58969099521155e-10)))
  return x + z * x * (-0.16666666666666632 + z * r)
}

function kernelCos(x: number): number {
  const z = x * x
  const r =
    z *
    (0.0416666666666666 +
      z *
        (-0.001388888888887411 +
          z *
            (2.480158728947673e-5 +
              z *
                (-2.7557314351390663e-7 +
                  z * (2.087572321298175e-9 + z * -1.1359647557788195e-11)))))
  const hz = 0.5 * z
  const w = 1 - hz
  return w + (1 - w - hz + z * r)
}

// x → (квадрант n, залишок r ∈ [−π/4, π/4])
function reduce(x: number): [number, number] {
  const n = Math.round(x * TWO_OVER_PI)
  return [n & 3, x - n * PIO2_HI - n * PIO2_LO]
}

export function dsin(x: number): number {
  const [q, r] = reduce(x)
  if (q === 0) return kernelSin(r)
  if (q === 1) return kernelCos(r)
  if (q === 2) return -kernelSin(r)
  return -kernelCos(r)
}

export function dcos(x: number): number {
  const [q, r] = reduce(x)
  if (q === 0) return kernelCos(r)
  if (q === 1) return -kernelSin(r)
  if (q === 2) return -kernelCos(r)
  return kernelSin(r)
}

const ATAN_HI: readonly [number, number, number, number] = [
  0.4636476090008061, 0.7853981633974483, 0.982793723247329, 1.5707963267948966,
]
const ATAN_LO: readonly [number, number, number, number] = [
  2.2698777452961687e-17, 3.061616997868383e-17, 1.3903311031230998e-17, 6.123233995736766e-17,
]
// деструктуризація кортежу: кожен коефіцієнт — number, без | undefined
const [AT0, AT1, AT2, AT3, AT4, AT5, AT6, AT7, AT8, AT9, AT10] = [
  0.3333333333333293, -0.19999999999876483, 0.14285714272503466, -0.11111110405462356,
  0.09090887133436507, -0.0769187620504483, 0.06661073137387531, -0.058335701337905735,
  0.049768779946159324, -0.036531572744216916, 0.016285820115365782,
]

function datan(x: number): number {
  const sign = x < 0 ? -1 : 1
  let a = x * sign
  let id: -1 | 0 | 1 | 2 | 3 = -1
  if (a >= 0.4375) {
    if (a < 1.1875) {
      if (a < 0.6875) {
        id = 0
        a = (2 * a - 1) / (2 + a)
      } else {
        id = 1
        a = (a - 1) / (a + 1)
      }
    } else if (a < 2.4375) {
      id = 2
      a = (a - 1.5) / (1 + 1.5 * a)
    } else {
      id = 3
      a = -1 / a
    }
  }
  const z = a * a
  const w = z * z
  const s1 = z * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))))
  const s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))))
  if (id === -1) return sign * (a - a * (s1 + s2))
  return sign * (ATAN_HI[id] - (a * (s1 + s2) - ATAN_LO[id] - a))
}

export function datan2(y: number, x: number): number {
  if (x > 0) return datan(y / x)
  if (x < 0) return y >= 0 ? datan(y / x) + Math.PI : datan(y / x) - Math.PI
  if (y > 0) return Math.PI / 2
  if (y < 0) return -Math.PI / 2
  return 0
}

// Math.hypot теж «approximated»; sqrt — ні (IEEE-754 вимагає точне округлення).
export function dlength(x: number, y: number): number {
  return Math.sqrt(x * x + y * y)
}
