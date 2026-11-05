import { describe, expect, it } from 'vitest'
import { HttpError, newError } from 'builder-util-runtime'
import { updateErrorMessage } from '@/main/updater'

// The response electron-updater puts into its messages: never shown to the user.
const body = `"Headers": {"content-security-policy": "default-src 'none'; connect-src 'self' uploads.github.com", "set-cookie": "_gh_sess=secret"}\n"Data": <!DOCTYPE html>`
const http = (status: number) => new HttpError(status, `${status} \n${body}`)
const coded = (code: string) => newError(`message with the response: ${body}`, code)
// How electron-updater 6.8's GitHub provider reports a failed /releases/latest lookup (GitHubProvider.getLatestVersion)
const lookupFailed = (cause: Error) =>
  newError(
    `Cannot parse releases feed: ${newError(`Unable to find latest version on GitHub (https://github.com/o/r/releases/latest), please ensure a production release exists: ${cause.stack}`, 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND').stack},\nXML:\n<feed/>`,
    'ERR_UPDATER_INVALID_RELEASE_FEED'
  )

describe('update errors', () => {
  it('no published release on GitHub means nothing is newer', () => {
    expect(updateErrorMessage(lookupFailed(http(406)))).toBeNull() // seen against the real GitHub with only a draft release
    expect(updateErrorMessage(lookupFailed(http(404)))).toBeNull()
    expect(updateErrorMessage(coded('ERR_UPDATER_NO_PUBLISHED_VERSIONS'))).toBeNull()
  })

  it('says plainly what went wrong, without the response', () => {
    const cases: [unknown, RegExp][] = [
      [new Error('net::ERR_INTERNET_DISCONNECTED'), /internet connection/],
      [lookupFailed(new Error('net::ERR_NAME_NOT_RESOLVED')), /internet connection/],
      [Object.assign(new Error(body), { code: 'ENOTFOUND' }), /internet connection/],
      [http(403), /limiting/],
      [lookupFailed(http(429)), /limiting/],
      [coded('ERR_CHECKSUM_MISMATCH'), /damaged/],
      [coded('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'), /releases page/],
      [lookupFailed(http(500)), /Something went wrong/],
      [coded('ERR_UPDATER_INVALID_RELEASE_FEED'), /Something went wrong/],
      ['not even an error', /Something went wrong/],
      [undefined, /Something went wrong/]
    ]
    for (const [e, want] of cases) {
      const m = updateErrorMessage(e)!
      expect(m).toMatch(want)
      expect(m.length).toBeLessThan(160)
      expect(m).not.toMatch(/Headers|cookie|DOCTYPE|github\.com/)
    }
  })
})
