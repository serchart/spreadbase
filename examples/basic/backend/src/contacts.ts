/** Contactos de ejemplo, siempre los mismos (semilla fija). */
const FIRST = ['Ana', 'Luis', 'María', 'Jorge', 'Sofía', 'Carlos', 'Lucía', 'Diego', 'Elena', 'Pablo'];
const LAST = ['García', 'López', 'Martínez', 'Hernández', 'Pérez', 'Sánchez', 'Ramírez', 'Torres'];
const STATUSES = ['lead', 'active', 'inactive'];

function random(seed: number) {
	return () => {
		seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
		return seed / 2 ** 31;
	};
}

export function generateContacts(count: number) {
	const rand = random(42);
	const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)]!;
	return Array.from({ length: count }, (_, i) => {
		const first = pick(FIRST);
		const last = pick(LAST);
		return {
			id: `c_${String(i + 1).padStart(5, '0')}`,
			name: `${first} ${last}`,
			email: `${first}.${last}${i + 1}@ejemplo.com`.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, ''),
			status: pick(STATUSES),
			credit_limit: Math.round(rand() * 200) * 500,
			since: new Date(Date.UTC(2020, 0, 1) + Math.floor(rand() * 2_000) * 86_400_000).toISOString().slice(0, 10)
		};
	});
}
