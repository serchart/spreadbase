<!--
	PanelButton — botón que abre un panel lateral de la hoja (Filtros, Cambios…).

	Compacto por defecto: icono y badges. Expandido muestra además su nombre.
	**Quién se expande lo decide el contenedor**, porque es una regla del grupo:
	solo uno a la vez. El que tiene el hover (o el foco de teclado) gana; si
	ninguno lo tiene, se expande el activo. Así, al pasar a otro botón el activo
	se comprime —sin perder su color encendido, `btn-neutral`— y recupera su
	tamaño al salir. El botón solo avisa de hover y foco con `onhover`.

	La expansión ocurre **en el flujo**: el botón crece y empuja a sus vecinos,
	con la animación de tamaño que §2.6 reserva a lo que empuja contenido.

	Publica dos medidas, `compactWidth` y `fullWidth`, tomadas de copias
	invisibles. La toolbar las usa para reservar de antemano el espacio de una
	expansión: sin esa reserva, cada hover estrecharía el grupo de edición y
	mandaría botones al menú ⋮ y de vuelta mientras dura la animación.
-->
<script lang="ts">
	import type { Component, Snippet } from 'svelte';

	interface Props {
		icon: Component<{ size?: number; 'aria-hidden'?: boolean | 'true' | 'false' }>;
		label: string;
		active: boolean;
		title?: string;
		onclick: () => void;
		/** Expandido (icono, nombre y badges) o compacto (icono y badges). */
		expanded: boolean;
		/**
		 * Avisa al contenedor de que el puntero se mueve sobre el botón o de que
		 * el foco entra (`true`) o sale (`false`). La salida del puntero no se
		 * avisa aquí: la detecta el grupo con `pointerleave`.
		 */
		onhover: (inside: boolean) => void;
		/** Contadores tras el icono. Recibe si el botón va expandido, para variar su contenido. */
		badges?: Snippet<[expanded: boolean]>;
		compactWidth?: number;
		fullWidth?: number;
	}

	let {
		icon: Icon,
		label,
		active,
		title,
		onclick,
		expanded,
		onhover,
		badges,
		compactWidth = $bindable(0),
		fullWidth = $bindable(0)
	}: Props = $props();
</script>

{#snippet content(open: boolean)}
	<Icon size={16} aria-hidden="true" />
	<span
		class="overflow-hidden whitespace-nowrap transition-[max-width,opacity,margin] duration-(--oc-t-base) ease-(--oc-ease)
			{open ? 'ml-2 max-w-40 opacity-100' : 'ml-0 max-w-0 opacity-0'}"
	>
		{label}
	</span>
	{#if badges}
		<span class="ml-2 flex items-center gap-1">{@render badges(open)}</span>
	{/if}
{/snippet}

<div class="relative shrink-0">
	<!-- Copias de medición: fuera del flujo, no ocupan sitio ni reciben eventos. -->
	<div class="pointer-events-none invisible absolute top-0 left-0 flex" aria-hidden="true" inert>
		<span class="btn btn-sm gap-0" bind:offsetWidth={compactWidth}>{@render content(false)}</span>
		<span class="btn btn-sm gap-0" bind:offsetWidth={fullWidth}>{@render content(true)}</span>
	</div>

	<!--
		`onmousedown` con `preventDefault`: el botón no toma el foco, y así
		jspreadsheet no descarta su selección al hacer clic fuera de la tabla.

		El hover se toma de `pointermove` **con desplazamiento real**, no de
		`mouseenter`. Al expandirse un botón sus vecinos se desplazan, y el
		navegador dispara `mouseenter` en el que queda bajo un cursor quieto: ese
		botón se expandía, todo volvía a moverse y la barra temblaba. Así solo
		cambia cuando el usuario mueve el mouse. La salida la detecta el grupo.
	-->
	<button
		type="button"
		class="btn btn-sm gap-0 {active ? 'btn-neutral' : ''}"
		aria-pressed={active}
		aria-label={label}
		{title}
		onmousedown={(e) => e.preventDefault()}
		onpointermove={(e) => (e.movementX || e.movementY) && onhover(true)}
		onfocus={() => onhover(true)}
		onblur={() => onhover(false)}
		{onclick}
	>
		{@render content(expanded)}
	</button>
</div>
