# ERROR 403: access_denied - Solucion para YouTube OAuth

Este error aparece cuando Google rechaza la autenticacion OAuth. Es super comun y tiene solucion rapida.

## Causas y Soluciones

### Error `invalid_grant: Token has been expired or revoked`

Este error significa que `youtube_credentials.pkl` ya no sirve. No es un problema del video ni del tamano del archivo: Google ha caducado o revocado el refresh token.

1. Ejecuta `python youtube_uploader.py` en una maquina con navegador.
2. Acepta de nuevo el permiso de subida de YouTube.
3. Copia el nuevo `youtube_credentials.pkl` al servidor si el pipeline corre en Docker/VPS.
4. Vuelve a lanzar la subida.

Si el pipeline detecta este caso, aparta el token anterior como `youtube_credentials.pkl.revoked` para que no se siga reintentando con una credencial rota.

### Causa #1: Tu email no esta en "Test users" (90% de los casos)

Si tu app esta en modo **Testing** (por defecto), SOLO los emails añadidos como "Test users" pueden autenticarse.

**Solucion paso a paso:**

1. Ve a [Google Cloud Console](https://console.cloud.google.com/)
2. Selecciona tu proyecto
3. Ve a **APIs & Services > OAuth consent screen**
4. Asegurate de que **User Type** este en **External** (no Internal, a menos que tengas Google Workspace)
5. Ve a la pestaña **Audience**
6. En la seccion **Test users**, haz clic en **ADD USERS**
7. Introduce el **email exacto** de la cuenta de YouTube con la que quieres subir videos
   - Ejemplo: `tucanal@gmail.com` (el email con el que inicias sesion en YouTube)
8. Guarda y espera 1 minuto
9. Vuelve a ejecutar `python youtube_uploader.py` en tu PC

### Causa #2: App no publicada

Si no quieres andar añadiendo test users cada vez, puedes publicar la app.

1. En **OAuth consent screen**, ve a la pestaña **Publishing**
2. Haz clic en **PUBLISH APP**
3. Confirma

**Nota**: Publicar la app la hace "disponible para cualquiera", pero sin verificacion solo podran usarla las personas a las que les des acceso manualmente. No hay riesgo real si solo tu la usas.

### Causa #3: Scopes no configurados correctamente

Verifica que el scope de YouTube Upload este añadido:

1. Ve a **APIs & Services > OAuth consent screen > Data Access**
2. Haz clic en **ADD OR REMOVE SCOPES**
3. Busca y selecciona:
   ```
   .../auth/youtube.upload
   ```
   (o filtra por "youtube")
4. Guarda
5. Vuelve a intentar la autenticacion

### Causa #4: Tipo de aplicacion incorrecto

El `client_secret.json` debe ser de tipo **Desktop app**, NO "Web application".

1. Ve a **APIs & Services > Credentials**
2. Busca tu OAuth 2.0 Client ID
3. El **Type** debe decir **Desktop**
4. Si dice "Web application", crea uno nuevo:
   - Clic en **CREATE CREDENTIALS > OAuth client ID**
   - Application type: **Desktop app**
   - Name: `twitch-vod-auto-desktop`
   - Descarga el JSON y renombralo a `client_secret.json`

---

## Checklist rapido (haz esto primero)

Abre [Google Cloud Console](https://console.cloud.google.com/) y verifica:

- [ ] Proyecto creado
- [ ] YouTube Data API v3 **habilitada** (APIs & Services > Enabled APIs)
- [ ] OAuth consent screen → **Publishing status** = Testing o In production
- [ ] OAuth consent screen → **Test users** → Tu email de YouTube añadido
- [ ] OAuth consent screen → **Data Access** → Scope `youtube.upload` añadido
- [ ] Credentials → Client ID de tipo **Desktop app**
- [ ] `client_secret.json` descargado y en la carpeta del proyecto

---

## Si nada funciona: crear todo desde cero

Si la configuracion actual esta muy rota, es mas rapido borrar y crear nuevo:

1. Ve a **APIs & Services > Credentials**
2. Borra el OAuth client ID actual (papelera a la derecha)
3. Crea uno nuevo:
   - **CREATE CREDENTIALS > OAuth client ID**
   - Application type: **Desktop app**
   - Name: `twitch-vod-auto`
   - Descarga el JSON → renombralo a `client_secret.json`
4. Ve a **OAuth consent screen > Data Access**
   - Añade el scope `.../auth/youtube.upload`
5. Ve a **OAuth consent screen > Audience**
   - Añade tu email como Test user
6. Guarda todo
7. En tu PC local, ejecuta `python youtube_uploader.py` de nuevo

---

## Nota importante

Si ves una pantalla que dice **"Google hasn't verified this app"** en vez del error 403, eso es NORMAL. Haz clic en **Advanced** y luego **Go to [nombre] (unsafe)**. Esto pasa porque tu app personal no esta verificada por Google (y no necesita estarlo si solo tu la usas).

El error 403 `access_denied` especificamente significa que Google bloqueo el acceso por configuracion de usuarios de prueba, no por la pantalla de "no verificada".
