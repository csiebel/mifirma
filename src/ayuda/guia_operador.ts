// Guía de procedimientos de la consola del operador. Es el único conocimiento del asistente de
// ayuda: describe CÓMO se hace cada cosa en la consola, en pasos. No contiene datos de empresas ni
// de personas. Si se agregan o cambian secciones en operador.html, actualizar esta guía.

export const GUIA_OPERADOR = `# Consola del operador — guía de uso

La consola del operador (operador.html) es el panel interno del proveedor de la plataforma. Tiene
un menú con varias secciones; en cada una se trabaja completando formularios y tocando botones. A
continuación, qué se hace en cada sección y los pasos.

## Navegación
Las secciones disponibles son: Planes y precios, Empresas, Ofertas y beneficios, Solicitudes de
crédito, Firma de recibos, Industrias, Operadores, Auditoría de accesos, Medios de pago, Correo,
SMS / WhatsApp y Etiquetas / Traducciones. Se entra a cada una desde el menú de la consola.

## Planes y precios
Acá se definen los planes comerciales del servicio (lo que se les cobra a las empresas).
- Para crear un plan: completá el formulario "Nuevo plan" con el código, el nombre, la moneda, el
  modo de precio (fijo o por funcionario), el precio, cuántos funcionarios son gratis, el límite de
  funcionarios (si es un plan con tope, como el free tier) y la periodicidad; después guardás.
- Para editar un plan existente: lo seleccionás de la lista, cambiás los valores y guardás.
- El límite de funcionarios es lo que hace que un plan tope la cantidad de empleados: si está
  vacío, el plan no limita; si tiene un número, la empresa no puede pasar de esa cantidad.

## Empresas
Lista de las empresas clientes. Desde acá se administra cada empresa; en particular, se habilita
qué ofertas y beneficios ve cada una (las ofertas se cargan en "Ofertas y beneficios" pero se
prenden empresa por empresa acá).

## Ofertas y beneficios
Es el catálogo global de oferentes (bancos, financieras, comercios) y sus ofertas. Lo que se carga
acá se les muestra a los empleados de las empresas que tengan esas ofertas habilitadas.

Crear un oferente:
1. En el bloque "Oferentes", completá Nombre, Tipo (financiera, banco, comercio u otro) y País
   (dejalo vacío si aplica a todos los países).
2. Tocá "Agregar oferente".

Crear una oferta (una "campaña" hacia los empleados):
1. En el bloque "Ofertas", elegí el Oferente al que pertenece.
2. Elegí el Tipo de oferta: publicidad, venta (de productos o servicios) o financiero.
3. Completá el Título, el País (vacío = todos), la Descripción, el Texto del botón y el Link del
   botón, la vigencia (Vigente desde / hasta) y el Orden.
4. Si la oferta usa datos del empleado, marcá "Requiere consentimiento del empleado".
5. Tocá "Agregar oferta".

Segmentar una oferta (dirigirla a un grupo de personas):
- Cada oferta de la lista tiene opciones para segmentarla por industria/rubro y por franja
  salarial. Abrí esas opciones en la oferta y elegí a qué industrias y a qué rango de salario
  aplica.
- Si no segmentás, la oferta la ven todos los empleados de las empresas que la tengan habilitada.
- Para que finalmente se muestre, la oferta tiene que estar habilitada en la empresa (eso se hace
  en la pestaña Empresas).

En resumen, para armar una campaña dirigida: creás (o elegís) el oferente, creás la oferta, la
segmentás por industria y/o franja salarial, y la habilitás en las empresas que correspondan.

## Solicitudes de crédito
Son las solicitudes que hacen los empleados sobre ofertas financieras. La decisión la toma el
prestador; el operador las aprueba o rechaza en su nombre.
- Para rechazar: tocás Rechazar y podés dejar un motivo.
- Para aprobar: tocás Aprobar e ingresás la tasa mensual (en %, por ejemplo 5 = 5% por mes) y la
  fecha de la primera cuota. Al aprobar se genera el préstamo y su cronograma de cuotas (sistema
  de cuota fija). Si el empleado consintió el descuento por recibo, la cuota se descuenta sola en
  su liquidación, mes a mes.
- "Ver cuotas" muestra el cronograma completo del préstamo (capital, interés, cuota, saldo).

## Firma de recibos
Configuración de los proveedores de firma digital de los recibos.

## Industrias / rubros
Catálogo de industrias o rubros. Sirve para clasificar empresas y para segmentar ofertas por
industria.

## Operadores
Gestión de los usuarios operadores de la plataforma. Para crear uno nuevo, completás el formulario
"Nuevo operador" con sus datos y sus capacidades, y guardás.

## Auditoría de accesos
Registro de quién accedió a qué y cuándo. Es de consulta.

## Medios de pago
Configuración de las pasarelas de pago que se usan para cobrarle el servicio a las empresas.

## Correo / Email
Configuración del servicio de correo. Tiene un bloque "Enviar prueba" para mandar un correo de
prueba y verificar que la configuración funciona.

## SMS / WhatsApp (Twilio)
Configuración de Twilio para SMS y WhatsApp, con un bloque "Enviar prueba".

## Etiquetas / Traducciones
Edición de los textos y traducciones de la interfaz.

## Cambiar contraseña
Para cambiar la contraseña del propio operador.
`;
