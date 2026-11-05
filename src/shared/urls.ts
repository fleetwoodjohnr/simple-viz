/** Links the app will hand to the system: web and email addresses only (no file:, javascript:, custom schemes). */
export function isSafeExternalUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 8192) return false
  try {
    const u = new URL(url)
    return (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') && !/[\u0000-\u001f]/.test(url)
  } catch {
    return false
  }
}
