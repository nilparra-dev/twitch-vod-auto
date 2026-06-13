# Rediseño del dashboard — SPA moderna

**Fecha:** 2026-06-13
**Estado:** aprobado, en implementación

## Objetivo

Reemplazar el dashboard actual (FastAPI sirviendo una página HTML con JS vanilla
inline + SSE) por una SPA moderna, con un diseño oscuro, intuitivo y limpio
inspirado en claude.ai (sin copiarlo), manteniendo **paridad total** de
funciones y la API FastAPI existente.

## Stack

- React 18 + TypeScript + Vite
- Tailwind CSS + shadcn/ui (Radix)
- TanStack Query (datos/caché de la API)
- React Router (rutas)
- Recharts (gráfico de actividad)
- Zustand o contexto ligero para el estado en vivo (SSE)
- Vitest + React Testing Library, ESLint + Prettier, `tsc` para tipos

## Identidad visual

- **Tema:** oscuro por defecto, toggle a claro, persistido en `localStorage`.
- **Paleta (tokens CSS + Tailwind):**
  - Dark: base `#1B1B19`, superficie `#242422`, elevado `#2C2B28`,
    borde `rgba(255,255,255,.08)`, texto `#EDEBE4`, atenuado `#A8A59C`.
  - Light: base `#F6F5F0`, superficie `#FFFFFF`, texto `#2A2926`,
    borde `#E6E2D8`.
  - Acento arcilla `#D08763` (hover `#C2724E`); ok `#7FB87F`, aviso `#E0A35E`,
    error `#D9776A`.
- **Tipografía (self-hosted, sin CDN):** Fraunces (titulares display),
  Inter / Inter Tight (UI, datos, cuerpo), JetBrains Mono (IDs).
- **Logo:** concepto "bucle + play" (automatización), SVG en acento arcilla;
  usado en sidebar, login y favicon.

## Integración

- Carpeta `frontend/` con la app Vite. Build → `frontend/dist`.
- FastAPI sirve la SPA: `StaticFiles` en `/assets`, fallback a `index.html`
  para rutas no-API. `/api/*` y `/api/events` (SSE) sin cambios.
- Mismo origen → auth por cookie de sesión y `EventSource` funcionan sin tocar
  la lógica de auth del backend.

### Cambios en backend (mínimos)

- `dashboard.py`: `/` y `/login` dejan de servir templates; sirven la SPA.
  Se eliminan `templates/login.html` y `templates/dashboard.html`.
- **CSP:** se elimina `script-src 'unsafe-inline'` (el JS va empaquetado, no
  inline) y el `font-src` de Google (fuentes self-hosted). Se mantiene
  `style-src 'unsafe-inline'` (Radix inyecta estilos inline).

### Docker / deploy

- Nuevo `Dockerfile.dashboard` multi-stage: stage Node (build del frontend) →
  stage Python runtime que copia `dist` + deps. El dashboard deja de necesitar
  ffmpeg/twitch-dlp → imagen más ligera.
- `docker-compose.prod.yml`: el servicio `dashboard` usa `Dockerfile.dashboard`.
  El servicio `pipeline` mantiene el `Dockerfile` actual.

### Dev local

- `vite dev` con proxy de `/api` → uvicorn. Hot reload.

## Pantallas (paridad)

1. Login — POST `/api/login`.
2. Resumen — tarjetas (total/subidos/cola/fallos), gráfico de actividad,
   VODs recientes, descargas activas en vivo (SSE).
3. VODs — tabla con búsqueda/filtros/paginación, retry, borrar, detalle.
4. Cola — items + borrar.
5. Subida manual — URL/ID, canal, título, privacidad, tags.
6. YouTube OAuth — estado + iniciar/completar renovación.
7. Logs — visor con tail.
8. Layout: sidebar con logo + nav + toggle tema + usuario/logout.

## Tiempo real

`EventSource('/api/events')` → store → actualiza Resumen/Cola/Progreso.
Reconexión automática.

## Testing / CI

- Frontend: `npm run build`, `tsc`, `eslint`, `vitest`.
- Nuevo job de CI para `frontend/` (install, lint, typecheck, test, build).
- Backend: tests actuales + test de que `/` sirve la SPA.

## Fuera de alcance (YAGNI)

Sin multi-usuario/roles, sin i18n, sin PWA, sin nuevas features de pipeline.
Solo rediseño + paridad.
