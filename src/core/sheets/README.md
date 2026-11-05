# Spreadsheet readers (from Simple Cell)

Everything in this folder except `rows.ts` is copied from [Simple Cell](https://github.com/fleetwoodjohnr/simple-cell)
at commit `f1fe4e8` (`src/core/…`, same relative paths): the XLSX/XLSM, ODS and XML 2003 readers with their zip-bomb
limits and DOCTYPE stripping, the workbook model, number formats and the XLSX writer used for Excel export.

Changes made here:

- `formats/zip.ts`: messages name Simple Viz.
- `formats/xlsx/read.ts`: `readXlsx(bytes, { keepSpillValues: true })` keeps the values Excel cached inside
  dynamic-array spill ranges (Simple Cell recalculates them instead; Simple Viz never recalculates).

`rows.ts` is Simple Viz's own: it turns a sheet, table, named range or `Sheet!A1:D9` range into typed columns.

When Simple Cell fixes a reader bug, copy the file again and keep the change above.
