-- Datos sintéticos para los tests de autorización.
-- Se corre como superusuario (bypassa RLS) para poder sembrar.
-- NUNCA usar datos reales de clientes acá. Ver iso-27001.md §5.2.

set app.actor = 'sistema';

insert into plan (id, codigo, nombre_i18n) values
  ('11111111-0000-0000-0000-000000000001', 'basico', '{"es":"Básico"}');

-- Cuenta A (emisora) y cuenta B (la del firmante externo, que después se registró)
insert into cuenta (id, tipo, nombre_mostrado, pais, moneda, plan_id) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'empresa', 'Empresa A', 'UY', 'UYU', '11111111-0000-0000-0000-000000000001'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'empresa', 'Empresa B', 'UY', 'UYU', '11111111-0000-0000-0000-000000000001');

insert into empresa (cuenta_id, razon_social) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Empresa A SA'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Empresa B SA');

-- Identidades
insert into identidad (id, email_normalizado, email_mostrado, estado, nombre_mostrado) values
  ('a0000000-0000-0000-0000-000000000001', 'ana@a.test',    'ana@a.test',    'activa', 'Ana'),
  ('b0000000-0000-0000-0000-000000000001', 'bruno@b.test',  'bruno@b.test',  'activa', 'Bruno'),
  ('e0000000-0000-0000-0000-000000000001', 'maria@ext.test','maria@ext.test','activa', 'María');

insert into anclaje_identidad (id, identidad_id, tipo, valor_normalizado, metodo_prueba, nivel_garantia) values
  ('a1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'email', 'ana@a.test',     'verificacion_email', 'bajo'),
  ('b1000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'email', 'bruno@b.test',   'verificacion_email', 'bajo'),
  ('e1000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'email', 'maria@ext.test', 'verificacion_email', 'bajo');

insert into membresia (identidad_id, cuenta_id) values
  ('a0000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001'),
  ('b0000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001'),
  ('e0000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001');

-- Roles y permisos de carpeta para la cuenta A
insert into rol (id, cuenta_id, codigo, nombre_i18n) values
  ('a2000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'admin', '{"es":"Administrador"}');
insert into usuario_rol (identidad_id, cuenta_id, rol_id) values
  ('a0000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001');

insert into carpeta (id, cuenta_id, nombre_i18n, sistema) values
  ('a3000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', '{"es":"Raíz"}', 'raiz');
insert into carpeta_permiso (carpeta_id, cuenta_id, rol_id, acciones) values
  ('a3000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'a2000000-0000-0000-0000-000000000001', array['ver','leer','crear','enviar','mover','organizar','permisos']);

-- Documento y circuito de la cuenta A
insert into archivo (id, sha256, bytes, mime, clase, cuenta_custodia_id, region, clave_almacenamiento) values
  ('a4000000-0000-0000-0000-000000000001', digest('base','sha256'), 1024, 'application/pdf', 'base',
   'aaaaaaaa-0000-0000-0000-000000000001', 'uy', 'op4q9x7v2mn8');

insert into circuito (id, cuenta_propietaria_id, creado_por_identidad_id, archivo_base_id,
                      titulo, modo, pais_marco, nivel_firma, idioma, estado) values
  ('a5000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'a0000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001',
   'Contrato de prueba', 'serie', 'UY', 'simple', 'es', 'enviado');

insert into ubicacion (cuenta_id, carpeta_id, circuito_id) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001',
   'a5000000-0000-0000-0000-000000000001');

insert into instancia (id, circuito_id, cuenta_propietaria_id, numero, estado) values
  ('a6000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000001', 1, 'en_curso'),
  ('a6000000-0000-0000-0000-000000000002', 'a5000000-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000001', 2, 'firmada');

insert into participacion (id, instancia_id, circuito_id, cuenta_propietaria_id, identidad_id, papel, orden) values
  ('a7000000-0000-0000-0000-000000000001', 'a6000000-0000-0000-0000-000000000001',
   'a5000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'e0000000-0000-0000-0000-000000000001', 'firmante', 1);

-- Otorgamiento a María (firmante externo) sobre la instancia 1
insert into otorgamiento (id, instancia_id, identidad_id, anclaje_destino_id, alcances,
                          origen, cuenta_otorgante_id) values
  ('a8000000-0000-0000-0000-000000000001', 'a6000000-0000-0000-0000-000000000001',
   'e0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001',
   array['metadatos','leer','firmar'], 'participacion', 'aaaaaaaa-0000-0000-0000-000000000001');

-- Otorgamiento irrevocable, para el test 8
insert into otorgamiento (id, instancia_id, identidad_id, alcances, origen,
                          cuenta_otorgante_id, irrevocable) values
  ('a8000000-0000-0000-0000-000000000002', 'a6000000-0000-0000-0000-000000000002',
   'e0000000-0000-0000-0000-000000000001', array['metadatos','leer','evidencia'],
   'participacion', 'aaaaaaaa-0000-0000-0000-000000000001', true);

-- ---------------------------------------------------------------------------
-- Billing y medios de pago (migraciones 012 y 013). Solo cuenta A: los tests
-- verifican que B no ve nada de esto y que el firmante externo tampoco.
-- ---------------------------------------------------------------------------
insert into pasarela_pago (id, proveedor, nombre, modo) values
  ('c0000000-0000-0000-0000-000000000001', 'mercadopago', 'MercadoPago UY', 'sandbox');

insert into medio_pago (id, cuenta_id, tipo, pasarela_id, token_externo, marca,
                        ultimos_cuatro, moneda, es_default) values
  ('c1000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'tarjeta', 'c0000000-0000-0000-0000-000000000001', 'tok_prueba_a', 'visa',
   '4242', 'UYU', true);

insert into suscripcion (id, cuenta_id, plan_id, moneda) values
  ('c2000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   '11111111-0000-0000-0000-000000000001', 'UYU');

insert into factura_plataforma (id, cuenta_id, periodo, plan_id, moneda,
                                monto_neto, monto_total, estado) values
  ('c3000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   '2026-07', '11111111-0000-0000-0000-000000000001', 'UYU', 1000, 1220, 'borrador');

insert into factura_linea (factura_id, orden, concepto, detalle_i18n, cantidad,
                           precio_unitario, monto) values
  ('c3000000-0000-0000-0000-000000000001', 1, 'firma', '{"es":"Firmas avanzadas"}',
   10, 100, 1000);
