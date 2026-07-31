# Imagen de producción de MiFirma (backend Fastify + consola/PWA).
# Corre la app con tsx (igual que en desarrollo); no hay paso de compilación.
# Node 26 para igualar el entorno local. Si tu Node local es otra versión,
# podés ajustar la base.
FROM node:26-slim

WORKDIR /app

# Dependencias primero, para aprovechar la cache de capas.
# No hay package-lock.json => usamos npm install (no npm ci).
# --include=dev porque en runtime usamos tsx, que es una devDependency.
COPY package.json ./
RUN npm install --include=dev

# Código fuente, páginas (public/: consola, PWA, íconos), migraciones y scripts.
COPY . .

# Fastify en modo producción. El server lee PORT (default 3000) y bindea 0.0.0.0.
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Chequeo de salud: la app expone GET /health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
