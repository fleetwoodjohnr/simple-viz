// Password-protected workbooks: Sales.xlsx encrypted by msoffcrypto-tool (scripts/encrypted-fixture.py) decrypts to
// exactly the original file; a wrong or missing password is reported as such.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { decryptWorkbook, isEncryptedWorkbook, PasswordError } from '../../src/engine/decrypt'

const fx = (n: string) => new Uint8Array(readFileSync(path.join(import.meta.dirname, '..', 'fixtures', n)))

describe('password-protected workbooks', () => {
  it('decrypts Agile Encryption (AES-256, SHA-512) to the original bytes', () => {
    const enc = fx('Sales-encrypted.xlsx')
    expect(isEncryptedWorkbook(enc)).toBe(true)
    expect(isEncryptedWorkbook(fx('Sales.xlsx'))).toBe(false)
    expect(isEncryptedWorkbook(fx('Sales.xls'))).toBe(false)
    expect(Buffer.from(decryptWorkbook(enc, 'sv-secret')).equals(Buffer.from(fx('Sales.xlsx')))).toBe(true)
  })

  it('a wrong or missing password is reported', () => {
    const enc = fx('Sales-encrypted.xlsx')
    expect(() => decryptWorkbook(enc, 'nope')).toThrow(PasswordError)
    expect(() => decryptWorkbook(enc, 'nope')).toThrow('The password is wrong.')
    try {
      decryptWorkbook(enc, undefined)
    } catch (e) {
      expect([(e as PasswordError).wrong, (e as Error).message]).toEqual([false, 'This workbook is protected with a password. Enter it to read the workbook.'])
    }
  })
})
