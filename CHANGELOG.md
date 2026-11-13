# Changelog

## 0.1.4 (unreleased)

### Changed

- **`FileRef` is now `{ url, name, type, size }`** (was `{ url, nombre, tipo, tamano }`).
  New values —uploads in `file` and `folder` cells, values pasted into them, files attached by
  the import assistant— are always written in the new shape.

### Deprecated

- **The Spanish `FileRef` shape `{ url, nombre, tipo, tamano }`** (`LegacyFileRef`). It is still
  read everywhere, so values stored with 0.1.3 or earlier keep working: cells show them,
  `isFileRef`, `toFileRef` and `fileRefsOf` accept them, validation passes them and comparisons
  treat both shapes of the same file as equal (no false conflicts). It is removed in the next
  major version. To migrate stored data, read each value with `toFileRef` / `fileRefsOf` (they
  return the new shape) and write it back.

### Added

- `normalizeFileRef(ref)` and `normalizeFileValue(value)` (core): a file (or a cell value with
  files) in the new shape.
