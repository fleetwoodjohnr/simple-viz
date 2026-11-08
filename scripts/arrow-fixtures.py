"""Arrow / Feather test files written by pyarrow (the reference implementation), committed in tests/fixtures/arrow.

  python -m venv .venv && .venv/bin/pip install pyarrow && .venv/bin/python scripts/arrow-fixtures.py
"""
import datetime, decimal, pathlib
import pyarrow as pa, pyarrow.feather as feather, pyarrow.ipc as ipc

out = pathlib.Path(__file__).resolve().parent.parent / 'tests' / 'fixtures' / 'arrow'
out.mkdir(parents=True, exist_ok=True)
t = pa.table({
    'id': pa.array([1, 2, 3, 4], pa.int64()),
    'small': pa.array([1, -2, None, 4], pa.int32()),
    'name': ['Ann', 'Bo', None, 'Côte'],
    'amount': [1.5, None, 3.25, -7.0],
    'price': pa.array([decimal.Decimal('10.25'), None, decimal.Decimal('-3.50'), decimal.Decimal('0.01')], pa.decimal128(10, 2)),
    'day': pa.array([datetime.date(2025, 1, 1), datetime.date(2025, 2, 28), None, datetime.date(1999, 12, 31)]),
    'at': pa.array([datetime.datetime(2025, 1, 1, 12, 30), None, datetime.datetime(2025, 6, 1, 0, 0, 1), datetime.datetime(2000, 1, 1)], pa.timestamp('us')),
    'ok': [True, False, None, True],
    'region': pa.array(['East', 'West', 'East', None]).dictionary_encode(),
})
feather.write_feather(t, out / 'mixed-lz4.feather')
feather.write_feather(t, out / 'mixed-zstd.feather', compression='zstd')
feather.write_feather(t, out / 'mixed.arrow', compression='uncompressed')
with ipc.new_stream(str(out / 'mixed.arrows'), t.schema) as w:
    w.write_table(t)
# Buffers over 4 MB: several linked LZ4 blocks per buffer.
n = 1_200_000
big = pa.table({'k': pa.array([i % 1000 for i in range(n)], pa.int64()), 'v': pa.array([float(i % 7) for i in range(n)])})
feather.write_feather(big, out / 'big-lz4.feather')
print('wrote', sorted(p.name for p in out.iterdir()))
