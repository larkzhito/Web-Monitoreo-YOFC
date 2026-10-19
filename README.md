# Mi Bus EMT

Tiempos de llegada de la EMT Madrid en vivo y alertas push en el iPhone (PWA).

## Arrancar en local
```
pip install -r requirements.txt
python app.py            # http://localhost:5055
```
Para probar sin credenciales: `EMT_DEMO=1 python app.py`.

## Credenciales
Copia `.env.example` a `.env` y rellena `EMT_CLIENT_ID` y `EMT_PASSKEY` (Portal desarrollador EMT > Mi Perfil).
`VAPID_SUB` debe ser `mailto:` con tu email real (Apple lo exige para las push).

## Despliegue (Render, gratis)
1. Sube este repo a GitHub (privado).
2. En https://render.com entra con GitHub > **New > Blueprint** > elige el repo (usa `render.yaml`).
3. Rellena las variables: `EMT_EMAIL`, `EMT_PASSWORD` (o `EMT_CLIENT_ID` + `EMT_PASSKEY` cuando la app EMT esté activa),
   `VAPID_SUB=mailto:tu-email`, y `VAPID_PRIVATE_KEY` + `APP_KEY` copiadas de `render-secrets.txt` (no está en git).
4. En https://cron-job.org crea un cron cada 5 min a `https://TU-APP.onrender.com/api/check`
   (el plan gratis de Render se duerme a los 15 min sin tráfico; esto lo mantiene despierto y revisa alertas).

## iPhone
Abre `https://TU-APP.onrender.com` en Safari > **Compartir > Añadir a pantalla de inicio** (iOS 16.4+),
abre la app desde el icono, mete la `APP_KEY` cuando la pida y acepta las notificaciones al crear la primera alerta.
