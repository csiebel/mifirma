-- Autoridades de sellado para desarrollo.
--
-- Las tres respondieron el 1/8/2026 desde tu máquina. El orden es el medido:
-- digicert 628 ms y token de 5997 B; sectigo 703 ms y 6626 B; freetsa 817 ms y
-- 4635 B. Se prueban en ese orden y la primera que conteste sella.
--
-- ⚠ Ninguna de las tres está acreditada en UY, PY ni BR. Sirven para que el
-- mecanismo funcione y se pueda probar; la autoridad definitiva de cada país es
-- dato del paquete legal, verificado por un abogado local. Cuando esté, se
-- agrega con `pais` y queda primera para ese país sin tocar código.
insert into tsa (nombre, url, orden, pais, timeout_ms) values
  ('digicert', 'http://timestamp.digicert.com', 10, null, 8000),
  ('sectigo',  'http://timestamp.sectigo.com',  20, null, 8000),
  ('freetsa',  'https://freetsa.org/tsr',       30, null, 8000)
on conflict (nombre) do nothing;

select nombre, url, orden, activa from tsa order by orden;
