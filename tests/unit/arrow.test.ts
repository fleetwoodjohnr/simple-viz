// Arrow / Feather files written by pyarrow (scripts/arrow-fixtures.py): every compression, every column type read.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { readArrow, lz4FrameDecode } from '../../src/engine/arrow'

const file = (n: string) => new Uint8Array(readFileSync(path.resolve('tests/fixtures/arrow', n)))

describe('Arrow and Feather', () => {
  it('reads the same table from uncompressed, LZ4, ZSTD and stream files', () => {
    const want = readArrow(file('mixed.arrow'))
    for (const n of ['mixed-lz4.feather', 'mixed-zstd.feather', 'mixed.arrows']) expect(readArrow(file(n)), n).toEqual(want)
    const col = (name: string) => want.columns.find((c) => c.name === name)!
    expect(want.rowCount).toBe(4)
    expect(want.columns.map((c) => [c.name, c.type])).toEqual([['id', 'BIGINT'], ['small', 'BIGINT'], ['name', 'VARCHAR'], ['amount', 'DOUBLE'], ['price', 'DOUBLE'], ['day', 'DATE'], ['at', 'TIMESTAMP'], ['ok', 'BOOLEAN'], ['region', 'VARCHAR']])
    expect(col('small').values).toEqual([1, -2, null, 4])
    expect(col('name').values).toEqual(['Ann', 'Bo', null, 'Côte'])
    expect(col('price').values).toEqual([10.25, null, -3.5, 0.01])
    expect(col('day').values).toEqual([Date.UTC(2025, 0, 1) / 86_400_000, Date.UTC(2025, 1, 28) / 86_400_000, null, Date.UTC(1999, 11, 31) / 86_400_000])
    expect(col('at').values).toEqual([Date.UTC(2025, 0, 1, 12, 30), null, Date.UTC(2025, 5, 1, 0, 0, 1), Date.UTC(2000, 0, 1)])
    expect(col('ok').values).toEqual([true, false, null, true])
    expect(col('region').values).toEqual(['East', 'West', 'East', null])
  })

  it('LZ4 frames whose blocks refer back to earlier blocks (buffers over 4 MB)', () => {
    const t = readArrow(file('big-lz4.feather'))
    expect(t.rowCount).toBe(1_200_000)
    const k = t.columns[0].values as number[]
    expect([k[0], k[999], k[1000], k[1_199_999]]).toEqual([0, 999, 0, 999])
    expect(k.reduce((a, b) => a + b, 0)).toBe(1200 * 499_500)
    expect(() => lz4FrameDecode(new Uint8Array([1, 2, 3, 4, 5, 6, 7]))).toThrow(/Not an LZ4 frame/)
    expect(() => readArrow(new Uint8Array([1, 2, 3]))).toThrow(/readable Arrow/)
  })
})
