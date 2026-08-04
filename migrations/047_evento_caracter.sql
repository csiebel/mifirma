-- =============================================================================
-- MiFirma — 047_evento_caracter.sql
--
-- El tipo de evento que falta para que la 046 pueda anotar lo que hace.
--
-- `evidencia.tipo` tiene clave foránea a `tipo_evento`: un hecho que no está
-- declarado no se puede anotar, y por lo tanto no puede ocurrir.
--
-- Y éste tiene que quedar en el expediente sí o sí: «firmé en representación de
-- tal empresa» es una afirmación de la persona sobre en nombre de quién actúa.
-- Es exactamente la clase de cosa que se discute después, y el expediente tiene
-- que poder decir que lo declaró ella, cuándo, y desde dónde.
--
-- Va con `peso = 'alto'`, a diferencia de los de marca: no es un detalle de
-- presentación, es parte de qué se firmó y quién lo firmó. Y en el orden queda
-- justo antes del consentimiento, porque en el acto de firmar primero se dice
-- en nombre de quién y después se consiente.
-- =============================================================================

do $guard$ begin
  if current_database() <> 'mifirma' then
    raise exception 'ABORTADO: migración de MiFirma ejecutada contra la base "%"', current_database();
  end if;
end $guard$;

begin;

insert into tipo_evento (codigo, categoria, peso, descripcion_i18n, orden) values
  ('firma.caracter_declarado', 'identidad', 'alto',
   '{"es": "El firmante declaró con qué carácter firma",
     "en": "The signer declared in what capacity they sign",
     "pt": "O signatário declarou em que qualidade assina"}'::jsonb, 59)
on conflict (codigo) do nothing;

commit;

do $control$
begin
  if not exists (select 1 from tipo_evento where codigo = 'firma.caracter_declarado') then
    raise exception 'no quedó declarado el tipo de evento';
  end if;
end $control$;
