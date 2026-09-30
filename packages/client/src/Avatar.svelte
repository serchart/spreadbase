<!--
@component
La miniatura de las celdas (SB-29) fuera de la hoja: la cabecera de una ficha,
una tarjeta, un menú. Mismo respaldo que en la celda: foto → iniciales → ícono.

```svelte
<Avatar text={asesor.name} image={asesor.avatar_url} initials size={28} />
<Avatar text={cliente.name} initials shape="square" />
```
-->
<script lang="ts">
	import type { AvatarSpec } from '@spreadbase/core';
	import { avatarNode } from './avatar';
	import './datagrid.css';

	interface Props extends Omit<AvatarSpec, 'image'> {
		/** A quién representa: da las iniciales y el color. */
		text: string;
		/** URL de la foto. */
		image?: string | null;
		/** Lado en píxeles. Default: el de la celda (20). */
		size?: number;
		class?: string;
	}

	let { text, image = null, initials, icon, shape, size, class: className = '' }: Props = $props();

	let host = $state<HTMLSpanElement>();
	$effect(() => {
		if (!host) return;
		const node = avatarNode({ initials, icon, shape }, text, image);
		if (node) node.style.margin = '0';
		host.replaceChildren(...(node ? [node] : []));
	});
</script>

<span
	bind:this={host}
	class="sb-avatar inline-flex shrink-0 {className}"
	style:--dg-avatar-size={size ? `${size}px` : undefined}
	style:font-size={`${Math.round((size ?? 20) * 0.42)}px`}
	aria-hidden="true"
></span>
