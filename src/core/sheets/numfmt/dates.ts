// Excel date serials. In the 1900 system serial 1 is 1900-01-01 and serial 60 is the fictitious 1900-02-29 that
// Lotus 1-2-3 introduced and Excel keeps; in the 1904 system serial 0 is 1904-01-01.

const MS_DAY = 86_400_000
const EPOCH_1900 = Date.UTC(1899, 11, 30) // serial 0 for serials ≥ 61
const EPOCH_1904 = Date.UTC(1904, 0, 1)

export interface YMD {
  y: number
  m: number
  d: number
}

/** Serial for a calendar date. Month and day may overflow, like DATE(): DATE(2024,14,1) = 2025-02-01. */
export function dateSerial(y: number, m: number, d: number, date1904 = false): number {
  const ms = Date.UTC(y, m - 1, 1) + (d - 1) * MS_DAY
  if (date1904) return Math.round((ms - EPOCH_1904) / MS_DAY)
  const s = Math.round((ms - EPOCH_1900) / MS_DAY)
  // Before 1900-03-01, the 1900 system is one day lower (no fictitious Feb 29 yet).
  return s < 61 ? s - 1 : s
}

/** Calendar date of a serial's integer part. Serial 60 (1900 system) gives 1900-02-29; serial 0 gives 1900-01-00. */
export function serialToDate(serial: number, date1904 = false): YMD {
  const n = Math.floor(serial)
  if (!date1904) {
    if (n === 60) return { y: 1900, m: 2, d: 29 }
    if (n === 0) return { y: 1900, m: 1, d: 0 }
    const ms = EPOCH_1900 + (n < 60 ? n + 1 : n) * MS_DAY
    const dt = new Date(ms)
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }
  }
  const dt = new Date(EPOCH_1904 + n * MS_DAY)
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }
}

/** Day of the week, 0 = Sunday. The fictitious 1900-02-29 keeps serial arithmetic uniform: serial 1 is a "Sunday". */
export function weekday(serial: number, date1904 = false): number {
  return (((Math.floor(serial) + (date1904 ? 1462 : 0) + 6) % 7) + 7) % 7
}

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** Fraction of a day → h, m, s, ms (rounded to the millisecond as Excel displays). */
export function timeParts(serial: number): { h: number; mi: number; s: number; ms: number } {
  let frac = serial - Math.floor(serial)
  let ms = Math.round(frac * MS_DAY)
  if (ms >= MS_DAY) ms = MS_DAY - 1
  frac = ms
  const h = Math.floor(frac / 3_600_000)
  const mi = Math.floor((frac % 3_600_000) / 60_000)
  const s = Math.floor((frac % 60_000) / 1000)
  return { h, mi, s, ms: frac % 1000 }
}

/** Current local date-time as a serial (NOW). */
export function nowSerial(date1904 = false, now = new Date()): number {
  const d = dateSerial(now.getFullYear(), now.getMonth() + 1, now.getDate(), date1904)
  return d + (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000) / 86400
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const monthIndex = (s: string) => {
  const i = MONTHS.indexOf(s.slice(0, 3).toLowerCase())
  return i < 0 || (s.length > 3 && !/^(january|february|march|april|may|june|july|august|september|sept|october|november|december)$/i.test(s)) ? -1 : i + 1
}

/**
 * Text → serial, for the date and time formats Excel recognises in en-US (typed into cells, DATEVALUE, coercion):
 * 2024-01-15, 1/15/2024, 1/15, 15-Jan-2024, 15 Jan 2024, Jan 15, 2024, January 2024, 13:45, 1:45 PM, 1/15/2024 13:45.
 * Returns null when the text is not a date or time.
 */
export function parseDateTime(text: string, date1904 = false): number | null {
  const s = text.trim()
  if (!s || s.length > 40) return null
  let date: number | null = null
  let rest = s
  const two = (y: number) => (y < 30 ? 2000 + y : y < 100 ? 1900 + y : y)
  const valid = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m) && y >= (date1904 ? 1904 : 1900) && y <= 9999
  const tryDate = (re: RegExp, build: (m: RegExpExecArray) => [number, number, number] | null) => {
    if (date !== null) return
    const m = re.exec(rest)
    if (!m) return
    const ymd = build(m)
    if (!ymd || !valid(...ymd)) return
    date = dateSerial(ymd[0], ymd[1], ymd[2], date1904)
    rest = rest.slice(m[0].length).trim()
  }
  tryDate(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?=$|\s|T)/, (m) => [Number(m[1]), Number(m[2]), Number(m[3])])
  if (rest.startsWith('T')) rest = rest.slice(1)
  tryDate(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?=$|\s)/, (m) => [two(Number(m[3])), Number(m[1]), Number(m[2])])
  tryDate(/^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s,]+(\d{2,4})(?=$|\s)/, (m) => (monthIndex(m[2]) > 0 ? [two(Number(m[3])), monthIndex(m[2]), Number(m[1])] : null))
  tryDate(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(?=$|\s)/, (m) => (monthIndex(m[1]) > 0 ? [Number(m[3]), monthIndex(m[1]), Number(m[2])] : null))
  tryDate(/^(\d{1,2})[-\s]([A-Za-z]{3,9})(?=$|\s)/, (m) => (monthIndex(m[2]) > 0 ? [new Date().getFullYear(), monthIndex(m[2]), Number(m[1])] : null))
  tryDate(/^([A-Za-z]{3,9})[-\s](\d{4})(?=$|\s)/, (m) => (monthIndex(m[1]) > 0 ? [Number(m[2]), monthIndex(m[1]), 1] : null))
  tryDate(/^(\d{1,2})\/(\d{1,2})(?=$|\s)/, (m) => [new Date().getFullYear(), Number(m[1]), Number(m[2])])
  let time: number | null = null
  if (rest) {
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?\s*(am|pm|a|p)?$/i.exec(rest) ?? /^(\d{1,2})\s*(am|pm|a|p)$/i.exec(rest)
    if (!m) return null
    let h: number
    let mi = 0
    let sec = 0
    let ap: string | undefined
    if (m.length === 3) {
      h = Number(m[1])
      ap = m[2]
    } else {
      h = Number(m[1])
      mi = Number(m[2])
      sec = m[3] ? Number(m[3]) : 0
      ap = m[4]
    }
    if (ap) {
      if (h < 1 || h > 12) return null
      const pm = /^p/i.test(ap)
      if (h === 12) h = pm ? 12 : 0
      else if (pm) h += 12
    }
    if (mi > 59 || sec >= 60 || (!ap && h > 9999)) return null
    time = (h * 3600 + mi * 60 + sec) / 86400
  }
  if (date === null && time === null) return null
  return (date ?? 0) + (time ?? 0)
}
