# Pastillero

App para recordar medicamentos. Funciona en la web y como app Android, con los datos en Firebase.

- **Android:** las alarmas se programan en el teléfono. Suenan con la app cerrada, sin internet y con el teléfono bloqueado, y se repiten hasta que marques "Tomado". Puedes marcarlo o posponerlo desde la misma notificación.
- **Web:** recibe los avisos push que envía una Cloud Function cada minuto, aunque la página esté cerrada.
- **Firebase:** guarda la cuenta (email y contraseña), los medicamentos, el historial y los ajustes, y los sincroniza entre dispositivos.

## Estructura

```
src/app.js              lógica de la app (web y Android)
src/schedule.js         cálculo de horarios (compartido con la función)
src/firebase-config.js  ← aquí va la configuración de tu proyecto
src/sw.js               service worker de push web
www/                    HTML, íconos y manifest (lo que se publica)
functions/              Cloud Function que envía los push web
firestore.rules         reglas de seguridad (cada usuario ve solo lo suyo)
.github/workflows/      compila el APK en GitHub
resources/              ícono y splash del APK
```

---

## 1. Crear el proyecto Firebase (unos 10 minutos)

1. Entra a <https://console.firebase.google.com> y elige **Agregar proyecto** (por ejemplo, "pastillero"). Google Analytics no hace falta.
2. **Authentication → Comenzar → Correo electrónico/contraseña → Habilitar.**
3. **Firestore Database → Crear base de datos → modo producción.** Como ubicación, elige `southamerica-west1` (Santiago).
4. **Configuración del proyecto (⚙️) → Tus apps → ícono `</>` (Web)**: registra la app y copia el objeto `firebaseConfig` en `src/firebase-config.js`.
5. Solo si quieres push en la web: en **Configuración del proyecto → Cloud Messaging → Certificados push web → Generar par de claves**, copia la clave en `VAPID_KEY`.
6. **Authentication → Configuración → Dominios autorizados**: agrega el dominio donde vayas a publicar la web, si no es `*.web.app`.

## 2. Publicar las reglas y la versión web

Requiere Node 22 instalado:

```bash
npm install
npm install -g firebase-tools
firebase login
firebase use --add            # elige tu proyecto
firebase deploy --only firestore:rules,hosting
```

La app queda en `https://TU-PROYECTO.web.app`. En el celular, ábrela en Chrome y elige **⋮ → Agregar a pantalla de inicio**.

> Para probar en tu computador: `npm run build`, luego `npx serve www`, y abre http://localhost:3000.

## 3. Activar los push web (opcional, requiere el plan Blaze)

La función programada necesita el plan **Blaze** (pago por uso). Para uso personal queda muy por debajo del límite gratuito, pero Google pide registrar una tarjeta.
En la consola: **Actualizar → Blaze**. Es recomendable crear también una alerta de presupuesto de USD 1.

```bash
cd functions && npm install && cd ..
firebase deploy --only functions
```

Esto crea la función `recordatorios`, que corre cada minuto en Santiago. Revisa las tomas vencidas de los usuarios que activaron las notificaciones en la web, y repite el aviso según el intervalo elegido en Ajustes.

> El APK **no necesita** este paso: sus alarmas son locales.

## 4. Generar el APK con GitHub Actions

1. Crea un repositorio en GitHub (puede ser privado) y sube esta carpeta:
   ```bash
   git init && git add . && git commit -m "Pastillero"
   git branch -M main
   git remote add origin https://github.com/TU_USUARIO/pastillero.git
   git push -u origin main
   ```
2. En la pestaña **Actions** verás el flujo "Construir APK". Corre solo con cada push, y también se puede lanzar a mano con *Run workflow*. Tarda unos 5 minutos.
3. Cuando termine, abre la ejecución y descarga **Pastillero-apk** (es un .zip que contiene `Pastillero.apk`).
4. Pasa el APK al teléfono, ábrelo y acepta **instalar apps de origen desconocido**.

### Firma estable (recomendado)

Sin firma, GitHub genera un APK *debug* con una firma distinta en cada compilación. Para actualizar tendrías que desinstalar la app, aunque tus datos están en la nube y no se pierden.
Para que las actualizaciones se instalen encima de la versión anterior, crea una llave una sola vez:

```bash
keytool -genkey -v -keystore pastillero.jks -alias pastillero -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 pastillero.jks     # en macOS: base64 -i pastillero.jks
```

En GitHub, entra a **Settings → Secrets and variables → Actions** y crea dos secretos:
- `KEYSTORE_B64`: el texto que imprime el comando base64.
- `KEYSTORE_PASS`: la contraseña que elegiste.

Guarda `pastillero.jks` en un lugar seguro y **no lo subas al repositorio**.

### Primer uso en Android

Al abrir la app te pedirá permiso para mostrar notificaciones. En **Ajustes** revisa además:
- **Alarmas exactas → Permitir**, para que avisen a la hora justa.
- **Ajustes del teléfono → Apps → Pastillero → Batería → Sin restricciones.** Es importante en Samsung, Xiaomi y Huawei, que cierran apps agresivamente.
- Usa **Probar aviso** para confirmar que la notificación llega.

---

## Cómo funcionan los horarios

- **Cada X horas:** la primera toma es la hora que indiques. Cada toma siguiente se cuenta desde la hora en que marcaste "Tomado". Si cambias la hora de la primera toma, el conteo se reinicia desde ahí.
- **Horas fijas:** se usan los horarios que definas, todos los días.
- **Si no marcas la toma**, el aviso se repite cada N minutos (30 por defecto, configurable) durante 8 repeticiones como máximo. Con "Posponer", el siguiente aviso se corre al tiempo elegido.
- El teléfono deja programados los avisos de los próximos 4 días y los recalcula cada vez que abres la app o cambias algo.

## Datos en Firestore

```
users/{uid}               email, tz, settings, snoozes, fcmTokens, notified
users/{uid}/meds/{id}     name, dose, note, color, mode, times[], interval, start, paused, created
users/{uid}/log/{id}      medId, slot, at, status (taken|skipped), archived
```

Esta estructura permite agregar más adelante la opción de **compartir con un familiar**: bastaría una lista de "cuidadores" en el documento del usuario y ajustar las reglas.
