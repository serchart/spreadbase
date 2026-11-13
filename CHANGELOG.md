# Changelog

## 0.1.4

### Fixed

- **Leaving a cell commits what was typed**, like Enter (as in Google Sheets): clicking another
  cell, outside the sheet or on a toolbar button no longer loses the value. Escape still
  cancels. It applies to every editor that holds typed text (native text and number, text with
  avatar, text panel, password, typed date); picking from a list or calendar commits once, as
  before.

### Changed

- **«Guardar» (Save) reflects real changes live.** It turns on only when something differs from
  the reference value (the last saved one), counting what is typed in the open cell: typing a
  different value turns it on, typing the previous value back turns it off while still editing.
  One click commits the open cell and saves it in the same batch, once. After saving it turns
  off and the saved value becomes the new reference. A new row counts as a change by itself.
- **`FileRef` is now `{ url, name, type, size }`** (was `{ url, nombre, tipo, tamano }`).
  New values —uploads in `file` and `folder` cells, values pasted into them, files attached by
  the import assistant— are always written in the new shape.
- **The guides in `docs/` are in English** (same decision IDs, tables and examples).

### Added

- **Folder cells show their primary file**: the first file of the list, as its thumbnail if it
  is an image or the icon of its type otherwise (PDF, spreadsheet…), plus the file count and
  all names on hover. The folder panel has a «Hacer principal» (make primary) action that
  moves a file to first place, for any file type.
- **`avatar.image` can point to a `folder` column**: the thumbnail is its primary file if it is
  an image, otherwise the first image in the folder, otherwise the usual fallback. Works in the
  same row and in a `lookup` (the server sends the image URL in `Page.images`). New core
  helpers: `thumbnailOf`, `isImageFile`.
- A text cell's thumbnail repaints when the field it comes from changes.
- `normalizeFileRef(ref)` and `normalizeFileValue(value)` (core): a file (or a cell value with
  files) in the new shape.
- Example `/catalog` (models with a photo folder; units that pick a model through a lookup).
- Design proposal **SB-40, formula columns in JS** (`docs/01-diseno.md` §4.6). **Proposal only:
  not implemented.**

### Deprecated

- **The Spanish `FileRef` shape `{ url, nombre, tipo, tamano }`** (`LegacyFileRef`). It is still
  read everywhere, so values stored with 0.1.3 or earlier keep working: cells show them,
  folder thumbnails use them, `isFileRef`, `toFileRef` and `fileRefsOf` accept them, validation
  passes them and comparisons treat both shapes of the same file as equal (no false conflicts).
  It is removed in the next major version. To migrate stored data, read each value with
  `toFileRef` / `fileRefsOf` (they return the new shape) and write it back.
