<!--
@component
Un campo de formulario con una columna de SpreadBase (SB-25): etiqueta,
control y mensaje, con daisyUI (`fieldset`).

El control es el de la celda:
- **fecha, lista, `lookup`, imagen, contraseña**: el **mismo editor** que abre la
  hoja (calendario, lista filtrable, mini tabla paginada…), anclado al campo.
  El campo hace de anfitrión: el editor le pide cerrar igual que se lo pide a
  jspreadsheet, y el campo se queda con el valor;
- **texto y número**: un `input`, interpretado y validado con el mismo tipo;
- **casilla**: un `checkbox`.

Las reglas son las del tipo de celda (`validate`); el error aparece al dejar el
campo o con `form.touchAll()`.

```svelte
<Field {form} name="customer_id" />
<Field {form} name="start_date" hint="Día en que empieza a contar el plazo" />
```
-->
<script lang="ts">
	import { fileNameOf } from '@spreadbase/core';
	import Avatar from './Avatar.svelte';
	import { getCellType } from './cellTypes';
	import type { FormState } from './FormState.svelte';
	import type { CellValue } from './types';
	import './datagrid.css';

	interface Props {
		form: FormState;
		/** Campo: una clave del `initial` del formulario. */
		name: string;
		/** Etiqueta propia; por defecto la de la columna. */
		label?: string;
		/** Una línea de ayuda bajo el control, mientras no haya error. */
		hint?: string;
		placeholder?: string;
		class?: string;
	}

	let { form, name, label, hint, placeholder, class: className = '' }: Props = $props();

	/** Un editor de celda: lo que devuelve `toColumn().type` en los tipos con editor propio. */
	interface CellEditor {
		openEditor: (cell: HTMLElement, value: CellValue, x: number, y: number, host: unknown) => void;
		closeEditor: (cell: HTMLElement, save: boolean) => CellValue;
	}

	const column = $derived(form.column(name));
	const type = $derived(column ? getCellType(column.type) : null);
	const id = `sb-field-${Math.random().toString(36).slice(2, 9)}`;

	/** El editor de la celda para este tipo, o `null` si el control es nativo. */
	const editor = $derived.by((): CellEditor | null => {
		// Texto: siempre un `input`, aunque en la hoja lleve miniatura (SB-29).
		if (!column || !type || column.type === 'boolean' || column.type === 'text') return null;
		const native = type.toColumn(column, form.context).type as unknown;
		return native && typeof native === 'object' && 'openEditor' in native ? (native as CellEditor) : null;
	});

	const error = $derived(form.shownError(name));
	/** Sin valor ni `placeholder`: qué se puede hacer con el campo. */
	const emptyText = $derived(
		column?.type === 'image'
			? column.upload
				? 'Sin imagen · pega una URL o súbela'
				: 'Sin imagen · pega una URL'
			: column?.type === 'file'
				? column.upload
					? 'Sin archivo · pega una URL o súbelo'
					: 'Sin archivo · pega una URL'
				: ''
	);
	const disabled = $derived(!!column?.readOnly);

	// -- controles con editor de celda --------------------------------------------------

	let anchor = $state<HTMLElement>();
	let open = $state(false);

	/**
	 * Abre el editor de la celda anclado al campo. El editor pinta su valor en la
	 * «celda» al cerrar: aquí esa celda es un elemento suelto, porque lo visible
	 * es el campo.
	 */
	function openEditor(seed?: string) {
		if (!editor || !anchor || disabled || open) return;
		const scratch = document.createElement('td');
		const host = {
			closeEditor: (_cell: HTMLElement, save: boolean) => {
				const value = editor.closeEditor(scratch, save);
				open = false;
				if (save) form.set(name, value);
				form.touch(name);
				anchor?.focus();
			}
		};
		open = true;
		editor.openEditor(anchor, form.values[name] ?? null, 0, 0, host);
		// Lo tecleado con el campo cerrado es el principio de la búsqueda o de la fecha.
		const typed = document.activeElement;
		if (seed && typed instanceof HTMLInputElement) {
			typed.value = seed;
			typed.dispatchEvent(new Event('input', { bubbles: true }));
		}
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'F2') {
			e.preventDefault();
			openEditor();
		} else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
			e.preventDefault();
			openEditor(e.key);
		} else if ((e.key === 'Backspace' || e.key === 'Delete') && !column?.required) {
			form.set(name, null);
			form.touch(name);
		}
	}

	// -- texto y número -----------------------------------------------------------------

	/** Lo que se escribe; al salir se reescribe con el formato del tipo. */
	let draft = $state('');
	let editing = $state(false);
	const shown = $derived(editing ? draft : form.display(name));

	function onInput(e: Event) {
		draft = (e.target as HTMLInputElement).value;
		if (column && type) form.set(name, type.parse(draft, column));
	}
</script>

{#if column}
	<fieldset class="fieldset {className}">
		<legend class="fieldset-legend">{label ?? column.label}</legend>

		{#if column.type === 'boolean'}
			<label class="flex items-center gap-2">
				<input
					type="checkbox"
					aria-label={label ?? column.label}
					class="checkbox checkbox-sm"
					checked={form.values[name] === true}
					{disabled}
					onchange={(e) => (form.set(name, (e.target as HTMLInputElement).checked), form.touch(name))}
				/>
				<!-- El título ya lo dice la leyenda: aquí, el valor. -->
				<span class="text-sm">{form.values[name] === true ? 'Sí' : 'No'}</span>
			</label>
		{:else if editor}
			<!-- El campo muestra el valor; el control es el editor de la celda. -->
			<div
				bind:this={anchor}
				{id}
				role="button"
				tabindex={disabled ? -1 : 0}
				aria-expanded={open}
				aria-haspopup="dialog"
				aria-describedby={error || hint ? `${id}-msg` : undefined}
				aria-disabled={disabled || undefined}
				aria-label={label ?? column.label}
				class="input w-full cursor-pointer"
				class:input-error={!!error}
				class:input-disabled={disabled}
				onclick={() => openEditor()}
				onkeydown={onKeydown}
			>
				<!-- Imagen: su miniatura; imagen y archivo: su nombre, no la URL (SB-30). -->
				<!-- `lookup` con `avatar`: la foto, iniciales o ícono del elegido, como en la celda (SB-29). -->
				{#if column.avatar && column.type === 'lookup' && form.values[name] != null && form.display(name)}
					<Avatar text={form.display(name)} image={form.imageOf(name)} initials={column.avatar.initials} icon={column.avatar.icon} shape={column.avatar.shape} />
				{/if}
				{#if column.type === 'image' && typeof form.values[name] === 'string' && form.values[name]}
					<img src={String(form.values[name])} alt="" class="rounded-field size-6 shrink-0 object-cover" />
				{/if}
				<span class="min-w-0 flex-1 truncate" class:opacity-50={!form.values[name]}>
					{(column.type === 'image' && form.values[name] ? fileNameOf(String(form.values[name])) : form.display(name)) || placeholder || emptyText}
				</span>
				<svg class="size-4 shrink-0 opacity-60" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 10l5 5 5-5z" /></svg>
			</div>
		{:else}
			<input
				{id}
				class="input w-full"
				class:input-error={!!error}
				class:text-right={column.type === 'number'}
				type="text"
				inputmode={column.type === 'number' ? 'decimal' : undefined}
				aria-label={label ?? column.label}
				aria-invalid={error ? 'true' : undefined}
				aria-describedby={error || hint ? `${id}-msg` : undefined}
				maxlength={column.maxLength}
				{placeholder}
				{disabled}
				value={shown}
				onfocus={() => ((draft = form.display(name)), (editing = true))}
				oninput={onInput}
				onblur={() => ((editing = false), form.touch(name))}
			/>
		{/if}

		{#if error}
			<p id="{id}-msg" class="label flex items-center gap-2" role="alert"><span class="status status-error" aria-hidden="true"></span>{error}</p>
		{:else if hint}
			<p id="{id}-msg" class="label">{hint}</p>
		{/if}
	</fieldset>
{/if}
