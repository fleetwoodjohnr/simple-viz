"""Sales.xlsx protected with a password ("sv-secret"), encrypted by msoffcrypto-tool (ECMA-376 Agile Encryption,
AES-256, SHA-512), an implementation independent of Simple Viz's.

  python -m venv .venv && .venv/bin/pip install msoffcrypto-tool
  .venv/bin/python scripts/encrypted-fixture.py      # writes tests/fixtures/Sales-encrypted.xlsx
"""
import io, pathlib
from msoffcrypto.format.ooxml import OOXMLFile

root = pathlib.Path(__file__).resolve().parent.parent / 'tests' / 'fixtures'
out = io.BytesIO()
with open(root / 'Sales.xlsx', 'rb') as f:
    OOXMLFile(f).encrypt('sv-secret', out)
(root / 'Sales-encrypted.xlsx').write_bytes(out.getvalue())
print('wrote', root / 'Sales-encrypted.xlsx', len(out.getvalue()), 'bytes')
