/**
 * Datos de la vitrina: un equipo comercial y 10 000 clientes, siempre los
 * mismos (semilla fija). En inglés: son los que salen en las capturas del README.
 */

const FIRST = ['Olivia', 'Liam', 'Emma', 'Noah', 'Ava', 'Lucas', 'Mia', 'Ethan', 'Sofia', 'Mateo', 'Isabella', 'Leo', 'Chloe', 'Daniel', 'Zoe', 'Hugo', 'Aria', 'Elena', 'Marco', 'Nora'];
const LAST = ['Smith', 'García', 'Johnson', 'Martínez', 'Brown', 'Rossi', 'Müller', 'Silva', 'Taylor', 'Nguyen', 'Kim', 'López', 'Wilson', 'Dubois', 'Moore', 'Kowalski'];
const COMPANY_A = ['Blue', 'North', 'Bright', 'Silver', 'Red', 'Green', 'Swift', 'Clear', 'Prime', 'Open', 'Rapid', 'Solid'];
const COMPANY_B = ['Harbor', 'Peak', 'Labs', 'Works', 'Logic', 'Field', 'Stack', 'Forge', 'Point', 'Wave', 'Cloud', 'Bridge'];
const PLANS = ['free', 'starter', 'pro', 'enterprise'];
const STATUSES = ['lead', 'trial', 'active', 'churned'];
const PRICE: Record<string, number> = { free: 0, starter: 29, pro: 99, enterprise: 499 };
const COLORS = ['#6366f1', '#0ea5e9', '#14b8a6', '#22c55e', '#eab308', '#f97316', '#ef4444', '#ec4899', '#a855f7', '#64748b'];

function random(seed: number) {
	return () => {
		seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
		return seed / 2 ** 31;
	};
}

/** Un avatar con iniciales, como data URI: sin red y sin archivos. */
export function avatar(name: string, color: string): string {
	const initials = name
		.split(' ')
		.map((w) => w[0])
		.slice(0, 2)
		.join('')
		.normalize('NFD')
		.replace(/\p{Diacritic}/gu, '');
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill="${color}"/><text x="20" y="25" font-family="Arial,sans-serif" font-size="15" font-weight="600" fill="#fff" text-anchor="middle">${initials}</text></svg>`;
	return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^a-z]/g, '');

export type TeamMember = {
	id: string;
	name: string;
	email: string;
	avatar: string;
};

/** Los responsables de cuenta: lo que elige la columna «Account owner» (lookup). */
export function generateTeam(count = 40): TeamMember[] {
	const rand = random(7);
	const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)]!;
	return Array.from({ length: count }, (_, i) => {
		const name = `${pick(FIRST)} ${pick(LAST)}`;
		return {
			id: `usr_${String(i + 1).padStart(3, '0')}`,
			name,
			email: `${slug(name.split(' ')[0]!)}@acme.dev`,
			avatar: avatar(name, COLORS[i % COLORS.length]!)
		};
	});
}

export function generateCustomers(count: number, team: TeamMember[]) {
	const rand = random(42);
	const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)]!;
	const day = 86_400_000;
	const start = Date.UTC(2023, 0, 1);
	return Array.from({ length: count }, (_, i) => {
		const first = pick(FIRST);
		const last = pick(LAST);
		const name = `${first} ${last}`;
		const company = `${pick(COMPANY_A)}${pick(COMPANY_B)}`;
		const plan = pick(PLANS);
		const status = plan === 'free' ? pick(['lead', 'trial', 'churned']) : pick(STATUSES);
		const seats = plan === 'free' ? 1 : 1 + Math.floor(rand() * (plan === 'enterprise' ? 400 : 40));
		const signedUp = start + Math.floor(rand() * 1_000) * day;
		const lastSeen = signedUp + Math.floor(rand() * 200) * day + Math.floor(rand() * 1_440) * 60_000;
		return {
			id: `cus_${String(i + 1).padStart(5, '0')}`,
			avatar: avatar(name, COLORS[i % COLORS.length]!),
			name,
			company,
			email: `${slug(first)}.${slug(last)}@${company.toLowerCase()}.com`,
			plan,
			status,
			mrr: status === 'active' ? PRICE[plan]! * seats : 0,
			seats,
			owner_id: pick(team).id,
			verified: rand() > 0.3,
			signed_up: new Date(signedUp).toISOString().slice(0, 10),
			last_seen: new Date(Math.min(lastSeen, Date.UTC(2026, 9, 1))).toISOString().slice(0, 16).replace('T', ' ')
		};
	});
}
