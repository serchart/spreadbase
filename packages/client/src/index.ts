export { Sheet } from './Sheet.svelte';
export type { SheetOptions } from './Sheet.svelte';
export { applyColumnOverrides } from './columns';
export type { ColumnOverride, ColumnPlacement } from './columns';
export { default as SpreadBase } from './SpreadBase.svelte';
export { default as SpreadsheetGrid } from './SpreadsheetGrid.svelte';
export { default as Toolbar } from './Toolbar.svelte';
// Formularios con las columnas y los editores de la hoja (SB-25).
export { default as Field } from './Field.svelte';
export { FormState } from './FormState.svelte';
export type { FormStateOptions } from './FormState.svelte';
// Un registro de una hoja como formulario guardable: la ficha de una entidad (SB-32).
export { RecordForm } from './RecordForm.svelte';
export type { RecordFormOptions } from './RecordForm.svelte';
export { GridController } from './GridController.svelte';
export type { CellWrite } from './GridController.svelte';
export { registerCellType, getCellType, listCellTypes } from './cellTypes';
export { SpreadBaseApiError } from './remote';
// Miniaturas en celdas de texto y lookup (SB-29).
export { registerIcons, initialsOf } from './avatar';
export { default as Avatar } from './Avatar.svelte';
export type * from './types';
