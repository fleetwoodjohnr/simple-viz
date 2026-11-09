"""Cell values of the .xlsb fixtures as read by pyxlsb (an independent implementation), for the reader's tests.

  python -m venv .venv && .venv/bin/pip install pyxlsb
  .venv/bin/python scripts/xlsb-ref.py        # writes tests/fixtures/xlsb/expected.json
"""
import json, pathlib
from pyxlsb import open_workbook

root = pathlib.Path(__file__).resolve().parent.parent / 'tests' / 'fixtures' / 'xlsb'
out = {}
for path in sorted(root.glob('*.xlsb')):
    book = {}
    with open_workbook(str(path)) as wb:
        for name in wb.sheets:
            with wb.get_sheet(name) as sh:
                book[name] = [[c.r, c.c, c.v] for row in sh.rows(sparse=True) for c in row if c.v is not None]
    out[path.name] = book
json.dump(out, open(root / 'expected.json', 'w'), ensure_ascii=False, indent=0)
print('wrote', root / 'expected.json')
