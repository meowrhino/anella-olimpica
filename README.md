# ¿Está abierta la Anella Olímpica?

App web **personal** para saber si la **Esplanada de l'Anella Olímpica de Montjuïc**
(el recinto vallado al aire libre) está abierta hoy y los próximos 7 días, y para
**acumular un histórico de cierres** y deducir el patrón de cierres por montaje de
conciertos.

La gracia está en cruzar dos señales por día:

- **`evento`** (automático): ¿hay concierto en la agenda ese día? Lo rellena un scraper
  diario. Solo los del **Estadi Olímpic** afectan a la explanada (los del Palau Sant Jordi
  / Sant Jordi Club son cubiertos: se registran, pero no cuentan como cierre).
- **`accesoReal`** (manual): el estado real que ves al ir — `abierto`, `cerrado` o sin
  dato. Lo marcas tú desde la web.

Viendo *"The Weeknd el día X"* + *"cerrado los días X-2, X-1, X y X+1"* deduces la ventana
real de montaje/desmontaje, que **no se publica en ningún sitio**.

## Arquitectura (100 % GitHub, sin servidores)

- **GitHub Pages** sirve la web estática (carpeta `docs/`).
- **GitHub Actions** corre el scraper **una vez al día** (`scripts/scrape.mjs`) y
  **commitea** el resultado en `docs/data/log.json`. Pages se reconstruye solo con ese push.
  → El propio **historial de git es tu log de cierres**.
- Tus **marcas manuales** se guardan escribiendo `docs/data/marcas.json` con la **API de
  GitHub**, usando un token personal que solo vive en tu navegador.
- Cero dependencias: el scraper usa el `fetch` e `Intl` nativos de Node 20.

```
.
├── docs/                       # Web (GitHub Pages, source = main /docs)
│   ├── index.html
│   ├── style.css
│   ├── app.js                  #  ← HORARIOS (única constante de horario) + lógica del semáforo
│   ├── estado-ejemplo.json     #  datos de muestra (modo demo si aún no hay log.json)
│   └── data/
│       ├── log.json            #  eventos por día (lo escribe el Action)
│       └── marcas.json         #  tus marcas (lo escribes tú desde la web)
├── scripts/
│   └── scrape.mjs              #  ← parsearAgenda() y selectores: la parte frágil, aislada
├── .github/workflows/
│   └── scrape.yml              #  cron diario + commit
└── README.md
```

## Modelo de datos

`docs/data/log.json`:

```json
{
  "meta": { "lastrun": "2026-06-06T04:00:00Z", "fuente": "estadiolimpic.barcelona", "eventos": 10 },
  "dias": {
    "2026-09-01": {
      "evento": { "hayEvento": true, "nombre": "The Weeknd", "recinto": "Estadi Olímpic", "afectaExplanada": true },
      "scrapeOk": true,
      "ultimaActualizacion": "2026-09-01T04:00:00Z"
    }
  }
}
```

`docs/data/marcas.json` (lo gestiona la web): `{ "2026-09-01": "cerrado" }`

El cron solo escribe `log.json`; tus marcas solo viven en `marcas.json`. No se pisan.

---

## Puesta en marcha

### 1. Repo público

GitHub Pages gratis requiere repo público (no hay secretos en el repo). En la web de
GitHub: **Settings → General → Danger Zone → Change visibility → Public**. O por consola:

```bash
gh repo edit meowrhino/anella-olimpica --visibility public --accept-visibility-change-consequences
```

### 2. Activar GitHub Pages

**Settings → Pages → Build and deployment → Source: _Deploy from a branch_ → Branch:
`main` / carpeta `/docs`** → Save. En un par de minutos tendrás:

```
https://meowrhino.github.io/anella-olimpica/
```

### 3. Lanzar el scraper la primera vez

El cron corre de madrugada. Para tener datos ya: **pestaña Actions → "Scrape agenda Anella
Olímpica" → Run workflow**. (También se puede correr en local: `node scripts/scrape.mjs`.)

### 4. "Modo dueño" para marcar el acceso real

La web es **pública y de solo lectura**: cualquiera ve el estado, sin botones ni token.
**Marcar** el acceso real (abierto/cerrado) es algo que solo haces **tú**, en un modo oculto.

Para activarlo necesitas un **fine-grained Personal Access Token**:

1. <https://github.com/settings/personal-access-tokens> → **Generate new token**.
2. **Resource owner**: tu cuenta · **Repository access**: *Only select repositories* →
   `anella-olimpica`.
3. **Permissions → Repository → Contents: _Read and write_**. (Nada más.)
4. Copia el token, entra a la web con **`#admin`** al final de la URL
   (`https://meowrhino.github.io/anella-olimpica/#admin`) → aparece **⚙ Ajustes** → pega el
   token → Guardar. Se guarda solo en ese dispositivo (localStorage) y a partir de ahí
   verás los botones de marcar (ya sin necesidad del `#admin`).

> El público nunca ve ni el ⚙ ni los botones. Tus marcas sí son visibles para todos (es
> información útil), pero **escribirlas** solo puedes tú.

> ⚠️ No pegues el token en dispositivos compartidos. Si se filtra, solo da acceso de
> escritura a este repo; puedes revocarlo desde la misma página de GitHub.

---

## Desarrollo local

```bash
# Servir la web (modo demo si data/log.json no estuviera)
python3 -m http.server 4173 --directory docs
#   abre http://localhost:4173

# Regenerar log.json a mano
node scripts/scrape.mjs
#   o parsear un HTML guardado:  AGENDA_HTML_FILE=/ruta/agenda.html node scripts/scrape.mjs
```

---

## 🔧 Mantenimiento (LÉEME cuando el scraping deje de funcionar)

La web de la fuente cambiará de maquetación algún día y el `evento` dejará de detectarse
(verás días sin evento que deberían tenerlo, o `scrapeOk: false`). **Todo lo frágil está
en un único sitio:** `scripts/scrape.mjs`, en la función **`parsearAgenda()`** y las
constantes de selectores justo encima (`MARCADOR_EVENTO`, `RE_TITULO`, `RE_RECINTO`,
`RE_FECHA`).

### Cómo repararlo

1. Abre la fuente: <https://estadiolimpic.barcelona/es/agenda> y mira su HTML.
   Hoy (jun 2026) cada evento es así:
   ```html
   <div class="... events-list__item ... node--type-event ...">
     <div class="events-list__content-title"><span class="field--name-title">The Weeknd</span></div>
     <div class="events-list__content-name"><div class="field--name-field-place">Estadi Olímpic</div></div>
     <div class="events-list__content-date">Martes, 01 de Septiembre de 2026</div>
   </div>
   ```
2. Ajusta `MARCADOR_EVENTO` (lo que separa una tarjeta de la siguiente) y las regex de cada
   campo.
3. Si cambió el **formato de fecha** (`"Martes, 01 de Septiembre de 2026"`), ajusta
   `fechaTextoAISO()` y el mapa `MESES`.
4. Prueba: `AGENDA_HTML_FILE=/tmp/agenda.html node scripts/scrape.mjs` imprime los eventos
   detectados. Verifica que las fechas y recintos salen bien.

### Salvaguardas que ya hay

- Si la web responde mal o no se reconoce la maqueta (`scrapeOk: false`), el scraper **no
  machaca** los `evento` buenos ya guardados.
- `meta.lastrun` permite ver desde cuándo no actualiza; la web avisa si pasa de 36 h.

---

## Notas y avisos

- Esto es **scraping de una web pública para uso estrictamente personal**: 1 request/día,
  User-Agent honesto, sin evadir nada.
- La URL `barcelona.cat/casalsdebarri/verdun/...` del brief original **se descartó**: hace
  un redirect a la página del *Casal de Barri Verdún* (centro cívico de barrio), no a la
  agenda del Estadi Olímpic. La fuente buena es `estadiolimpic.barcelona`.
- Los **periodos de restricción amplios** (p. ej. *"del 27 abril al 28 julio"*) **no son
  fiables** como dato estructurado; el sistema los ignora y se basa solo en eventos
  concretos. Para los cierres reales está tu marca manual.
- **Horario base** (editable en `docs/app.js` → `HORARIOS`):
  - Verano (1 abr – 31 oct): 06:00 – 22:00
  - Invierno (1 nov – 31 mar): 06:00 – 20:00
```
