# ¿Está abierta la Anella Olímpica?

App web **personal** para saber si la **Esplanada de l'Anella Olímpica de Montjuïc**
(el recinto vallado al aire libre) está abierta hoy y los próximos 7 días, y para
**acumular un histórico de cierres** y deducir el patrón de cierres por montaje de
conciertos.

La gracia está en cruzar dos señales por día:

- **`evento`** (automático): ¿hay concierto en la agenda ese día? Lo rellena el Worker
  por scraping. Solo los del **Estadi Olímpic** afectan a la explanada (los del Palau
  Sant Jordi / Sant Jordi Club son cubiertos y se registran, pero no cuentan como cierre).
- **`accesoReal`** (manual): el estado real que ves al ir — `abierto`, `cerrado` o sin
  dato. Lo marcas tú desde la web. **El Worker nunca toca este campo.**

Viendo *"The Weeknd el día X"* + *"cerrado los días X-2, X-1, X y X+1"* deduces la ventana
real de montaje/desmontaje, que **no se publica en ningún sitio**.

---

## Estructura

```
.
├── public/                 # Front estático (Cloudflare Pages)
│   ├── index.html
│   ├── style.css
│   ├── app.js              #  ← HORARIOS (única constante de horario) + lógica del semáforo
│   └── estado-ejemplo.json #  datos de muestra para el modo demo
├── src/
│   └── index.js            # Worker: cron de scraping + API JSON
│                           #  ← parsearAgenda() y SELECTORES: la parte frágil, aislada
├── wrangler.toml           # cron, binding de KV, variables
└── README.md
```

## Cómo funciona

- **Stack**: front HTML/CSS/JS vanilla (sin build, sin npm), un único **Cloudflare Worker**
  con **Cron Trigger**, y **Cloudflare KV** como almacén. Cero dependencias en runtime.
- **Cron** (1×/día, de madrugada): scrapea la agenda del Estadi Olímpic, y por cada día
  (hoy + 7) guarda en KV si hay evento. Preserva siempre tu `accesoReal`.
- **Front**: lee la API y muestra 3 vistas — semáforo de hoy, próximos 7 días (con botón
  para marcar acceso real), e histórico con el patrón de cierres.
- **Modelo de datos en KV**:
  - `log:YYYY-MM-DD` → `{ fecha, evento, accesoReal, scrapeOk, ultimaActualizacion }`
  - `meta:lastrun` → `{ ts, fuente, eventos }` (para detectar si el scraper lleva días caído)

---

## Despliegue

Necesitas una cuenta de **Cloudflare** y **Wrangler** (`npm i -g wrangler` o `npx wrangler`).

```bash
wrangler login
```

### 1. Crear el namespace de KV

```bash
wrangler kv namespace create ANELLA_KV
```

Copia el `id` que te devuelve y pégalo en `wrangler.toml`, sustituyendo
`RELLENA_ESTE_ID_TRAS_CREAR_EL_NAMESPACE`.

### 2. Desplegar el front (Pages) y obtener su URL

```bash
wrangler pages deploy public --project-name anella-olimpica
```

Te dará una URL tipo `https://anella-olimpica.pages.dev`. **Apúntala**: es tu front y
también lo que va en `ORIGEN_PERMITIDO`.

### 3. Configurar CORS y el token del Worker

- Edita `wrangler.toml` → `[vars] ORIGEN_PERMITIDO` y pon la URL de Pages del paso 2.
- Crea el token para poder marcar el acceso real (no se guarda en el repo, es un secret):

```bash
wrangler secret put ACCESO_TOKEN
# escribe un token cualquiera, p. ej. una frase larga
```

### 4. Desplegar el Worker

```bash
wrangler deploy
```

Te dará la URL del Worker, tipo `https://anella-olimpica.TU-SUBDOMINIO.workers.dev`.

### 5. Conectar el front con el Worker

Abre tu web de Pages → **⚙ Ajustes** → pega ahí la **URL del Worker** y el **token**.
Se guardan en tu dispositivo (localStorage). Sin URL, la web funciona en **modo demo**.

### 6. (Opcional) Rellenar datos sin esperar al cron

El cron corre de madrugada. Para poblar KV ya mismo, dispara un refresco manual:

```bash
curl -X POST -H "X-Acceso-Token: TU_TOKEN" \
  https://anella-olimpica.TU-SUBDOMINIO.workers.dev/api/refrescar
```

---

## Desarrollo local

```bash
# 1) token para pruebas (NO se sube al repo, está en .gitignore)
echo 'ACCESO_TOKEN=token-de-pruebas-local' > .dev.vars

# 2) Worker en local (KV simulada, no toca producción)
wrangler dev --test-scheduled
#   - POST http://127.0.0.1:8787/api/refrescar   (con header X-Acceso-Token) → scrapea
#   - GET  http://127.0.0.1:8787/api/semana
#   - disparar el cron: curl "http://127.0.0.1:8787/__scheduled"

# 3) Front en local
python3 -m http.server 4173 --directory public   # o: wrangler pages dev public
#   En ⚙ Ajustes pon la URL del Worker (http://127.0.0.1:8787). Sin ella → modo demo.
```

## API

| Método | Ruta | Qué hace |
|--------|------|----------|
| GET  | `/api/semana` | Hoy + 7 días con señales + meta del scraper |
| GET  | `/api/historico?desde=YYYY-MM-DD` | Todos los días registrados (para el patrón) |
| POST | `/api/acceso` | `{ "fecha":"YYYY-MM-DD", "estado":"abierto\|cerrado\|null" }` → setea `accesoReal`. Requiere header `X-Acceso-Token`. |
| POST | `/api/refrescar` | Dispara el cron a mano (requiere token). Devuelve los eventos parseados. |

El horario base **no** viaja por la API: vive solo en la constante `HORARIOS` de
`public/app.js` (una única fuente de verdad, fácil de editar).

---

## 🔧 Mantenimiento (LÉEME cuando el scraping deje de funcionar)

Las webs municipales/de venues cambian de maquetación cada cierto tiempo. **Cuando eso
pase, el `evento` dejará de detectarse** (verás `scrapeOk: false` o días sin evento que
deberían tenerlo). El código está hecho para que la reparación sea de 5 minutos y en un
único sitio:

**Todo lo frágil está en `src/index.js`, en dos lugares contiguos:**

1. **`const SELECTORES`** — los selectores CSS de cada tarjeta de evento.
2. **`function parsearAgenda(html)`** — usa esos selectores con `HTMLRewriter`.

### Cómo re-derivar los selectores

1. Abre la fuente en el navegador: <https://estadiolimpic.barcelona/es/agenda>
2. Mira el HTML (ver código fuente / inspeccionar) y busca el contenedor de un evento.
   Hoy (jun 2026) cada evento es así:
   ```html
   <div class="... events-list__item ...">
     <div class="events-list__content-title"><span class="field--name-title">The Weeknd</span></div>
     <div class="events-list__content-name"><div class="field--name-field-place">Estadi Olímpic</div></div>
     <div class="events-list__content-date">Martes, 01 de Septiembre de 2026</div>
   </div>
   ```
3. Ajusta `SELECTORES` para que apunten al elemento que **contiene directamente** el texto
   (HTMLRewriter solo entrega el texto del nodo que matchea, no el de sus hijos).
4. Si cambió el **formato de la fecha** (hoy `"Martes, 01 de Septiembre de 2026"`), ajusta
   `fechaTextoAISO()` y el mapa `MESES`.
5. Comprueba con `wrangler dev` + `POST /api/refrescar`: la respuesta trae la lista
   `eventos` parseada; verifica que las fechas y recintos salen bien.

### Salvaguardas que ya hay

- Si la web responde mal o no se reconoce la maqueta (`scrapeOk: false`), el cron **no
  machaca** los `evento` buenos que ya tuvieras guardados.
- `meta:lastrun` permite ver desde cuándo no actualiza; el front avisa si pasa de 36 h.
- Añadir otra fuente es trivial: mete un objeto más en el array `FUENTES` con su propio
  `parser`. Se prueban en orden.

---

## Notas y avisos

- Esto es **scraping de webs públicas para uso estrictamente personal**: 1 request/día,
  User-Agent honesto, sin evadir nada.
- La URL `barcelona.cat/casalsdebarri/verdun/...` que aparecía en el brief original **se
  descartó**: hace un redirect a la página del *Casal de Barri Verdún* (centro cívico de
  barrio), no a la agenda del Estadi Olímpic. La fuente buena es `estadiolimpic.barcelona`.
- Los **periodos de restricción amplios** que a veces publican las webs (p. ej. *"del 27
  abril al 28 julio"*) **no son fiables** como dato estructurado; el sistema los ignora y
  se basa solo en eventos concretos de la agenda. Para los cierres reales está tu marca
  manual de `accesoReal`.
- **Horario base** (editable en `public/app.js` → `HORARIOS`):
  - Verano (1 abr – 31 oct): 06:00 – 22:00
  - Invierno (1 nov – 31 mar): 06:00 – 20:00
