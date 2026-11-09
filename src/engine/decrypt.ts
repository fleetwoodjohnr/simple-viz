// Password-protected Excel workbooks (.xlsx, .xlsm, .xlsb from Excel 2010 on): ECMA-376 Agile Encryption, [MS-OFFCRYPTO]
// 2.3.4.10–13. The file is a compound file holding EncryptionInfo (an XML description) and EncryptedPackage (the
// workbook's ZIP, encrypted in 4,096-byte segments). The password is turned into a key with salted, iterated hashing,
// which decrypts the package's own key, which decrypts the package. Only in memory; nothing decrypted is written.
import { createDecipheriv, createHash } from 'node:crypto'
import { readCfb } from '../core/sheets/formats/xls'

const CFB = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

export class PasswordError extends Error {
  constructor(
    message: string,
    readonly wrong: boolean
  ) {
    super(message)
  }
}

/** Whether the bytes are an encrypted Office Open XML file (a compound file with an EncryptedPackage stream). */
export function isEncryptedWorkbook(bytes: Uint8Array): boolean {
  if (bytes.length < 512 || !CFB.every((b, i) => bytes[i] === b)) return false
  try {
    const parts = readCfb(bytes)
    return [...parts.keys()].some((k) => /(^|\/)EncryptedPackage$/i.test(k))
  } catch {
    return false
  }
}

const attr = (xml: string, el: string, name: string) => new RegExp(`<(?:\\w+:)?${el}\\b[^>]*\\s${name}="([^"]*)"`).exec(xml)?.[1]
const HASHES: Record<string, string> = { SHA512: 'sha512', SHA384: 'sha384', SHA256: 'sha256', SHA1: 'sha1' }

export function decryptWorkbook(bytes: Uint8Array, password: string | undefined): Uint8Array {
  if (!password) throw new PasswordError('This workbook is protected with a password. Enter it to read the workbook.', false)
  const parts = readCfb(bytes)
  const get = (name: string) => [...parts.entries()].find(([k]) => k.split('/').pop()!.toLowerCase() === name.toLowerCase())?.[1]
  const info = get('EncryptionInfo')
  const pkg = get('EncryptedPackage')
  if (!info || !pkg) throw new Error('This file is encrypted in a way Simple Viz can’t read.')
  const version = (info[0] | (info[1] << 8)) + '.' + (info[2] | (info[3] << 8))
  if (version !== '4.4') throw new Error(`This workbook uses an older Excel encryption (version ${version}) that Simple Viz can’t read. Open it in Excel and save it again.`)
  const xml = new TextDecoder().decode(info.subarray(8))
  const kd = { salt: attr(xml, 'keyData', 'saltValue'), hash: attr(xml, 'keyData', 'hashAlgorithm'), block: Number(attr(xml, 'keyData', 'blockSize')), bits: Number(attr(xml, 'keyData', 'keyBits')), cipher: attr(xml, 'keyData', 'cipherAlgorithm'), chaining: attr(xml, 'keyData', 'cipherChaining') }
  const pe = { salt: attr(xml, 'encryptedKey', 'saltValue'), hash: attr(xml, 'encryptedKey', 'hashAlgorithm'), spin: Number(attr(xml, 'encryptedKey', 'spinCount')), bits: Number(attr(xml, 'encryptedKey', 'keyBits')), key: attr(xml, 'encryptedKey', 'encryptedKeyValue'), verifierIn: attr(xml, 'encryptedKey', 'encryptedVerifierHashInput'), verifierHash: attr(xml, 'encryptedKey', 'encryptedVerifierHashValue') }
  if (kd.cipher !== 'AES' || pe.hash === undefined || !HASHES[pe.hash] || !HASHES[kd.hash ?? ''] || kd.chaining !== 'ChainingModeCBC' || !pe.salt || !pe.key || !kd.salt) throw new Error('This workbook’s encryption isn’t supported (AES with SHA hashing is).')
  if (!(pe.spin > 0 && pe.spin <= 10_000_000)) throw new Error('This workbook’s encryption settings are invalid.')
  const h = HASHES[pe.hash]
  const hash = (...bufs: Uint8Array[]) => {
    const c = createHash(h)
    for (const b of bufs) c.update(b)
    return c.digest()
  }
  // H0 = H(salt + password), Hn = H(iterator + Hn−1)
  const salt = Buffer.from(pe.salt, 'base64')
  let H = hash(salt, Buffer.from(password, 'utf16le'))
  const it = Buffer.alloc(4)
  for (let i = 0; i < pe.spin; i++) {
    it.writeUInt32LE(i)
    H = hash(it, H)
  }
  const keyFor = (block: number[]) => {
    const k = hash(H, Buffer.from(block))
    const n = pe.bits / 8
    return k.length >= n ? k.subarray(0, n) : Buffer.concat([k, Buffer.alloc(n - k.length, 0x36)])
  }
  const aes = (key: Buffer, iv: Buffer, data: Buffer) => {
    const d = createDecipheriv(`aes-${key.length * 8}-cbc`, key, iv.subarray(0, 16))
    d.setAutoPadding(false)
    return Buffer.concat([d.update(data), d.final()])
  }
  // The password check: the verifier input, hashed, must equal the decrypted verifier hash.
  if (pe.verifierIn && pe.verifierHash) {
    const vin = aes(keyFor([0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79]), salt, Buffer.from(pe.verifierIn, 'base64')).subarray(0, 16)
    const vh = aes(keyFor([0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e]), salt, Buffer.from(pe.verifierHash, 'base64'))
    const want = hash(vin)
    if (!vh.subarray(0, want.length).equals(want)) throw new PasswordError('The password is wrong.', true)
  }
  const secret = aes(keyFor([0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6]), salt, Buffer.from(pe.key, 'base64')).subarray(0, kd.bits / 8)
  // The package: its size, then 4,096-byte segments, each with IV = H(keyData salt + segment number).
  const size = Number(Buffer.from(pkg.subarray(0, 8)).readBigUInt64LE())
  const data = Buffer.from(pkg.subarray(8))
  const kdSalt = Buffer.from(kd.salt, 'base64')
  const kh = HASHES[kd.hash!]
  const out: Buffer[] = []
  for (let seg = 0, off = 0; off < data.length; seg++, off += 4096) {
    const n = Buffer.alloc(4)
    n.writeUInt32LE(seg)
    const iv = createHash(kh).update(kdSalt).update(n).digest()
    const chunk = data.subarray(off, Math.min(data.length, off + 4096))
    out.push(aes(secret, iv, chunk.length % 16 ? Buffer.concat([chunk, Buffer.alloc(16 - (chunk.length % 16))]) : chunk))
  }
  const plain = Buffer.concat(out).subarray(0, size)
  if (plain[0] !== 0x50 || plain[1] !== 0x4b) throw new PasswordError('The password is wrong.', true)
  return new Uint8Array(plain)
}
