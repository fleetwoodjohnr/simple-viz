# The `.sviz` project format

A Simple Viz project is a ZIP package with the extension `.sviz`:

| Entry | Contents |
|---|---|
| `mimetype` | `application/vnd.simple-viz.project` — first in the archive, stored uncompressed, identifies the file |
| `project.json` | The project (below), UTF-8 JSON |
| `extracts/<source>__<table>.parquet` | Only in a **portable copy**: each table's data, so the project opens without its sources |

There are **no credentials** in a project, ever: database passwords, cloud keys and tokens are kept in the system
keychain under the source's id, and a project from someone else asks for them again.

## project.json

The schema is `Project` in [`src/shared/project.ts`](../src/shared/project.ts) (charts and calculations in
`src/shared/charts.ts`, dashboards in `src/shared/dashboards.ts`):

| Field | |
|---|---|
| `schemaVersion` | Integer; this version of Simple Viz writes 1 |
| `id`, `title`, `createdAt` | Identity (the id also names the local cache: a *Save As* makes a new one) |
| `sources` | Files (path or web/cloud address, format, header row, type corrections) and databases (kind, host, port, database, user, SSL mode, extract or live, timeout), each with its tables (alias and sheet/table reference) and refresh policy |
| `datasets` | Named SQL queries (and, for visual transforms, their input and steps) |
| `queries` | Saved SQL editor queries |
| `models` | Tables related by fields (relationships with cardinality) |
| `hierarchies` | Saved drill paths |
| `calcs`, `params` | Calculated fields (per dataset) and parameters |
| `charts` | Type, dataset, field encodings, filters, options (format, reference lines, forecast, map…) |
| `dashboards` | Size, items (charts, text, images, shapes, buttons, filters, containers) with positions, actions |
| `maps` | Custom maps: GeoJSON areas kept in the project so it stays portable |

Paths are absolute. When a file has moved, the project still opens: the last good data shows from the local cache,
and the refresh status offers to find the file (if the moved file sits next to the project, it is suggested).

## Opening a project safely

- The package is read with limits against malicious archives: at most 20,000 entries, 1.5 GB in total, 1 GB per
  entry, and a compression ratio of at most 1,000 for entries over 1 MB.
- Every part of `project.json` is checked and normalised (`src/core/project/sviz.ts`); unknown fields are dropped.
- A project names files, servers and addresses to read. Before reading any it hasn't been allowed to read on this
  computer, Simple Viz lists them and asks (see [SECURITY.md](SECURITY.md)).
- Nothing in a project runs code: formulas are SQL checked by the same read-only gate as the SQL editor, and custom
  visuals are JSON templates filled with data.

## Versions and migrations

`schemaVersion` changes only for incompatible changes. Opening an older project upgrades it step by step (the
`MIGRATIONS` table in `src/core/project/sviz.ts`, one function per version, never edited once released); opening a
newer one says to update Simple Viz instead of guessing. Optional new fields don't need a migration: missing ones get
defaults when the project is read.

## Portable copies

**File → Save a Portable Copy (with Data)** writes a project with each table's cached data as Parquet (ZSTD
compressed). Opening it on another computer stores that data in the project's cache folder; tables with no cached
copy start from it. The sources are still read when they can be (files at the same paths, reachable databases); until
then the packaged data is the last good data, marked stale. Tables of live database sources have no cached copy and
are not included.

## The local cache

Extracts live outside the project, in `<user data>/cache/<project id>.duckdb` (with `packaged/<project id>/` for a
portable copy's data). The cache can be deleted at any time: it is rebuilt from the sources on the next open.
