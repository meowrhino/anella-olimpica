# Prompt para Claude Code — App "¿Está abierta la Anella Olímpica?"

Copia todo lo que hay debajo de la línea y pégalo en Claude Code.

---

Quiero que me construyas una app web **personal** (un solo usuario, yo) para saber si la **Esplanada de l'Anella Olímpica de Montjuïc** (el recinto vallado al aire libre, no las instalaciones interiores) está abierta o no, hoy y los próximos 7 días, y para **acumular un histórico de cierres** que me permita detectar el patrón de cierres por montaje de conciertos.

## Stack obligatorio (no negociable)

- **Front**: HTML + CSS + JavaScript **vanilla**. Sin frameworks, sin build step, sin npm para el front. Web Components solo si aportan; si no, JS plano.
- **Backend**: un único **Cloudflare Worker** con **Cron Trigger**.
- **Persistencia**: **Cloudflare KV** (un namespace).
- **Deploy**: Cloudflare Pages (front) + Worker. Dame `wrangler.toml` completo y los comandos de despliegue.
- Cero dependencias en runtime salvo lo que trae Cloudflare Workers de serie (usa `HTMLRewriter` nativo para parsear HTML; **no** uses cheerio ni librerías de parseo).

## Modelo de datos (lo más importante, léelo entero antes de codear)

El núcleo del problema: **no existe ninguna fuente que publique los días que la explanada está cerrada**. La agenda municipal solo lista el día del concierto, pero la explanada cierra también 1–3 días antes (montaje) y a veces el día después (desmontaje), y eso NO está publicado en ningún sitio estructurado. Por tanto:

1. El histórico **no se puede descargar**: hay que **construirlo desde cero**, registrando una entrada por día a partir del momento en que despliegue la app.
2. Cada día del log debe guardar **dos señales independientes**:
   - **`evento`** (objetivo, automático): ¿hay concierto/evento en la agenda ese día? Nombre del evento si lo hay. Lo rellena el Worker por scraping.
   - **`accesoReal`** (subjetivo, manual): el estado real de la explanada ese día — `"abierto"`, `"cerrado"` o `null` (sin dato). Esto solo lo sé yo cuando voy; lo marco desde el front con un botón. **El Worker nunca toca este campo.**

La gracia es cruzar ambas columnas: viendo "evento: The Weeknd el día X" + "accesoReal: cerrado los días X-2, X-1, X" deduzco yo mismo la ventana de montaje. Sin la señal manual, el histórico solo repetiría la agenda y no serviría.

### Estructura en KV

- Clave `log:YYYY-MM-DD` → objeto por día:
  ```json
  {
    "fecha": "2026-06-10",
    "evento": { "hayEvento": true, "nombre": "The Weeknd", "recinto": "Estadi Olímpic" },
    "accesoReal": null,
    "scrapeOk": true,
    "ultimaActualizacion": "2026-06-10T05:00:00Z"
  }
  ```
- Clave `meta:lastrun` → timestamp del último cron OK, para detectar si el scraper lleva días caído.

## Horario base (calcúlalo en el cliente, sin red)

El horario regular es fijo y no requiere scraping. Funciones puras de fecha:
- **Verano (1 abril – 31 octubre)**: 06:00 – 22:00
- **Invierno (1 noviembre – 31 marzo)**: 06:00 – 20:00
- Mismo horario todos los días (no distingue laborable/festivo).

Si en algún momento estos horarios cambian, deben estar en **una sola constante** fácil de editar, no esparcidos por el código.

## Lógica de "¿está abierta ahora?"

Combina, en este orden de prioridad:
1. Si `accesoReal` de hoy === `"cerrado"` → **CERRADO** (dato real manda sobre todo).
2. Si hay `evento.hayEvento` hoy → **PROBABLEMENTE CERRADO/RESTRINGIDO** (por concierto).
3. Si no, compara la hora actual contra el horario base → **ABIERTO** / **CERRADO (fuera de horario)**.

Muestra siempre **en qué señal** se basa la conclusión (ej. "Cerrado: hay concierto en agenda" vs "Cerrado: fuera de horario").

## El Worker (cron)

- Cron una vez al día, de madrugada (hora de Madrid; ten en cuenta que el cron de Cloudflare es UTC).
- Hace `fetch` server-side a la **agenda municipal del Estadi Olímpic**, que es la fuente estructurada más fiable:
  `https://www.barcelona.cat/casalsdebarri/verdun/es/agenda/estadi-olimpic-de-montjuic-lluis-companys`
  (esta página lista eventos con sus fechas en formato "Cuándo: DD/MM/YYYY" o rangos "De DD/MM/YYYY a DD/MM/YYYY"; parséala con `HTMLRewriter`).
- Como respaldo/secundaria, intenta también la home y la agenda de `https://estadiolimpic.barcelona/es` y `https://estadiolimpic.barcelona/es/agenda` (extrae bloques "DESTACADOS"/agenda con nombre + recinto + fecha). Si una falla, que no rompa la otra.
- **Robustez del parseo**: las webs municipales cambian de maquetación. Aísla TODA la lógica de extracción en una función `parsearAgenda(html)` con selectores claramente comentados, de modo que cuando se rompa yo sepa exactamente qué tocar. Si el scrape devuelve 0 eventos cuando antes devolvía, marca `scrapeOk: false` y no machaques los datos buenos previos.
- Para cada día de **hoy + próximos 7**: crea/actualiza su `log:YYYY-MM-DD` con la señal `evento`. **Nunca sobrescribas `accesoReal`** si ya tiene valor.
- Además, **anexa el día de hoy al histórico de forma permanente** (no borres logs viejos: el histórico es el producto).
- Expón endpoints JSON con CORS abierto solo a mi dominio de Pages:
  - `GET /api/semana` → array de los próximos 7 días (horario base + señales).
  - `GET /api/historico?desde=YYYY-MM-DD` → todos los días registrados, para la vista de tabla/patrón.
  - `POST /api/acceso` con body `{ "fecha": "...", "estado": "abierto|cerrado|null" }` → setea `accesoReal`. Protégelo con un **token simple en header** (variable de entorno `ACCESO_TOKEN`), ya que es de un solo usuario; nada de login completo.

## El front (3 vistas, una sola página)

1. **Semáforo grande arriba**: estado de HOY (verde abierto / rojo cerrado / ámbar "probable cierre por evento"), con la franja horaria de hoy y el motivo de la conclusión.
2. **Tabla de los próximos 7 días**: fecha, horario base, evento (si hay), y un botón por día para marcar `accesoReal` cuando lo sepa (manda el `POST` con el token, que guardo en `localStorage` la primera vez).
3. **Histórico / patrón**: tabla cronológica con dos columnas bien diferenciadas visualmente — **Evento en agenda** y **Acceso real (mi marca)** — para que de un vistazo vea "concierto día X → cerrado días X-2..X". Resalta visualmente los clústeres de días cerrados alrededor de eventos. Esta vista es la que me deja deducir la ventana de montaje.

Diseño: limpio, legible en móvil (lo consultaré desde el iPhone antes de salir a entrenar). Sin librerías de UI.

## Entregables

1. Estructura de carpetas completa.
2. `worker.js` (o `src/index.js`) comentado, con `parsearAgenda` aislada.
3. `wrangler.toml` con cron, binding de KV y variables.
4. Front (`index.html`, `style.css`, `app.js`).
5. README con: cómo crear el namespace KV, cómo setear `ACCESO_TOKEN`, comandos de deploy de Worker y Pages, y **una sección "Mantenimiento" explicando exactamente qué función editar si el scraping se rompe** (porque se romperá cuando el Ayuntamiento cambie la web).
6. Un `estado-ejemplo.json` con datos de muestra para poder ver el front funcionando sin esperar al primer cron.

## Avisos importantes que debes respetar

- Esto es scraping de webs públicas para uso estrictamente personal: 1 request/día, sin sobrecargar el servidor, identifícate con un User-Agent honesto. No implementes nada que evada rate limits ni protecciones.
- Las fechas de "periodo de restricción" amplio (tipo "del 27 abril al 28 julio") que a veces publica la web NO son fiables como dato estructurado; ignóralas para la lógica y básate en eventos concretos de la agenda.
- Prioriza que el código sea **fácil de reparar** sobre que sea "ingenioso": la fragilidad está en el scraping y yo seré quien lo mantenga.

Empieza explicándome el plan y la estructura de archivos antes de generar todo el código.
