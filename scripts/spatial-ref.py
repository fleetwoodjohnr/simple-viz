"""Spatial test files written by pyshp (an independent shapefile writer) and by hand (KML), with what they contain.

  python -m venv .venv && .venv/bin/pip install pyshp
  .venv/bin/python scripts/spatial-ref.py        # writes tests/fixtures/spatial/
"""
import io, json, pathlib, zipfile
import shapefile

out = pathlib.Path(__file__).resolve().parent.parent / 'tests' / 'fixtures' / 'spatial'
out.mkdir(parents=True, exist_ok=True)
WGS84 = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]'
UTM = 'PROJCS["WGS_1984_UTM_Zone_33N",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],UNIT["Meter",1.0]]'

# Outer rings clockwise, holes counter-clockwise (the shapefile convention).
north_outer = [[0, 10], [10, 10], [10, 0], [0, 0], [0, 10]]
north_hole = [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]]
south_a = [[0, -1], [5, -1], [5, -6], [0, -6], [0, -1]]
south_b = [[6, -1], [9, -1], [9, -6], [6, -6], [6, -1]]
areas = [('North', 1200, [north_outer, north_hole]), ('Südfeld', 85, [south_a, south_b])]

def shp_zip(name, prj, scale=1):
    shp, shx, dbf = io.BytesIO(), io.BytesIO(), io.BytesIO()
    w = shapefile.Writer(shp=shp, shx=shx, dbf=dbf, shapeType=shapefile.POLYGON, encoding='utf-8')
    w.field('NAME', 'C', size=40)
    w.field('POP', 'N', size=10)
    for n, pop, rings in areas:
        w.poly([[[x * scale, y * scale] for x, y in r] for r in rings])
        w.record(n, pop)
    w.close()
    z = io.BytesIO()
    with zipfile.ZipFile(z, 'w') as zf:
        for ext, b in [('shp', shp.getvalue()), ('shx', shx.getvalue()), ('dbf', dbf.getvalue()), ('prj', prj.encode()), ('cpg', b'UTF-8')]:
            zf.writestr(f'{name}.{ext}', b)
    (out / f'{name}.zip').write_bytes(z.getvalue())
    return shp.getvalue(), dbf.getvalue()

shp, dbf = shp_zip('areas', WGS84)
(out / 'areas.shp').write_bytes(shp)
(out / 'areas.dbf').write_bytes(dbf)
shp_zip('projected', UTM, scale=50000)

# Read back with pyshp: what a reader must find.
r = shapefile.Reader(shp=io.BytesIO(shp), dbf=io.BytesIO(dbf), encoding='utf-8')
expected = [dict(record=dict(zip([f[0] for f in r.fields[1:]], rec)), parts=list(s.parts), points=[list(p) for p in s.points]) for s, rec in zip(r.shapes(), r.records())]

coords = lambda ring: ' '.join(f'{x},{y},0' for x, y in reversed(ring))  # KML rings counter-clockwise
kml = f'''<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<Placemark><name>North</name><ExtendedData><Data name="pop"><value>1200</value></Data></ExtendedData>
<Polygon><outerBoundaryIs><LinearRing><coordinates>{coords(north_outer)}</coordinates></LinearRing></outerBoundaryIs><innerBoundaryIs><LinearRing><coordinates>{coords(north_hole)}</coordinates></LinearRing></innerBoundaryIs></Polygon></Placemark>
<Placemark><name>Südfeld</name><ExtendedData><SchemaData><SimpleData name="pop">85</SimpleData></SchemaData></ExtendedData>
<MultiGeometry><Polygon><outerBoundaryIs><LinearRing><coordinates>{coords(south_a)}</coordinates></LinearRing></outerBoundaryIs></Polygon><Polygon><outerBoundaryIs><LinearRing><coordinates>{coords(south_b)}</coordinates></LinearRing></outerBoundaryIs></Polygon></MultiGeometry></Placemark>
<Placemark><name>A point</name><Point><coordinates>1,1,0</coordinates></Point></Placemark>
</Document></kml>
'''
(out / 'areas.kml').write_text(kml, encoding='utf-8')
z = io.BytesIO()
with zipfile.ZipFile(z, 'w') as zf:
    zf.writestr('doc.kml', kml)
(out / 'areas.kmz').write_bytes(z.getvalue())
json.dump(expected, open(out / 'expected.json', 'w'), indent=1, ensure_ascii=False)
print('wrote', out)
