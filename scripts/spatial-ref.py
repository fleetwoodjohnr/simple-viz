"""Spatial test files written by pyshp (an independent shapefile writer) and by hand (KML, TopoJSON), with what they
contain; projected shapefiles' coordinates come from pyproj.

  python -m venv .venv && .venv/bin/pip install pyshp pyproj
  .venv/bin/python scripts/spatial-ref.py        # writes tests/fixtures/spatial/
"""
import io, json, pathlib, zipfile
import shapefile

out = pathlib.Path(__file__).resolve().parent.parent / 'tests' / 'fixtures' / 'spatial'
out.mkdir(parents=True, exist_ok=True)
WGS84 = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]'
LCC = 'PROJCS["Lambert_Conformal_Conic_Test",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Lambert_Conformal_Conic"],UNIT["Meter",1.0]]'
UTM = 'PROJCS["WGS_1984_UTM_Zone_33N",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",15.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]'

# Outer rings clockwise, holes counter-clockwise (the shapefile convention).
north_outer = [[0, 10], [10, 10], [10, 0], [0, 0], [0, 10]]
north_hole = [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]]
south_a = [[0, -1], [5, -1], [5, -6], [0, -6], [0, -1]]
south_b = [[6, -1], [9, -1], [9, -6], [6, -6], [6, -1]]
areas = [('North', 1200, [north_outer, north_hole]), ('Südfeld', 85, [south_a, south_b])]

def shp_zip(name, prj, scale=1, project=None):
    shp, shx, dbf = io.BytesIO(), io.BytesIO(), io.BytesIO()
    w = shapefile.Writer(shp=shp, shx=shx, dbf=dbf, shapeType=shapefile.POLYGON, encoding='utf-8')
    w.field('NAME', 'C', size=40)
    w.field('POP', 'N', size=10)
    for n, pop, rings in areas:
        w.poly([[list(project(x, y)) if project else [x * scale, y * scale] for x, y in r] for r in rings])
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
shp_zip('projected', LCC, scale=50000)
# The same areas moved near 15° E, 45° N, projected by pyproj into UTM zone 33N and Web Mercator.
from pyproj import Transformer
WEBM = 'PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Mercator_Auxiliary_Sphere"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",0.0],PARAMETER["Standard_Parallel_1",0.0],PARAMETER["Auxiliary_Sphere_Type",0.0],UNIT["Meter",1.0]]'
near = lambda x, y: (14 + x / 5, 45 + y / 5)
utm = Transformer.from_crs('EPSG:4326', 'EPSG:32633', always_xy=True)
webm = Transformer.from_crs('EPSG:4326', 'EPSG:3857', always_xy=True)
shp_zip('utm', UTM, project=lambda x, y: utm.transform(*near(x, y)))
shp_zip('webmerc', WEBM, project=lambda x, y: webm.transform(*near(x, y)))
expected_near = [[list(near(x, y)) for x, y in sum(rings, [])] for _, _, rings in areas]

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
# TopoJSON: the two areas of a square split down the middle, sharing their middle arc; quantized (delta-encoded).
topo = {
  'type': 'Topology',
  'transform': {'scale': [0.5, 0.25], 'translate': [10, 20]},
  'objects': {'halves': {'type': 'GeometryCollection', 'geometries': [
    {'type': 'Polygon', 'arcs': [[0, 1]], 'properties': {'name': 'West'}},
    {'type': 'Polygon', 'arcs': [[2, ~0]], 'properties': {'name': 'East'}}]}},
  # arc 0: (2,0)→(2,4) shared; arc 1: (2,4)→(0,4)→(0,0)→(2,0); arc 2: (2,0)→(4,0)→(4,4)→(2,4). Quantized units, deltas.
  'arcs': [[[2, 0], [0, 4]], [[2, 4], [-2, 0], [0, -4], [2, 0]], [[2, 0], [2, 0], [0, 4], [-2, 0]]]
}
json.dump(topo, open(out / 'halves.topojson', 'w'))
json.dump({'shapes': expected, 'near': expected_near}, open(out / 'expected.json', 'w'), indent=1, ensure_ascii=False)
print('wrote', out)
