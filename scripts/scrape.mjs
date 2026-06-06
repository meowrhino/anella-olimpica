/**
 * Scrape diario de la agenda del Estadi Olímpic → docs/data/log.json
 * --------------------------------------------------------------------------
 * Lo ejecuta GitHub Actions una vez al día (ver .github/workflows/scrape.yml).
 * No usa dependencias: Node 20+ trae `fetch` e `Intl`.
 *
 * Hace lo mismo que hacía el viejo Cloudflare Worker, pero en Node:
 *   - scrapea la agenda,
 *   - por cada día (hoy + 7) guarda la señal `evento`,
 *   - acumula el histórico (no borra días viejos),
 *   - NO toca las marcas manuales (viven en docs/data/marcas.json, aparte).
 *
 * TODA la fragilidad (parseo) está en parsearAgenda() + SELECTORES, igual que
 * antes. Si el scraping se rompe, mira ahí (y la sección Mantenimiento del README).
 *
 * Uso local de prueba:
 *   AGENDA_HTML_FILE=/tmp/agenda.html node scripts/scrape.mjs   # parsea un archivo
 *   node scripts/scrape.mjs                                     # scrapea en vivo
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUTA_LOG = resolve(__dirname, '..', 'docs', 'data', 'log.json');

// === Constantes de scraping (editar aquí si la web cambia) =================
const UA = 'AnellaOlimpicaPersonal/1.0 (app personal de horarios; +https://github.com/meowrhino/anella-olimpica)';
const FUENTE_URL = 'https://estadiolimpic.barcelona/es/agenda';
const FUENTE_NOMBRE = 'estadiolimpic.barcelona';

// Marca de cada tarjeta de evento y selectores de sus campos.
const MARCADOR_EVENTO = 'node--type-event'; // 1 por evento en la clase del contenedor
const RE_TITULO = /field--name-title[^>]*>([^<]*)</;
const RE_RECINTO = /field--name-field-place[^>]*>([^<]*)</;
const RE_FECHA = /events-list__content-date[^>]*>([^<]*)</;

const MESES = {
  enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06',
  julio: '07', agosto: '08', septiembre: '09', setiembre: '09', octubre: '10',
  noviembre: '11', diciembre: '12',
};
const RE_AFECTA = /estadi olimpic|esplanada|anella/;
const TZ = 'Europe/Madrid';

// === Helpers puros =========================================================
function sinAcentos(txt) {
  return (txt || '').toLowerCase()
    .replace(/á/g, 'a').replace(/é/g, 'e').replace(/í/g, 'i')
    .replace(/ó/g, 'o').replace(/ú/g, 'u').replace(/ü/g, 'u');
}

function decodeEntidades(s) {
  return (s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

/** "Martes, 01 de Septiembre de 2026" -> "2026-09-01" (o null). */
function fechaTextoAISO(txt) {
  const m = sinAcentos(txt).match(/(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})/);
  if (!m) return null;
  const mes = MESES[m[2]];
  if (!mes) return null;
  return `${m[3]}-${mes}-${m[1].padStart(2, '0')}`;
}

/** Fecha YYYY-MM-DD en Europe/Madrid, desplazada offsetDias (ancla mediodía UTC). */
function fechaMadridISO(offsetDias = 0) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const [y, m, d] = fmt.format(new Date()).split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  base.setUTCDate(base.getUTCDate() + offsetDias);
  return base.toISOString().slice(0, 10);
}

// === Parseo de la agenda (la parte frágil) =================================
/**
 * Devuelve { eventos, layoutReconocido }.
 * Trocea el HTML por cada tarjeta de evento y extrae título, recinto y fecha.
 */
function parsearAgenda(html) {
  const layoutReconocido = html.includes(MARCADOR_EVENTO);
  if (!layoutReconocido) return { eventos: [], layoutReconocido: false };

  // Cada trozo (menos el primero) contiene una tarjeta de evento.
  const trozos = html.split(MARCADOR_EVENTO).slice(1);
  const eventos = [];
  for (const t of trozos) {
    const fechaTexto = (t.match(RE_FECHA) || [])[1];
    const fechaISO = fechaTexto ? fechaTextoAISO(fechaTexto) : null;
    if (!fechaISO) continue; // descarta tarjetas sin fecha parseable
    const recinto = decodeEntidades(((t.match(RE_RECINTO) || [])[1] || '').trim());
    const nombre = decodeEntidades(((t.match(RE_TITULO) || [])[1] || '').trim());
    eventos.push({ nombre, recinto, fechaISO, afectaExplanada: RE_AFECTA.test(sinAcentos(recinto)) });
  }
  return { eventos, layoutReconocido: true };
}

async function obtenerHTML() {
  // En pruebas locales, permite parsear un archivo en vez de la red.
  if (process.env.AGENDA_HTML_FILE) {
    return readFile(process.env.AGENDA_HTML_FILE, 'utf8');
  }
  const res = await fetch(FUENTE_URL, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} al pedir la agenda`);
  return res.text();
}

const EVENTO_VACIO = { hayEvento: false, nombre: null, recinto: null, afectaExplanada: false };

async function main() {
  let resultado;
  try {
    const html = await obtenerHTML();
    resultado = parsearAgenda(html);
  } catch (e) {
    console.error('Scrape falló:', e.message);
    resultado = { eventos: [], layoutReconocido: false };
  }
  const scrapeOk = resultado.layoutReconocido;
  const ahora = new Date().toISOString();

  console.error(`scrapeOk=${scrapeOk} · eventos detectados=${resultado.eventos.length}`);
  for (const e of resultado.eventos) {
    console.error(`  ${e.fechaISO}  afecta=${e.afectaExplanada}  ${e.recinto} — ${e.nombre}`);
  }

  // Carga el log existente (histórico acumulado).
  let log = { meta: {}, dias: {} };
  if (existsSync(RUTA_LOG)) {
    try { log = JSON.parse(await readFile(RUTA_LOG, 'utf8')); } catch { /* empieza de cero */ }
  }
  if (!log.dias) log.dias = {};

  // Indexa eventos por fecha (prioriza el que afecta a la explanada si hay varios).
  const porFecha = {};
  for (const ev of resultado.eventos) {
    const prev = porFecha[ev.fechaISO];
    if (!prev || (ev.afectaExplanada && !prev.afectaExplanada)) porFecha[ev.fechaISO] = ev;
  }

  // Actualiza hoy + 7 días.
  for (let i = 0; i < 8; i++) {
    const fecha = fechaMadridISO(i);
    const detectado = porFecha[fecha]
      ? { hayEvento: true, nombre: porFecha[fecha].nombre, recinto: porFecha[fecha].recinto, afectaExplanada: porFecha[fecha].afectaExplanada }
      : { ...EVENTO_VACIO };
    // Si el scrape no fue fiable, conserva el evento previo (datos buenos).
    const evento = scrapeOk ? detectado : (log.dias[fecha]?.evento ?? detectado);
    log.dias[fecha] = { evento, scrapeOk, ultimaActualizacion: ahora };
  }

  if (scrapeOk) {
    log.meta = { lastrun: ahora, fuente: FUENTE_NOMBRE, eventos: resultado.eventos.length };
  } else {
    log.meta = { ...log.meta, ultimoIntento: ahora };
  }

  await mkdir(dirname(RUTA_LOG), { recursive: true });
  await writeFile(RUTA_LOG, JSON.stringify(log, null, 2) + '\n');
  console.error(`Escrito ${RUTA_LOG} (${Object.keys(log.dias).length} días en el histórico)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
