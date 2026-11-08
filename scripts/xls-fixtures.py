"""Excel 97-2003 (.xls) test files, written by xlwt (a BIFF8 writer) and read back by xlrd (an independent reader)
for reference values. Committed in tests/fixtures; rerun after `npm run fixtures` changes Sales.xlsx.

  python -m venv .venv && .venv/bin/pip install xlwt xlrd openpyxl && .venv/bin/python scripts/xls-fixtures.py
"""
import datetime, json, pathlib
import openpyxl, xlrd, xlwt

fx = pathlib.Path(__file__).resolve().parent.parent / 'tests' / 'fixtures'
src = openpyxl.load_workbook(fx / 'Sales.xlsx', read_only=True).active
wb = xlwt.Workbook(encoding='utf-8')
ws = wb.add_sheet('Transactions')
date = xlwt.easyxf(num_format_str='yyyy-mm-dd')
money = xlwt.easyxf(num_format_str='#,##0.00')
for r, row in enumerate(src.iter_rows(values_only=True)):
    for c, v in enumerate(row):
        if isinstance(v, datetime.datetime):
            ws.write(r, c, v, date)
        elif isinstance(v, float):
            ws.write(r, c, v, money)
        else:
            ws.write(r, c, v)
# A second sheet: more distinct text than one record holds (the shared strings continue across records), wide
# characters, booleans, integers and fractions (RK records), an empty cell, and a hidden third sheet.
notes = wb.add_sheet('Notes')
for c, h in enumerate(['label', 'flag', 'count', 'share', 'when']):
    notes.write(0, c, h)
for i in range(1, 2001):
    notes.write(i, 0, f'Note {i:04d} — café ünïcödé ✓ {"x" * (i % 37)}')
    notes.write(i, 1, i % 3 == 0)
    notes.write(i, 2, i * 7)
    notes.write(i, 3, i / 8)
    if i % 10:
        notes.write(i, 4, datetime.datetime(2024, 1, 1) + datetime.timedelta(days=i, hours=i % 24), xlwt.easyxf(num_format_str='yyyy-mm-dd hh:mm'))
hidden = wb.add_sheet('Hidden')
hidden.write(0, 0, 'secret-ish')
hidden.sheet_visibility = 1
wb.save(fx / 'Sales.xls')

# Reference values from xlrd.
book = xlrd.open_workbook(fx / 'Sales.xls')
ref = {}
for sh in book.sheets():
    rows = []
    for r in range(sh.nrows):
        out = []
        for c in range(sh.ncols):
            cell = sh.cell(r, c)
            if cell.ctype == xlrd.XL_CELL_DATE:
                out.append({'date': xlrd.xldate.xldate_as_datetime(cell.value, book.datemode).isoformat()})
            elif cell.ctype == xlrd.XL_CELL_BOOLEAN:
                out.append(bool(cell.value))
            elif cell.ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK):
                out.append(None)
            else:
                out.append(cell.value)
        rows.append(out)
    ref[sh.name] = {'hidden': sh.visibility != 0, 'rows': rows}
json.dump(ref, open(fx / 'Sales.xls.json', 'w'), ensure_ascii=False)
print('wrote', fx / 'Sales.xls', {k: len(v['rows']) for k, v in ref.items()})
