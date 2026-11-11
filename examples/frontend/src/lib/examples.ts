/** Los ejemplos: el índice y la navegación leen de aquí. */
export const EXAMPLES = [
	{
		href: '/showcase',
		title: 'Vitrina',
		tag: 'memoria · todos los tipos · 10 000 filas',
		text: 'Una hoja de clientes con un campo de cada tipo —avatar, selects, moneda, lookup del responsable, casilla, fecha y fecha-hora— sobre 10 000 filas en memoria. Es la de las capturas del README: no necesita base de datos.',
		code: 'examples/backend/src/examples/showcase/'
	},
	{
		href: '/basic',
		title: 'Básico',
		tag: 'memoria · sheetRouter',
		text: 'Una hoja de contactos en memoria. Lo mínimo en cada lado: la hoja con sheetRouter en el backend y new Sheet(url) en el frontend.',
		code: 'examples/backend/src/examples/basic/'
	},
	{
		href: '/stages',
		title: 'Etapas e íconos',
		tag: 'avatar.iconField · Option.icon · SB-39',
		text: 'Una hoja de casos cuya «Etapa» (lookup) muestra el ícono de la etapa elegida, tomado de un campo; «Prioridad» con un ícono por opción y el folio de la fila en el botón que abre el detalle. Incluye la misma hoja con una fuente remota escrita a mano.',
		code: 'examples/backend/src/examples/stages/'
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
		href: '/imports',
		title: 'Importar',
		tag: 'SheetImport · importFormat · SB-34',
		text: 'Contactos desde un Excel o CSV a la hoja del ejemplo básico: la vista previa editable, emparejar encabezados por nombre o alias, revisar en el servidor (lo que encuentra se marca en la celda) y aplicar.',
		code: 'examples/backend/src/examples/imports/'
	},
	{
		href: '/import-assistant',
		title: 'Asistente de importación',
		tag: 'ImportAssistant · importAgent · SB-36',
		text: 'Suelta archivos o carpetas (PDF, fotos, Excel, CSV, zip) sobre la tabla «Planes GMF»: un agente analiza cada uno, propone a dónde va y sus filas, conversa contigo y lo importa en segundo plano. Las filas con error se corrigen en el Detalle.',
		code: 'examples/backend/src/examples/import-assistant/'
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
