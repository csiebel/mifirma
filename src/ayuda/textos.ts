// Ayudas de INTERFAZ: explican para qué sirve cada campo y cada opción (uso y
// concepto). Son texto de producto, con vocabulario, SIN cifras ni reglas de
// país: las cifras de cada país no viven acá, salen de pais_parametro (datos
// versionados). Estructurado por secciones y por clave para poder sumar idiomas
// y para enganchar tooltips por campo en la UI.

export interface ItemAyuda {
  clave: string;
  titulo: string;
  texto: string;
}
export interface SeccionAyuda {
  titulo: string;
  items: ItemAyuda[];
}

const SECCIONES_ES: SeccionAyuda[] = [
  {
    titulo: 'Personas y relaciones laborales',
    items: [
      {
        clave: 'persona',
        titulo: 'Persona',
        texto:
          'El ser humano: sus datos van una sola vez (documento, nombre, nacimiento). Una misma persona puede tener varias relaciones laborales, sucesivas o simultáneas.',
      },
      {
        clave: 'relacion_laboral',
        titulo: 'Relación laboral (empleado)',
        texto:
          'El vínculo de una persona con la empresa, lo que solemos llamar "empleado". Lleva su modalidad, tarifa, régimen y cargo, y se historiza: si cambia el sueldo o el puesto queda registro de qué regía en cada fecha.',
      },
      {
        clave: 'cargo',
        titulo: 'Cargo',
        texto: 'El puesto que ocupa la persona dentro de una unidad de la organización.',
      },
      {
        clave: 'establecimiento',
        titulo: 'Establecimiento',
        texto: 'El lugar de trabajo o sucursal. A veces incide en la jurisdicción o en los aportes.',
      },
    ],
  },
  {
    titulo: 'Cómo se calcula el sueldo',
    items: [
      {
        clave: 'modalidad',
        titulo: 'Modalidad de remuneración',
        texto:
          'Define CÓMO se calcula la base a partir de lo que cargás en el período. Mensual: monto fijo prorrateado por días. Jornalero: días trabajados por el valor del jornal. Por hora: horas por el valor hora. A destajo: unidades por la tarifa de cada unidad. Mixto: una parte fija más una variable (comisiones, productividad).',
      },
      {
        clave: 'tarifa',
        titulo: 'Tarifa',
        texto:
          'El número base de la modalidad: el sueldo mensual, el valor del jornal, el valor de la hora o el precio por unidad, según el caso.',
      },
      {
        clave: 'regimen',
        titulo: 'Régimen legal',
        texto:
          'Define bajo QUÉ reglas aporta y tributa el trabajador (general, rural, etc.). Lo establece cada país; combinado con la modalidad describe a cualquier trabajador sin multiplicar los casos.',
      },
      {
        clave: 'vigente_desde',
        titulo: 'Vigente desde',
        texto:
          'Desde qué fecha rige esta versión de la relación (este sueldo, este cargo). Los cambios no borran el pasado: se conserva qué regía en cada período para poder liquidar y recalcular bien.',
      },
    ],
  },
  {
    titulo: 'Novedades y ausencias del período',
    items: [
      {
        clave: 'novedad',
        titulo: 'Novedad',
        texto:
          'Los insumos del período que alimentan el cálculo: horas extra, comisiones, días trabajados, premios, descuentos puntuales. Qué novedades hacen falta depende de la modalidad.',
      },
      {
        clave: 'ausencia_licencia',
        titulo: 'Ausencia / licencia',
        texto:
          'Períodos de inasistencia tipificados (licencia, enfermedad, etc.). Según el tipo y las reglas del país, inciden en lo que se paga.',
      },
      {
        clave: 'ausentismo',
        titulo: 'Ausentismo y horas',
        texto:
          'Faltas, llegadas tarde y horas reducidas que ajustan la base antes de calcular los aportes. Las horas extra del período también se cargan acá.',
      },
    ],
  },
  {
    titulo: 'Liquidación y recibos',
    items: [
      {
        clave: 'corrida',
        titulo: 'Corrida de liquidación',
        texto:
          'El proceso que liquida a una población de la empresa para un período. Puede ser mensual, de aguinaldo, de salario vacacional o de liquidación final, según lo que prevea el país.',
      },
      {
        clave: 'recibo',
        titulo: 'Recibo',
        texto:
          'El resultado por persona. Una vez emitido es inmutable: guarda los valores ya resueltos. Si mañana cambia una tabla, el recibo del mes pasado sigue siendo el de ese mes.',
      },
      {
        clave: 'retenciones',
        titulo: 'Retenciones',
        texto:
          'Descuentos que se aplican al neto en un orden de prioridad (judiciales, préstamos, etc.), respetando el tope embargable y el mínimo inembargable que define cada país.',
      },
    ],
  },
  {
    titulo: 'Recursos humanos',
    items: [
      { clave: 'legajo', titulo: 'Legajo', texto: 'La documentación del empleado.' },
      {
        clave: 'estudio_cert',
        titulo: 'Estudios y certificaciones',
        texto: 'Formación, títulos y certificaciones, con su vencimiento. Permite avisar cuando algo está por vencer.',
      },
      {
        clave: 'evaluacion',
        titulo: 'Evaluación de desempeño',
        texto:
          'Ciclos de evaluación y sus resultados. Son datos sensibles: cada quien ve solo lo que su rol y su lugar en el organigrama permiten.',
      },
      {
        clave: 'capacitacion',
        titulo: 'Capacitación',
        texto: 'Catálogo de capacitaciones, inscripciones y registro de quién completó qué.',
      },
    ],
  },
  {
    titulo: 'La plataforma',
    items: [
      {
        clave: 'plan',
        titulo: 'Plan',
        texto:
          'Cuánto paga tu empresa por usar el sistema: un precio fijo, o un precio por funcionario (que puede tener tramos), con una periodicidad (mensual, semestral o anual). Es algo distinto de los sueldos que tu empresa le paga a su gente.',
      },
      {
        clave: 'suscripcion',
        titulo: 'Suscripción',
        texto: 'El vínculo de tu empresa con un plan. En modo prueba todavía no se cobra.',
      },
    ],
  },
  {
    titulo: 'Cómo usar la app (dónde y cómo hacer cada cosa)',
    items: [
      {
        clave: 'uso_navegacion',
        titulo: 'Cómo está organizado el menú',
        texto:
          'El menú de arriba tiene cuatro grupos. Liquidación: Liquidaciones (cargar novedades y conceptos del período y correr la liquidación), Recibos y Retenciones. Personas y RRHH: Empleados, Alta empleado, Legajo, Evaluaciones, Certificaciones, Capacitaciones, Comunicados y Beneficios. Asistencia: Licencias, Solicitudes y Ausentismo y horas. Configuración: Suscripción, Integración, Empresa, Recibo (plantilla), Conceptos de liquidación, Usuarios, Roles y Auditoría. Y sueltos: Mi cuenta, Asistente y Ayuda. Lo que ve cada persona depende de sus permisos.',
      },
      {
        clave: 'uso_cargar_novedades',
        titulo: 'Cómo cargar novedades del período',
        texto:
          'Entrá a Liquidación → Liquidaciones. En "Novedades del período" elegí el empleado y el período (AAAA-MM), el tipo (días trabajados, horas, unidades o variable/comisiones) y la cantidad, y tocá "Cargar novedad". Hay una novedad por tipo y período: si volvés a cargar el mismo tipo, reemplaza el valor anterior.',
      },
      {
        clave: 'uso_cargar_horas',
        titulo: 'Cómo cargar horas',
        texto:
          'Depende de qué horas. Las horas trabajadas de un empleado remunerado por hora van como novedad de tipo "Horas" en Liquidación → Liquidaciones. Las horas extra, las faltas, las tardanzas (en minutos) y las horas a descontar van en Asistencia → "Ausentismo y horas", por empleado y período. Todo eso se aplica solo cuando corrés la liquidación del período.',
      },
      {
        clave: 'uso_conceptos_liq',
        titulo: 'Cómo agregar un premio, un viático o un descuento',
        texto:
          'En Liquidación → Liquidaciones, en "Conceptos de liquidación del período", elegí el empleado y el período de arriba, después el concepto (premio, viático, descuento, etc.), el monto y una nota opcional, y tocá "Agregar concepto". El catálogo de conceptos se define en Configuración → Conceptos de liquidación: cada concepto es de tipo suma (devengo) o resta (deducción) y, si suma, puede ser gravado o no. El monto se carga siempre en positivo; el signo lo pone el tipo del concepto.',
      },
      {
        clave: 'uso_correr_liquidacion',
        titulo: 'Cómo correr la liquidación',
        texto:
          'En Liquidación → Liquidaciones, en "Correr liquidación del período", elegí el período y tocá "Correr liquidación": se generan los recibos del período con las novedades, el ausentismo y los conceptos cargados. Desde el mismo lugar podés correr el aguinaldo, el salario vacacional y la liquidación final por despido. Los recibos quedan en Recibos.',
      },
      {
        clave: 'uso_ver_recibo',
        titulo: 'Cómo ver o descargar un recibo',
        texto:
          'En Liquidación → Recibos ves los recibos ya calculados del período según tu alcance. Cada recibo se puede abrir en PDF y, si está emitido, enviar al empleado. El empleado también ve y firma sus recibos desde su propio portal.',
      },
      {
        clave: 'uso_alta_empleado',
        titulo: 'Cómo dar de alta un empleado',
        texto:
          'En Personas y RRHH → Alta empleado cargás los datos: nombre, documento, cargo, si es empleado dependiente o proveedor unipersonal, la modalidad (mensual, jornalero, por hora, a destajo o mixto), la tarifa y la fecha de ingreso. Una vez creado aparece en Empleados.',
      },
      {
        clave: 'uso_licencias',
        titulo: 'Cómo manejar licencias',
        texto:
          'En Asistencia → Licencias registrás y ves las licencias, y consultás el saldo de un empleado. Los empleados también pueden pedir licencias desde su portal, y las solicitudes te llegan a Asistencia → Solicitudes para aprobarlas o rechazarlas.',
      },
      {
        clave: 'uso_asistente',
        titulo: 'Qué es el Asistente',
        texto:
          'El Asistente responde en lenguaje natural: podés pedirle recibos, saldos de licencia, vencimientos de certificaciones y demás datos (siempre dentro de lo que tu usuario puede ver), y también consultarle dudas de uso como esta. No inventa cifras: las trae del sistema.',
      },
    ],
  },
  {
    titulo: 'Remuneración variable',
    items: [
      {
        clave: 'variable',
        titulo: 'Qué es la remuneración variable',
        texto:
          'El módulo donde definís los esquemas de incentivo de la empresa: sueldo variable, comisiones y bonos por objetivos. Vive en RRHH. Un plan agrupa objetivos y una curva, se asigna a empleados y cada mes se mide el resultado; al cerrar el período el sistema calcula el monto, que se vuelca como un concepto de la liquidación. El monto lo calcula el sistema, no se carga a mano.',
      },
      {
        clave: 'variable_plan',
        titulo: 'Plan',
        texto:
          'Un esquema de incentivo. Agrupa uno o varios objetivos y una curva de pago. Por ejemplo "Comisiones de ventas" o "Bono anual por desempeño".',
      },
      {
        clave: 'variable_objetivo',
        titulo: 'Objetivo',
        texto:
          'Lo que se busca lograr dentro de un plan. Puede ser cuantitativo (una meta numérica, por ejemplo ventas) o cualitativo (se evalúa por logros). Su método es meta + curva (el cumplimiento entra a la curva) o tasa directa (una comisión sobre una base, sin curva). Tiene un peso, que es cuánto del variable representa, y paga a través de un concepto de liquidación que elegís.',
      },
      {
        clave: 'variable_logro',
        titulo: 'Logro',
        texto:
          'Para los objetivos cualitativos: cada uno de los puntos concretos que se evalúan, con su peso. En el período marcás cuáles se cumplieron, y el cumplimiento sale de la suma de los pesos cumplidos sobre el total.',
      },
      {
        clave: 'variable_curva',
        titulo: 'Curva de pago',
        texto:
          'Traduce el porcentaje de cumplimiento en cuánto se paga: tramos, cada uno con un factor (por ejemplo, por debajo de cierto nivel no paga, al alcanzarlo paga una parte y superado paga el total). La definís en el plan; el sistema aplica el tramo que corresponde al cumplimiento alcanzado.',
      },
      {
        clave: 'variable_asignacion',
        titulo: 'Asignación',
        texto:
          'Vincula un plan a un empleado, con su "variable al 100%": lo que cobraría si cumpliera todo. En planes que son solo comisión puede ir en cero. Un empleado puede tener más de un plan.',
      },
      {
        clave: 'variable_periodo',
        titulo: 'Período (medición)',
        texto:
          'La medición de un objetivo de una asignación en un mes. Pasa por tres estados: abierto (cargás el resultado o marcás los logros), cerrado (el sistema calcula el cumplimiento y el monto) y liquidado (el monto se volcó a la liquidación). Podés reabrir un período para corregir.',
      },
      {
        clave: 'variable_volcado',
        titulo: 'Volcado a la liquidación',
        texto:
          'Al volcar un período cerrado, su monto entra al recibo del empleado como un concepto de liquidación de ese mes. La empresa elige quién lo hace: "RRHH cierra y vuelca" o "RRHH cierra; nómina vuelca". RRHH siempre cierra; quién puede volcar depende de esa política. El empleado ve el variable ya pagado en su recibo.',
      },
      {
        clave: 'variable_como',
        titulo: 'Cómo cargar y pagar el variable',
        texto:
          'Entrá a Remuneración variable. Creá un plan y agregale objetivos y la curva. Abrí el plan, asigná los empleados con su variable al 100% y tocá "Períodos" en cada uno. Abrí el mes de un objetivo, cargá el resultado (o marcá los logros) y cerralo: el sistema calcula el monto. Después volcalo para que entre en la liquidación de ese período.',
      },
    ],
  },
];

// Glosario de los PARÁMETROS del país: nombre legible y cómo mostrar el valor.
// El VALOR siempre sale de pais_parametro; acá sólo está la etiqueta y el
// formato de presentación (vocabulario, no cifras).
export interface EntradaGlosario {
  etiqueta: string;
  formato: 'pct' | 'monto';
}
const GLOSARIO: Record<string, EntradaGlosario> = {
  // Uruguay
  jub_personal: { etiqueta: 'Aporte jubilatorio — personal', formato: 'pct' },
  jub_patronal: { etiqueta: 'Aporte jubilatorio — patronal', formato: 'pct' },
  fonasa_patronal: { etiqueta: 'FONASA (salud) — patronal', formato: 'pct' },
  frl_personal: { etiqueta: 'Fondo de Reconversión Laboral — personal', formato: 'pct' },
  frl_patronal: { etiqueta: 'Fondo de Reconversión Laboral — patronal', formato: 'pct' },
  tope_jubilatorio: { etiqueta: 'Tope de aportación jubilatoria', formato: 'monto' },
  // Paraguay
  ips_personal: { etiqueta: 'Aporte IPS — personal', formato: 'pct' },
  ips_patronal: { etiqueta: 'Aporte IPS — patronal', formato: 'pct' },
  // Comunes
  tope_embargo_pct: { etiqueta: 'Tope embargable del sueldo', formato: 'pct' },
  minimo_inembargable: { etiqueta: 'Mínimo inembargable', formato: 'monto' },
  recargo_hora_extra: { etiqueta: 'Recargo de hora extra', formato: 'pct' },
  // Paquete de ejemplo (XX)
  renta_tasa: { etiqueta: 'Tasa de renta (ejemplo)', formato: 'pct' },
  renta_minimo_no_imponible: { etiqueta: 'Mínimo no imponible (ejemplo)', formato: 'monto' },
  valor_hora_base: { etiqueta: 'Valor hora base (ejemplo)', formato: 'monto' },
  aporte_personal: { etiqueta: 'Aporte personal (ejemplo)', formato: 'pct' },
  aporte_patronal: { etiqueta: 'Aporte patronal (ejemplo)', formato: 'pct' },
};

// Nombre legible de los grupos de tramos (franjas) del país.
const GRUPOS_TRAMO: Record<string, string> = {
  irpf: 'IRPF — franjas del impuesto a la renta',
  fonasa: 'FONASA — escalones del aporte personal a la salud',
  irp: 'IRP — franjas del impuesto a la renta personal',
};

export const SECCIONES_EN: SeccionAyuda[] = [
  {
    titulo: 'People and employment relationships',
    items: [
      { clave: 'persona', titulo: 'Person', texto: 'The human being: their data is stored once (ID, name, birth date). One person can hold several employment relationships, successive or simultaneous.' },
      { clave: 'relacion_laboral', titulo: 'Employment relationship', texto: 'A person’s link to the company — what we usually call an "employee". It carries the mode, rate, regime and position, and is kept historized: if salary or role changes, there is a record of what applied on each date.' },
      { clave: 'cargo', titulo: 'Position', texto: 'The role the person holds within an organizational unit.' },
      { clave: 'establecimiento', titulo: 'Workplace', texto: 'The workplace or branch. It sometimes affects jurisdiction or contributions.' },
    ],
  },
  {
    titulo: 'How the salary is calculated',
    items: [
      { clave: 'modalidad', titulo: 'Pay mode', texto: 'Defines HOW the base is computed from what you enter for the period. Monthly: fixed amount prorated by days. Daily: days worked times the daily rate. Hourly: hours times the hourly rate. Piecework: units times the per-unit rate. Mixed: a fixed part plus a variable one (commissions, productivity).' },
      { clave: 'tarifa', titulo: 'Rate', texto: 'The base number of the mode: the monthly salary, the daily rate, the hourly rate or the per-unit price, as applicable.' },
      { clave: 'regimen', titulo: 'Legal regime', texto: 'Defines under WHICH rules the worker contributes and is taxed (general, rural, etc.). Each country sets its own; combined with the mode it describes any worker without multiplying cases.' },
      { clave: 'vigente_desde', titulo: 'Effective from', texto: 'The date this version of the relationship takes effect (this salary, this position). Changes don’t erase the past: what applied in each period is kept, so mifirma and recalculations stay correct.' },
    ],
  },
  {
    titulo: 'Period inputs and absences',
    items: [
      { clave: 'novedad', titulo: 'Input', texto: 'The period inputs that feed the calculation: overtime, commissions, days worked, bonuses, one-off deductions. Which inputs are needed depends on the mode.' },
      { clave: 'ausencia_licencia', titulo: 'Absence / leave', texto: 'Typified periods of absence (leave, sickness, etc.). Depending on the type and the country’s rules, they affect what is paid.' },
      { clave: 'ausentismo', titulo: 'Absences & hours', texto: 'Missed days, lateness and reduced hours that adjust the base before contributions are computed. The period’s overtime is entered here too.' },
    ],
  },
  {
    titulo: 'MiFirma and payslips',
    items: [
      { clave: 'corrida', titulo: 'MiFirma run', texto: 'The process that pays a population of the company for a period. It can be monthly, year-end bonus, holiday pay or final settlement, depending on the country.' },
      { clave: 'recibo', titulo: 'Payslip', texto: 'The per-person result. Once issued it is immutable: it stores the resolved values. If a table changes tomorrow, last month’s payslip stays the same.' },
      { clave: 'retenciones', titulo: 'Garnishments', texto: 'Deductions applied to the net in a priority order (court orders, loans, etc.), respecting the garnishable cap and the unattachable minimum that each country defines.' },
    ],
  },
  {
    titulo: 'Human resources',
    items: [
      { clave: 'legajo', titulo: 'Personnel file', texto: 'The employee’s documentation.' },
      { clave: 'estudio_cert', titulo: 'Studies and certifications', texto: 'Education, degrees and certifications, with their expiry. Enables alerts when something is about to expire.' },
      { clave: 'evaluacion', titulo: 'Performance review', texto: 'Review cycles and their results. This is sensitive data: each person sees only what their role and place in the org chart allow.' },
      { clave: 'capacitacion', titulo: 'Training', texto: 'Catalog of training courses, enrollments and a record of who completed what.' },
    ],
  },
  {
    titulo: 'The platform',
    items: [
      { clave: 'plan', titulo: 'Plan', texto: 'How much your company pays to use the system: a fixed price, or a per-employee price (which may have tiers), with a periodicity (monthly, half-yearly or yearly). This is separate from the salaries your company pays its people.' },
      { clave: 'suscripcion', titulo: 'Subscription', texto: 'Your company’s link to a plan. In trial mode nothing is charged yet.' },
    ],
  },
  {
    titulo: 'Variable pay',
    items: [
      { clave: 'variable', titulo: 'Variable pay', texto: 'Where you define the company’s incentive schemes: variable salary, commissions and bonuses by objective. It lives in HR. A plan groups objectives and a payout curve, is assigned to employees, and each month the result is measured; when the period closes the system computes the amount, which posts to mifirma as a line item. The system computes the amount; you do not type it in.' },
      { clave: 'variable_objetivo', titulo: 'Objective', texto: 'What a plan aims for. Quantitative (a numeric target) or qualitative (scored by achievements). Method is target + curve (attainment feeds the curve) or direct rate (a commission on a base, no curve). It has a weight and pays through a mifirma item you pick.' },
      { clave: 'variable_periodo', titulo: 'Period (measurement)', texto: 'The measurement of one objective for one assignment in a month. States: open (enter the result or mark achievements), closed (the system computes attainment and amount) and settled (the amount posted to mifirma). You can reopen a period to fix it.' },
      { clave: 'variable_volcado', titulo: 'Posting to mifirma', texto: 'Closing computes the amount; posting sends it to the employee’s payslip as a line item. The company chooses who posts: HR closes and posts, or HR closes and mifirma posts. The employee sees the variable already paid on their payslip.' },
    ],
  },
];

export const SECCIONES_PT: SeccionAyuda[] = [
  {
    titulo: 'Pessoas e vínculos de trabalho',
    items: [
      { clave: 'persona', titulo: 'Pessoa', texto: 'O ser humano: seus dados ficam uma vez (documento, nome, nascimento). Uma mesma pessoa pode ter vários vínculos de trabalho, sucessivos ou simultâneos.' },
      { clave: 'relacion_laboral', titulo: 'Vínculo de trabalho', texto: 'O vínculo de uma pessoa com a empresa, o que costumamos chamar de "funcionário". Carrega a modalidade, a tarifa, o regime e o cargo, e é historizado: se o salário ou o cargo mudam, fica o registro do que valia em cada data.' },
      { clave: 'cargo', titulo: 'Cargo', texto: 'O posto que a pessoa ocupa dentro de uma unidade da organização.' },
      { clave: 'establecimiento', titulo: 'Estabelecimento', texto: 'O local de trabalho ou filial. Às vezes influencia a jurisdição ou as contribuições.' },
    ],
  },
  {
    titulo: 'Como o salário é calculado',
    items: [
      { clave: 'modalidad', titulo: 'Modalidade de remuneração', texto: 'Define COMO se calcula a base a partir do que você lança no período. Mensal: valor fixo rateado por dias. Diária: dias trabalhados pelo valor da diária. Por hora: horas pelo valor da hora. Por produção: unidades pela tarifa de cada unidade. Misto: uma parte fixa mais uma variável (comissões, produtividade).' },
      { clave: 'tarifa', titulo: 'Tarifa', texto: 'O número base da modalidade: o salário mensal, o valor da diária, o valor da hora ou o preço por unidade, conforme o caso.' },
      { clave: 'regimen', titulo: 'Regime legal', texto: 'Define sob QUAIS regras o trabalhador contribui e é tributado (geral, rural, etc.). Cada país define os seus; combinado com a modalidade descreve qualquer trabalhador sem multiplicar os casos.' },
      { clave: 'vigente_desde', titulo: 'Vigente a partir de', texto: 'A partir de que data vale esta versão do vínculo (este salário, este cargo). As mudanças não apagam o passado: guarda-se o que valia em cada período para calcular e recalcular corretamente.' },
    ],
  },
  {
    titulo: 'Lançamentos e ausências do período',
    items: [
      { clave: 'novedad', titulo: 'Lançamento', texto: 'Os lançamentos do período que alimentam o cálculo: horas extras, comissões, dias trabalhados, prêmios, descontos pontuais. Quais lançamentos são necessários depende da modalidade.' },
      { clave: 'ausencia_licencia', titulo: 'Ausência / licença', texto: 'Períodos de ausência tipificados (licença, doença, etc.). Conforme o tipo e as regras do país, influenciam o que é pago.' },
      { clave: 'ausentismo', titulo: 'Ausências e horas', texto: 'Faltas, atrasos e horas reduzidas que ajustam a base antes de calcular as contribuições. As horas extras do período também são lançadas aqui.' },
    ],
  },
  {
    titulo: 'Folha e recibos',
    items: [
      { clave: 'corrida', titulo: 'Processamento da folha', texto: 'O processo que processa uma população da empresa para um período. Pode ser mensal, décimo terceiro, férias ou rescisão, conforme o país.' },
      { clave: 'recibo', titulo: 'Recibo', texto: 'O resultado por pessoa. Uma vez emitido é imutável: guarda os valores já resolvidos. Se amanhã mudar uma tabela, o recibo do mês passado continua igual.' },
      { clave: 'retenciones', titulo: 'Penhoras', texto: 'Descontos aplicados ao líquido em uma ordem de prioridade (ordens judiciais, empréstimos, etc.), respeitando o teto penhorável e o mínimo impenhorável que cada país define.' },
    ],
  },
  {
    titulo: 'Recursos humanos',
    items: [
      { clave: 'legajo', titulo: 'Ficha funcional', texto: 'A documentação do funcionário.' },
      { clave: 'estudio_cert', titulo: 'Estudos e certificações', texto: 'Formação, títulos e certificações, com seu vencimento. Permite avisar quando algo está prestes a vencer.' },
      { clave: 'evaluacion', titulo: 'Avaliação de desempenho', texto: 'Ciclos de avaliação e seus resultados. São dados sensíveis: cada pessoa vê apenas o que seu papel e sua posição no organograma permitem.' },
      { clave: 'capacitacion', titulo: 'Treinamento', texto: 'Catálogo de treinamentos, inscrições e registro de quem concluiu o quê.' },
    ],
  },
  {
    titulo: 'A plataforma',
    items: [
      { clave: 'plan', titulo: 'Plano', texto: 'Quanto sua empresa paga para usar o sistema: um preço fixo ou um preço por funcionário (que pode ter faixas), com uma periodicidade (mensal, semestral ou anual). Isso é diferente dos salários que sua empresa paga à sua gente.' },
      { clave: 'suscripcion', titulo: 'Assinatura', texto: 'O vínculo da sua empresa com um plano. Em modo de teste ainda não há cobrança.' },
    ],
  },
  {
    titulo: 'Remuneração variável',
    items: [
      { clave: 'variable', titulo: 'Remuneração variável', texto: 'Onde você define os esquemas de incentivo da empresa: salário variável, comissões e bônus por objetivo. Fica no RH. Um plano agrupa objetivos e uma curva de pagamento, é atribuído a funcionários e a cada mês mede-se o resultado; ao fechar o período o sistema calcula o valor, que é lançado na folha como um conceito. O sistema calcula o valor; não se digita à mão.' },
      { clave: 'variable_objetivo', titulo: 'Objetivo', texto: 'O que um plano busca. Quantitativo (uma meta numérica) ou qualitativo (avaliado por conquistas). O método é meta + curva (o cumprimento entra na curva) ou taxa direta (uma comissão sobre uma base, sem curva). Tem um peso e paga por um conceito de folha que você escolhe.' },
      { clave: 'variable_periodo', titulo: 'Período (medição)', texto: 'A medição de um objetivo de uma atribuição em um mês. Estados: aberto (informe o resultado ou marque conquistas), fechado (o sistema calcula cumprimento e valor) e liquidado (o valor foi lançado na folha). É possível reabrir um período para corrigir.' },
      { clave: 'variable_volcado', titulo: 'Lançamento na folha', texto: 'Fechar calcula o valor; lançar o envia ao recibo do funcionário como um conceito. A empresa escolhe quem lança: RH fecha e lança, ou RH fecha e a folha lança. O funcionário vê o variável já pago no recibo.' },
    ],
  },
];

const SECCIONES: Record<string, SeccionAyuda[]> = {
  es: SECCIONES_ES,
  en: SECCIONES_EN,
  pt: SECCIONES_PT,
  // gn: aún en español hasta tener traducción validada por hablante nativo.
  gn: SECCIONES_ES,
};

export function getAyudas(idioma = 'es') {
  const id = SECCIONES[idioma] ? idioma : 'es';
  // El glosario y los grupos quedan en español (nombres de conceptos y organismos).
  return { idioma: id, secciones: SECCIONES[id], glosario: GLOSARIO, grupos: GRUPOS_TRAMO };
}
