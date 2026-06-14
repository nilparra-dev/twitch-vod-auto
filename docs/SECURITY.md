# Seguridad

Resumen de la auditoría del panel expuesto (`vod.privatevods.com`) y estado de
las mitigaciones. Perspectiva: atacante externo anónimo que solo ve el login.

## Modelo de amenaza

Flujo: `cliente → Cloudflare (TLS público, WAF, DDoS) → nginx (origen) → FastAPI`.
La autenticación es de un único admin con cookie de sesión firmada. La única
superficie sin autenticar es `/api/login`, `/healthz`, los estáticos de la SPA y
el callback OAuth (que exige sesión).

## Hallazgos y estado

| # | Sev | Hallazgo | Estado |
|---|-----|----------|--------|
| F1 | Alto | Bypass del rate-limit de login falsificando `X-Forwarded-For` | **Corregido** (código + nginx) |
| F2 | Medio | Esquema OpenAPI expuesto en `/openapi.json` | **Corregido** (`openapi_url=None`) |
| F3 | Medio | Posible bypass de Cloudflare si el origen es accesible directo | **Parcial** (real_ip en nginx) + acción de infra pendiente |
| F4 | Bajo | Sesión stateless forjable si `SECRET_KEY` es débil | **Mitigado** (aviso de arranque) + verificación pendiente |
| F5 | Bajo | Cabeceras de seguridad duplicadas (nginx + app) | **Corregido** (solo la app) |
| F6 | Bajo | `X-XSS-Protection` obsoleta | **Corregido** (eliminada) |
| F7 | Info | TLS de nginx sin fijar | **Corregido** (`TLSv1.2/1.3`) |
| F8 | Info | Admin único sin 2FA | Pendiente (decisión de producto) |

## Detalle de las correcciones aplicadas

- **F1** — `_client_ip()` usa una cabecera de confianza (`X-Real-IP`, configurable
  con `TRUSTED_IP_HEADER`) en vez del primer token de `X-Forwarded-For`, que el
  cliente controla. nginx fija `X-Real-IP` a `$remote_addr` (sobrescribe lo que
  mande el cliente) y, con `real_ip` + `CF-Connecting-IP` restringido a rangos de
  Cloudflare, `$remote_addr` es la IP real del cliente. Rotar `X-Forwarded-For`
  ya no salta el límite (8 intentos / 5 min).
- **F2** — `FastAPI(..., openapi_url=None)`: no se sirve el esquema.
- **F5/F6** — nginx ya no añade `X-Frame-Options`, `X-Content-Type-Options`,
  `Referrer-Policy` ni `X-XSS-Protection`; las de seguridad las fija solo la app
  (junto a CSP y HSTS).
- **F7** — `ssl_protocols TLSv1.2 TLSv1.3;` + cifrados modernos + `server_tokens off`.

## Acciones de infraestructura pendientes (requieren tu intervención)

- **F3 — Bloquear el origen a Cloudflare.** El `real_ip` de nginx confía en
  `CF-Connecting-IP` solo desde rangos de Cloudflare, pero **no impide** que
  alguien que descubra la IP del VPS pegue directo saltándose Cloudflare. Acción:
  1. Firewall del VPS (ufw/iptables/Security Group): permitir 80/443 **solo**
     desde los rangos de https://www.cloudflare.com/ips/.
  2. Activar **Authenticated Origin Pulls** (mTLS Cloudflare↔origen).
  3. Refrescar la lista `set_real_ip_from` en `nginx.conf` cuando Cloudflare
     actualice sus rangos.
- **F4 — Verificar `SECRET_KEY`.** Debe ser aleatoria de ≥32 caracteres en el
  `.env` de producción (la app avisa por log si es corta). Si pudo filtrarse,
  rótala (invalida todas las sesiones).
- **F8 — 2FA / acceso restringido.** Para un panel público, considera TOTP o
  poner el panel detrás de **Cloudflare Access** (Zero Trust) o una allowlist de
  IP. Con F1 corregido y una contraseña fuerte el riesgo es aceptable, pero 2FA
  es lo recomendable.

## Lo que ya estaba bien

Comparación timing-safe (`compare_digest`), error de login genérico (sin
enumeración de usuarios), anti-CSRF por Origin/Referer, cookies `SameSite=lax` +
`Secure`, HSTS, CSP estricta (`script-src 'self'`), sin fuga de ficheros
sensibles, path traversal bloqueado, sin UI de docs ni stack traces, Cloudflare
delante.
