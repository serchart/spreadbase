/** Los ejemplos: el índice y la navegación leen de aquí. */
export const EXAMPLES = [
	{
		href: '/basic',
		title: 'Básico',
		tag: 'memoria · sheetRouter',
		text: 'Una hoja de contactos en memoria. Lo mínimo en cada lado: la hoja con sheetRouter en el backend y new Sheet(url) en el frontend.',
		code: 'examples/backend/src/examples/basic/'
	},
	{
		href: '/postgres',
		title: 'Postgres',
		tag: 'postgresSource · handlers · lookup · todos los tipos',
		text: 'Un catálogo de productos sobre Postgres, con backend JS al estilo de Aggy y un campo de cada tipo. «Responsable» elige entre 2 000 usuarios en una mini tabla paginada. Historial de precios, una regla de negocio y borrado lógico, todo en una transacción por guardado.',
		code: 'examples/backend/src/examples/postgres/'
	},
	{
		href: '/form',
		title: 'Formulario',
		tag: 'Field · FormState · SB-25',
		text: 'Un alta de producto con las columnas de la hoja de Postgres. Cada campo usa el mismo editor y las mismas reglas que su celda: el calendario, la lista y la mini tabla de «Responsable».',
		code: 'examples/frontend/src/routes/form/'
	},
	{
		href: '/ficha',
		title: 'Ficha',
		tag: 'RecordForm · SB-32',
		text: 'Un contacto de la hoja básica como formulario guardable: las columnas editables con sus editores y reglas; guardar manda solo lo cambiado, con la misma concurrencia que la hoja.',
		code: 'examples/frontend/src/routes/ficha/'
	},
	{
		href: '/cases',
		title: 'Casos · 50 000 filas',
		tag: 'capas · ventana · concurrencia',
		text: 'Cartera de cobranza sintética en un módulo en capas (routes → controller → service), con latencia simulada. Es contra la que corren las pruebas E2E.',
		code: 'examples/backend/src/examples/cases/'
	},
	{
		href: '/local',
		title: 'Sin servidor',
		tag: 'new Sheet({ columns, dataSource })',
		text: 'Un ledger de cargos definido en el frontend, con datos en el navegador. Incluye el banco de rendimiento.',
		code: 'examples/frontend/src/routes/local/'
	}
] as const;
