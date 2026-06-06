/**
 * Worker "¿Está abierta la Anella Olímpica?"
 * --------------------------------------------------------------------------
 * Un único Cloudflare Worker que hace DOS cosas:
 *   1) scheduled(): una vez al día (cron) scrapea la agenda del Estadi Olímpic
 *      y guarda, por cada día (hoy + 7), si hay evento. NUNCA toca `accesoReal`.
 *   2) fetch(): expone una pequeña API JSON para el front (Cloudflare Pages).
 *
 * Persistencia: Cloudflare KV (binding `ANELLA_KV`).
 *   - log:YYYY-MM-DD  -> { fecha, evento, accesoReal, scrapeOk, ultimaActualizacion }
 *   - meta:lastrun    -> { ts, fuente, eventos }
 *
 * TODA la fragilidad (parseo de HTML) está aislada en `parsearAgenda()` y en la
 * constante `SELECTORES`. Si el scraping se rompe, ahí es donde hay que mirar.
 * Ver sección "Mantenimiento" del README.
 */

// ===========================================================================
// CONSTANTES DE SCRAPING  (esto es lo que toca editar si la web cambia)
// ===========================================================================

// User-Agent honesto: nos identificamos, 1 request/día, sin evadir nada.
const UA =
  'AnellaOlimpicaPersonal/1.0 (app personal de horarios; +https://github.com/meowrhino/anella-olimpica)';

/**
 * Fuentes de datos, en orden de preferencia. Arquitectura multi-fuente: se
 * prueban en orden y se usa la primera cuyo parser reconozca la maqueta.
 *
 * NOTA (jun 2026): la URL "barcelona.cat/casalsdebarri/verdun/..." que figuraba
 * en el brief NO es la agenda del Estadi Olímpic: hace un 301 a la página del
 * "Casal de Barri Verdún" (centro cívico de barrio, eventos irrelevantes).
 * Por eso se ha descartado como fuente. Si algún día encuentras una segunda
 * fuente fiable, añádela aquí con su propio `parser`.
 */
const FUENTES = [
  {
    nombre: 'estadiolimpic.barcelona',
    url: 'https://estadiolimpic.barcelona/es/agenda',
    parser: parsearAgenda, // parser específico de esta maqueta (Drupal)
  },
];

/**
 * Selectores CSS de la agenda de estadiolimpic.barcelona (Drupal).
 * Estructura real de cada tarjeta de evento (verificado jun 2026):
 *
 *   <div class="... events-list__item ...">              <- contenedor (1 por evento)
 *     ...
 *     <div class="events-list__content-title">
 *       <span class="field field--name-title ...">The Weeknd</span>   <- TÍTULO
 *     </div>
 *     <div class="events-list__content-name">
 *       <div class="field field--name-field-place ...">Estadi Olímpic</div>  <- RECINTO
 *     </div>
 *     <div class="events-list__content-date">Martes, 01 de Septiembre de 2026</div>  <- FECHA
 *   </div>
 *
 * Los selectores apuntan al elemento que CONTIENE DIRECTAMENTE el texto
 * (HTMLRewriter sólo entrega texto del nodo que matchea, no de sus hijos).
 */
const SELECTORES = {
  item: '.events-list__item', // marca el inicio de un evento nuevo
  titulo: '.events-list__content-title .field--name-title',
  recinto: '.events-list__content-name .field--name-field-place',
  fecha: '.events-list__content-date',
};

// Meses en español -> número. Sin acentos (normalizamos antes de buscar).
const MESES = {
  enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06',
  julio: '07', agosto: '08', septiembre: '09', setiembre: '09', octubre: '10',
  noviembre: '11', diciembre: '12',
};

// Un evento afecta a la EXPLANADA (al aire libre) sólo si es en el Estadi
// Olímpic / la propia Esplanada / Anella. Palau Sant Jordi y Sant Jordi Club
// son recintos CUBIERTOS: se registran igual, pero no disparan cierre.
const RE_AFECTA = /estadi olimpic|esplanada|anella/;

const TZ = 'Europe/Madrid';

// ===========================================================================
// HELPERS DE FECHA
// ===========================================================================

/**
 * Quita acentos y pasa a minúsculas, para comparar/parsear texto en español.
 * Mapeo explícito de vocales acentuadas (caracteres estables y legibles) en vez
 * de un rango Unicode de diacríticos combinantes (frágil en el código fuente).
 */
function sinAcentos(txt) {
  return (txt || '')
    .toLowerCase()
    .replace(/á/g, 'a').replace(/é/g, 'e').replace(/í/g, 'i')
    .replace(/ó/g, 'o').replace(/ú/g, 'u').replace(/ü/g, 'u');
}

/**
 * Devuelve la fecha "YYYY-MM-DD" en zona Europe/Madrid, desplazada `offsetDias`.
 * Anclamos a mediodía UTC del día de Madrid para que sumar días no se vea
 * afectado por cambios de horario de verano (DST).
 */
function fechaMadridISO(offsetDias = 0) {
  const ahora = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [y, m, d] = fmt.format(ahora).split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  base.setUTCDate(base.getUTCDate() + offsetDias);
  return base.toISOString().slice(0, 10);
}

/**
 * "Martes, 01 de Septiembre de 2026" -> "2026-09-01" (o null si no parsea).
 * Tolerante a acentos y a la coma/día de la semana iniciales.
 */
function fechaTextoAISO(txt) {
  const limpio = sinAcentos(txt);
  const m = limpio.match(/(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})/);
  if (!m) return null;
  const dia = m[1].padStart(2, '0');
  const mes = MESES[m[2]];
  const anio = m[3];
  if (!mes) return null;
  return `${anio}-${mes}-${dia}`;
}

// ===========================================================================
// PARSEO DE LA AGENDA  (la parte frágil — aislada a propósito)
// ===========================================================================

/**
 * Parsea el HTML de la agenda de estadiolimpic.barcelona con HTMLRewriter.
 * Devuelve { eventos, layoutReconocido }.
 *   - eventos: [{ nombre, recinto, fechaISO, afectaExplanada }]
 *   - layoutReconocido: true si el HTML contenía el contenedor esperado.
 *     Si es false, asumimos que la maqueta cambió y NO pisamos datos buenos.
 *
 * Si esto deja de devolver eventos, mira la constante SELECTORES de arriba y
 * compárala con el HTML real (ver fuente, buscar "events-list__item").
 */
async function parsearAgenda(html) {
  const layoutReconocido = html.includes('events-list__item');
  if (!layoutReconocido) return { eventos: [], layoutReconocido: false };

  const registros = [];
  let actual = null;

  const rewriter = new HTMLRewriter()
    // Cada contenedor abre un registro nuevo. Como HTMLRewriter recorre el
    // documento en orden, este handler salta ANTES que los de texto de dentro.
    .on(SELECTORES.item, {
      element() {
        actual = { nombre: '', recinto: '', fechaTexto: '' };
        registros.push(actual);
      },
    })
    // El texto llega "troceado": acumulamos en el registro actual.
    .on(SELECTORES.titulo, { text(t) { if (actual) actual.nombre += t.text; } })
    .on(SELECTORES.recinto, { text(t) { if (actual) actual.recinto += t.text; } })
    .on(SELECTORES.fecha, { text(t) { if (actual) actual.fechaTexto += t.text; } });

  // .transform() es perezoso: hay que consumir el cuerpo para que parsee.
  await rewriter.transform(new Response(html)).arrayBuffer();

  const eventos = registros
    .map((r) => {
      const fechaISO = fechaTextoAISO(r.fechaTexto);
      const recinto = r.recinto.trim();
      return {
        nombre: r.nombre.trim(),
        recinto,
        fechaISO,
        afectaExplanada: RE_AFECTA.test(sinAcentos(recinto)),
      };
    })
    .filter((e) => e.fechaISO); // descarta tarjetas sin fecha parseable

  return { eventos, layoutReconocido: true };
}

/**
 * Recorre FUENTES en orden y devuelve la primera que reconozca su maqueta.
 * { eventos, layoutReconocido, fuente }. Cada fuente va en su propio try/catch:
 * si una falla (red, 4xx/5xx, parser), se prueba la siguiente sin romper.
 */
async function scrapearAgenda() {
  for (const fuente of FUENTES) {
    try {
      const res = await fetch(fuente.url, {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
        cf: { cacheTtl: 0 },
      });
      if (!res.ok) continue;
      const html = await res.text();
      const { eventos, layoutReconocido } = await fuente.parser(html);
      if (layoutReconocido) {
        return { eventos, layoutReconocido: true, fuente: fuente.nombre };
      }
    } catch (_e) {
      // siguiente fuente
    }
  }
  return { eventos: [], layoutReconocido: false, fuente: null };
}

// ===========================================================================
// CRON: actualizar los logs de hoy + 7 días
// ===========================================================================

const EVENTO_VACIO = { hayEvento: false, nombre: null, recinto: null, afectaExplanada: false };

/**
 * Lógica del cron. Devuelve un resumen (útil para el endpoint manual de
 * refresco y para los logs).
 *
 * Regla de oro: NUNCA sobrescribe `accesoReal`. Y si el scrape falla
 * (layout no reconocido), preserva el `evento` previo de cada día.
 */
async function procesarCron(env) {
  const resultado = await scrapearAgenda();
  const scrapeOk = resultado.layoutReconocido;
  const ahora = new Date().toISOString();

  // Indexa eventos por fecha. Si hay varios el mismo día, prioriza el que
  // afecta a la explanada (Estadi Olímpic) sobre uno cubierto.
  const porFecha = {};
  for (const ev of resultado.eventos) {
    const prev = porFecha[ev.fechaISO];
    if (!prev || (ev.afectaExplanada && !prev.afectaExplanada)) porFecha[ev.fechaISO] = ev;
  }

  const dias = [];
  for (let i = 0; i < 8; i++) {
    const fecha = fechaMadridISO(i);
    const key = `log:${fecha}`;
    const prev = await env.ANELLA_KV.get(key, 'json');

    const detectado = porFecha[fecha]
      ? {
          hayEvento: true,
          nombre: porFecha[fecha].nombre,
          recinto: porFecha[fecha].recinto,
          afectaExplanada: porFecha[fecha].afectaExplanada,
        }
      : { ...EVENTO_VACIO };

    // Si el scrape NO fue fiable, conservamos el evento previo (datos buenos).
    const evento = scrapeOk ? detectado : (prev?.evento ?? detectado);

    const registro = {
      fecha,
      evento,
      accesoReal: prev?.accesoReal ?? null, // <- jamás se toca aquí
      accesoRealActualizado: prev?.accesoRealActualizado ?? null,
      scrapeOk,
      ultimaActualizacion: ahora,
    };
    await env.ANELLA_KV.put(key, JSON.stringify(registro));
    dias.push(registro);
  }

  if (scrapeOk) {
    await env.ANELLA_KV.put(
      'meta:lastrun',
      JSON.stringify({ ts: ahora, fuente: resultado.fuente, eventos: resultado.eventos.length }),
    );
  }

  return { scrapeOk, fuente: resultado.fuente, eventosDetectados: resultado.eventos.length, dias };
}

// ===========================================================================
// API HTTP
// ===========================================================================

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const permitido = env.ORIGEN_PERMITIDO || '';
  // Permite el dominio de Pages configurado + localhost (para desarrollo).
  const ok =
    origin &&
    (origin === permitido || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Acceso-Token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (ok) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(obj, request, env, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(request, env) },
  });
}

/** El POST de acceso real va protegido por un token simple en header. */
function autorizado(request, env) {
  const token = request.headers.get('X-Acceso-Token') || '';
  return Boolean(env.ACCESO_TOKEN) && token === env.ACCESO_TOKEN;
}

async function leerSemana(env) {
  const dias = [];
  for (let i = 0; i < 8; i++) {
    const fecha = fechaMadridISO(i);
    const v = await env.ANELLA_KV.get(`log:${fecha}`, 'json');
    dias.push(
      v || { fecha, evento: { ...EVENTO_VACIO }, accesoReal: null, scrapeOk: null, ultimaActualizacion: null },
    );
  }
  return dias;
}

async function leerHistorico(env, desde) {
  const dias = [];
  let cursor;
  do {
    const res = await env.ANELLA_KV.list({ prefix: 'log:', cursor });
    for (const k of res.keys) {
      const fecha = k.name.slice('log:'.length);
      if (desde && fecha < desde) continue;
      const v = await env.ANELLA_KV.get(k.name, 'json');
      if (v) dias.push(v);
    }
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
  dias.sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
  return dias;
}

async function metaScraper(env) {
  const meta = await env.ANELLA_KV.get('meta:lastrun', 'json');
  const lastrun = meta?.ts || null;
  const stale = lastrun ? Date.now() - Date.parse(lastrun) > 36 * 3600 * 1000 : true;
  return { lastrun, fuente: meta?.fuente || null, scraperStale: stale };
}

async function manejarFetch(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;

  // Preflight CORS
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }

  // GET /api/semana -> hoy + 7 días con señales + meta del scraper
  if (request.method === 'GET' && pathname === '/api/semana') {
    const [dias, meta] = await Promise.all([leerSemana(env), metaScraper(env)]);
    return json({ generadoEn: new Date().toISOString(), ...meta, dias }, request, env);
  }

  // GET /api/historico?desde=YYYY-MM-DD -> todos los días registrados
  if (request.method === 'GET' && pathname === '/api/historico') {
    const desde = url.searchParams.get('desde') || null;
    const [dias, meta] = await Promise.all([leerHistorico(env, desde), metaScraper(env)]);
    return json({ generadoEn: new Date().toISOString(), ...meta, dias }, request, env);
  }

  // POST /api/acceso  { fecha, estado } -> setea SOLO accesoReal (token)
  if (request.method === 'POST' && pathname === '/api/acceso') {
    if (!autorizado(request, env)) return json({ error: 'token inválido' }, request, env, 403);
    const body = await request.json().catch(() => null);
    if (!body || !/^\d{4}-\d{2}-\d{2}$/.test(body.fecha || '')) {
      return json({ error: 'fecha inválida (usa YYYY-MM-DD)' }, request, env, 400);
    }
    let estado = body.estado;
    if (estado === 'null' || estado === '') estado = null;
    if (!['abierto', 'cerrado', null].includes(estado)) {
      return json({ error: 'estado debe ser "abierto", "cerrado" o null' }, request, env, 400);
    }
    const key = `log:${body.fecha}`;
    const prev = (await env.ANELLA_KV.get(key, 'json')) || {
      fecha: body.fecha, evento: { ...EVENTO_VACIO }, accesoReal: null, scrapeOk: null, ultimaActualizacion: null,
    };
    prev.accesoReal = estado; // <- ÚNICO campo que toca este endpoint
    prev.accesoRealActualizado = new Date().toISOString();
    await env.ANELLA_KV.put(key, JSON.stringify(prev));
    return json({ ok: true, registro: prev }, request, env);
  }

  // POST /api/refrescar -> dispara el cron manualmente (token). Útil para no
  // esperar a la madrugada tras desplegar, y para tests.
  if (request.method === 'POST' && pathname === '/api/refrescar') {
    if (!autorizado(request, env)) return json({ error: 'token inválido' }, request, env, 403);
    const resumen = await procesarCron(env);
    return json({ ok: true, ...resumen }, request, env);
  }

  // Raíz: pequeña ayuda para depurar (no es la web; la web está en Pages).
  if (request.method === 'GET' && (pathname === '/' || pathname === '/api')) {
    return json(
      {
        servicio: 'Anella Olímpica — API',
        endpoints: ['GET /api/semana', 'GET /api/historico?desde=YYYY-MM-DD', 'POST /api/acceso', 'POST /api/refrescar'],
      },
      request, env,
    );
  }

  return json({ error: 'no encontrado' }, request, env, 404);
}

// ===========================================================================
// EXPORT
// ===========================================================================

export default {
  // Cron Trigger (ver wrangler.toml). El horario del cron es UTC.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(procesarCron(env));
  },
  async fetch(request, env, _ctx) {
    return manejarFetch(request, env);
  },
};
