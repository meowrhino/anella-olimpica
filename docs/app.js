/* =========================================================================
 * Anella Olímpica — front (vanilla JS, sin build).
 *
 * Lee datos ESTÁTICOS servidos por GitHub Pages:
 *   - data/log.json      -> señal de eventos por día (lo genera el Action diario)
 *   - data/marcas.json   -> tus marcas manuales de acceso real
 * Guarda tus marcas escribiendo data/marcas.json con la API de GitHub
 * (necesita un token PAT con permiso Contents read/write sobre el repo).
 *
 * Si data/log.json aún no existe (antes del primer scrape), cae a modo demo
 * con estado-ejemplo.json.
 * ========================================================================= */

'use strict';

// --- Repo de GitHub donde viven los datos ----------------------------------
const GH_OWNER = 'meowrhino';
const GH_REPO = 'anella-olimpica';
const GH_MARCAS_PATH = 'docs/data/marcas.json';
const GH_API_MARCAS = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_MARCAS_PATH}`;

// --- Almacenamiento seguro (Safari privado / sandbox pueden bloquearlo) -----
function lsGet(k) { try { return localStorage.getItem(k); } catch (_e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_e) { /* ignora */ } }
function lsDel(k) { try { localStorage.removeItem(k); } catch (_e) { /* ignora */ } }

// ===========================================================================
// HORARIO BASE  —  ÚNICA fuente de verdad del horario. Edita SOLO aquí.
// Esplanada de l'Anella Olímpica. Mismo horario todos los días.
// ===========================================================================
const HORARIOS = {
  inicioVerano: '04-01', // 1 de abril
  finVerano: '10-31', // 31 de octubre (incluido)
  verano: { apertura: '06:00', cierre: '22:00' },
  invierno: { apertura: '06:00', cierre: '20:00' },
};

const TZ = 'Europe/Madrid';
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const DIAS_LARGO = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES_ABBR = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MESES_LARGO = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const EVENTO_VACIO = { hayEvento: false, nombre: null, recinto: null, afectaExplanada: false };

// --- Funciones puras de fecha/horario --------------------------------------
function esVerano(fechaISO) {
  const mmdd = fechaISO.slice(5);
  return mmdd >= HORARIOS.inicioVerano && mmdd <= HORARIOS.finVerano;
}
function horarioDe(fechaISO) {
  return esVerano(fechaISO) ? HORARIOS.verano : HORARIOS.invierno;
}
function ahoraMadrid() {
  const ahora = new Date();
  const fechaISO = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ahora);
  const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(ahora);
  return { fechaISO, hhmm };
}
/** Fecha YYYY-MM-DD en Europe/Madrid desplazada offsetDias (ancla mediodía UTC). */
function fechaMadridISO(offsetDias = 0) {
  const [y, m, d] = ahoraMadrid().fechaISO.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  base.setUTCDate(base.getUTCDate() + offsetDias);
  return base.toISOString().slice(0, 10);
}
function estaDentroDeHorario(hhmm, h) {
  return hhmm >= h.apertura && hhmm < h.cierre;
}
function diaSemana(fechaISO) {
  return new Date(fechaISO + 'T12:00:00Z').getUTCDay();
}
function fechaCorta(fechaISO) {
  const d = Number(fechaISO.slice(8, 10));
  const m = Number(fechaISO.slice(5, 7)) - 1;
  return `${DIAS[diaSemana(fechaISO)]} ${d} ${MESES_ABBR[m]}`;
}
function fechaLarga(fechaISO) {
  const d = Number(fechaISO.slice(8, 10));
  const m = Number(fechaISO.slice(5, 7)) - 1;
  const txt = `${DIAS_LARGO[diaSemana(fechaISO)]}, ${d} de ${MESES_LARGO[m]}`;
  return txt.charAt(0).toUpperCase() + txt.slice(1);
}

// ===========================================================================
// LÓGICA DEL SEMÁFORO (orden de prioridad; siempre devuelve el motivo)
//   1. accesoReal 'cerrado' -> CERRADO   2. accesoReal 'abierto' -> ABIERTO
//   3. evento que afecta a la explanada -> PROBABLE CIERRE
//   4. si no, hora actual vs horario base -> ABIERTO / CERRADO
// ===========================================================================
function calcularSemaforo(dia, hhmm) {
  const h = horarioDe(dia.fecha);
  const ev = dia.evento || {};
  if (dia.accesoReal === 'cerrado') return { nivel: 'cerrado', titulo: 'Cerrado', motivo: 'Confirmado por ti', horario: h };
  if (dia.accesoReal === 'abierto') return { nivel: 'abierto', titulo: 'Abierto', motivo: 'Confirmado por ti', horario: h };
  if (ev.hayEvento && ev.afectaExplanada) {
    return { nivel: 'evento', titulo: 'Probable cierre', motivo: `Concierto en ${ev.recinto}${ev.nombre ? ': ' + ev.nombre : ''}`, horario: h };
  }
  const notaEvento = ev.hayEvento && !ev.afectaExplanada ? `Hay evento en ${ev.recinto} (no afecta a la explanada)` : null;
  if (estaDentroDeHorario(hhmm, h)) {
    return { nivel: 'abierto', titulo: 'Abierto', motivo: `Dentro del horario · ${h.apertura}–${h.cierre}`, horario: h, nota: notaEvento };
  }
  return { nivel: 'cerrado', titulo: 'Cerrado', motivo: `Fuera de horario · ${h.apertura}–${h.cierre}`, horario: h, nota: notaEvento };
}

// --- Estado global ---------------------------------------------------------
let LOG = { meta: {}, dias: {} };
let MARCAS = {};
let META = {};
let DATOS = { semana: [], historico: [] };

// --- Carga de datos --------------------------------------------------------
async function fetchJSON(url) {
  const r = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${url}`);
  return r.json();
}

function esStale(lastrun) {
  return lastrun ? Date.now() - Date.parse(lastrun) > 36 * 3600 * 1000 : true;
}

/** Reconstruye DATOS (semana + histórico) a partir de LOG y MARCAS. */
function derivar() {
  const dias = LOG.dias || {};
  const fila = (fecha) => {
    const d = dias[fecha] || { evento: { ...EVENTO_VACIO }, scrapeOk: null };
    return { fecha, evento: d.evento || { ...EVENTO_VACIO }, accesoReal: MARCAS[fecha] ?? null, scrapeOk: d.scrapeOk ?? null };
  };
  const semana = [];
  for (let i = 0; i < 8; i++) semana.push(fila(fechaMadridISO(i)));
  const claves = new Set([...Object.keys(dias), ...Object.keys(MARCAS)]);
  const historico = [...claves].map(fila);
  DATOS = { semana, historico };
}

async function recargar() {
  try {
    LOG = await fetchJSON('data/log.json');
    MARCAS = await fetchJSON('data/marcas.json').catch(() => ({}));
    if (!LOG.dias) LOG.dias = {};
    META = { lastrun: LOG.meta?.lastrun, fuente: LOG.meta?.fuente, scraperStale: esStale(LOG.meta?.lastrun), demo: false };
    derivar();
  } catch (_e) {
    // Aún no hay datos desplegados -> modo demo.
    const d = await fetchJSON('estado-ejemplo.json');
    DATOS = { semana: d.semana, historico: d.historico };
    META = { lastrun: d.lastrun, fuente: d.fuente, scraperStale: false, demo: true };
  }
  render();
}

// --- Marcado de acceso real (API de GitHub) --------------------------------
function ghHeaders(token) {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
}
function errConCodigo(status, msg) {
  return Object.assign(new Error(`${msg} (HTTP ${status})`), { code: status });
}
function aB64(str) { return btoa(unescape(encodeURIComponent(str))); }
function deB64(b64) { return decodeURIComponent(escape(atob((b64 || '').replace(/\n/g, '')))); }
function ordenarClaves(obj) {
  return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
}

async function leerMarcasRemoto(token) {
  const r = await fetch(`${GH_API_MARCAS}?t=${Date.now()}`, { headers: ghHeaders(token), cache: 'no-store' });
  if (r.status === 404) return { obj: {}, sha: undefined };
  if (!r.ok) throw errConCodigo(r.status, 'leer marcas');
  const j = await r.json();
  let obj = {};
  try { obj = JSON.parse(deB64(j.content)); } catch (_e) { /* archivo vacío/corrupto -> {} */ }
  return { obj, sha: j.sha };
}

async function escribirMarca(fecha, estado, token) {
  // Reintenta una vez si el sha quedó viejo (el Action commiteó en medio -> 409).
  for (let intento = 0; intento < 2; intento++) {
    const { obj, sha } = await leerMarcasRemoto(token);
    if (estado === null) delete obj[fecha]; else obj[fecha] = estado;
    const body = JSON.stringify({
      message: `marca: ${fecha} = ${estado ?? 'sin dato'}`,
      content: aB64(JSON.stringify(ordenarClaves(obj), null, 2) + '\n'),
      sha,
    });
    const r = await fetch(GH_API_MARCAS, { method: 'PUT', headers: ghHeaders(token), body });
    if (r.ok) return;
    if (r.status === 409 && intento === 0) continue;
    throw errConCodigo(r.status, 'guardar marca');
  }
}

async function marcarAcceso(fecha, estado) {
  let token = lsGet('ghToken');
  if (!token) {
    const entrada = prompt('Token (PAT) de GitHub con permiso Contents read/write sobre el repo (se guarda solo en este dispositivo):');
    if (!entrada) return;
    token = entrada.trim();
    lsSet('ghToken', token);
  }
  try {
    await escribirMarca(fecha, estado, token);
    if (estado === null) delete MARCAS[fecha]; else MARCAS[fecha] = estado; // optimista
    derivar();
    render();
  } catch (e) {
    if (e.code === 401 || e.code === 403) {
      lsDel('ghToken');
      alert('Token inválido o sin permisos. Vuelve a intentarlo en ⚙ Ajustes.');
    } else {
      alert('No se pudo guardar: ' + e.message);
    }
  }
}

// --- Render: semáforo de HOY -----------------------------------------------
function renderSemaforo() {
  const hoy = DATOS.semana[0];
  const card = document.getElementById('semaforo');
  if (!hoy) { card.textContent = 'Sin datos.'; return; }
  const { hhmm } = ahoraMadrid();
  const s = calcularSemaforo(hoy, hhmm);
  card.className = `semaforo estado-${s.nivel}`;
  card.innerHTML = `
    <div class="sem-fecha">${fechaLarga(hoy.fecha)}</div>
    <div class="sem-estado">${s.titulo}</div>
    <div class="sem-motivo">${s.motivo}</div>
    <div class="sem-horario">Horario de hoy: ${s.horario.apertura}–${s.horario.cierre}</div>
    ${s.nota && s.nivel !== 'evento' && !hoy.accesoReal ? `<div class="sem-nota">${s.nota}</div>` : ''}
  `;
}

// --- Render: controles de marcado ------------------------------------------
function controlesAcceso(dia) {
  const cont = document.createElement('div');
  cont.className = 'acceso-control';
  const opciones = [
    { estado: 'abierto', etiqueta: 'Abierto' },
    { estado: 'cerrado', etiqueta: 'Cerrado' },
    { estado: null, etiqueta: '—' },
  ];
  for (const op of opciones) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = op.etiqueta;
    b.className = 'btn-acceso' + (dia.accesoReal === op.estado ? ' activo' : '') + (op.estado ? ` btn-${op.estado}` : ' btn-vacio');
    b.addEventListener('click', () => marcarAcceso(dia.fecha, op.estado));
    cont.appendChild(b);
  }
  return cont;
}

// --- Render: chip de evento ------------------------------------------------
function chipEvento(ev) {
  if (!ev || !ev.hayEvento) return null;
  const span = document.createElement('span');
  span.className = 'chip ' + (ev.afectaExplanada ? 'chip-afecta' : 'chip-cubierto');
  span.textContent = `${ev.nombre || 'Evento'} · ${ev.recinto || ''}`.trim();
  span.title = ev.afectaExplanada ? 'Concierto en el Estadi Olímpic (afecta a la explanada)' : 'Recinto cubierto (no afecta a la explanada)';
  return span;
}

// --- Render: próximos 7 días -----------------------------------------------
function renderSemana() {
  const cont = document.getElementById('vista-semana');
  cont.innerHTML = '';
  const hoyISO = ahoraMadrid().fechaISO;
  DATOS.semana.forEach((dia) => {
    const h = horarioDe(dia.fecha);
    const fila = document.createElement('div');
    fila.className = 'dia-row' + (dia.fecha === hoyISO ? ' es-hoy' : '');
    const izq = document.createElement('div');
    izq.className = 'dia-info';
    const fecha = document.createElement('div');
    fecha.className = 'dia-fecha';
    fecha.textContent = fechaCorta(dia.fecha) + (dia.fecha === hoyISO ? ' · hoy' : '');
    const horario = document.createElement('div');
    horario.className = 'dia-horario';
    horario.textContent = `${h.apertura}–${h.cierre}`;
    izq.appendChild(fecha);
    izq.appendChild(horario);
    const chip = chipEvento(dia.evento);
    if (chip) izq.appendChild(chip);
    fila.appendChild(izq);
    fila.appendChild(controlesAcceso(dia));
    cont.appendChild(fila);
  });
}

// --- Render: histórico / patrón --------------------------------------------
function etiquetaAcceso(estado) {
  if (estado === 'abierto') return { txt: 'Abierto', cls: 'ac-abierto' };
  if (estado === 'cerrado') return { txt: 'Cerrado', cls: 'ac-cerrado' };
  return { txt: 'sin dato', cls: 'ac-vacio' };
}

function renderHistorico() {
  const cont = document.getElementById('vista-historico');
  cont.innerHTML = '';
  if (!DATOS.historico.length) {
    cont.innerHTML = '<p class="vacio">Aún no hay histórico. Se irá construyendo día a día desde que el scraper corra y empieces a marcar el acceso real.</p>';
    return;
  }
  const cab = document.createElement('div');
  cab.className = 'hist-row hist-cabecera';
  cab.innerHTML = '<div>Día</div><div>Evento en agenda</div><div>Acceso real</div>';
  cont.appendChild(cab);
  const dias = [...DATOS.historico].sort((a, b) => (a.fecha < b.fecha ? 1 : -1)); // reciente arriba
  dias.forEach((dia) => {
    const ev = dia.evento || {};
    const ac = etiquetaAcceso(dia.accesoReal);
    const fila = document.createElement('div');
    fila.className = 'hist-row' + (dia.accesoReal === 'cerrado' ? ' fila-cerrada' : '') + (ev.hayEvento && ev.afectaExplanada ? ' fila-evento' : '');
    const cDia = document.createElement('div');
    cDia.className = 'hist-dia';
    cDia.textContent = fechaCorta(dia.fecha);
    const cEv = document.createElement('div');
    cEv.className = 'hist-evento';
    if (ev.hayEvento) cEv.appendChild(chipEvento(ev));
    else cEv.innerHTML = '<span class="tenue">—</span>';
    const cAc = document.createElement('div');
    cAc.className = 'hist-acceso';
    cAc.innerHTML = `<span class="ac-chip ${ac.cls}">${ac.txt}</span>`;
    fila.appendChild(cDia);
    fila.appendChild(cEv);
    fila.appendChild(cAc);
    cont.appendChild(fila);
  });
}

// --- Render: meta / pie ----------------------------------------------------
function renderMeta() {
  const partes = [];
  if (META.demo) partes.push('🧪 modo demo (datos de ejemplo)');
  if (META.lastrun) partes.push(`actualizado: ${new Date(META.lastrun).toLocaleString('es-ES', { timeZone: TZ })}`);
  if (META.fuente) partes.push(`fuente: ${META.fuente}`);
  document.getElementById('meta-info').textContent = partes.join(' · ');
  document.getElementById('aviso-stale').hidden = !(META.scraperStale && !META.demo);
}

function render() {
  renderSemaforo();
  renderSemana();
  renderHistorico();
  renderMeta();
}

// --- Pestañas --------------------------------------------------------------
function activarTab(tab) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('activo', b.dataset.tab === tab));
  document.getElementById('vista-semana').hidden = tab !== 'semana';
  document.getElementById('vista-historico').hidden = tab !== 'historico';
}

// --- Ajustes (token PAT de GitHub) -----------------------------------------
function abrirAjustes() {
  document.getElementById('in-token').value = lsGet('ghToken') || '';
  document.getElementById('ajustes').hidden = false;
}
function guardarAjustes() {
  const token = document.getElementById('in-token').value.trim();
  if (token) lsSet('ghToken', token); else lsDel('ghToken');
  document.getElementById('ajustes').hidden = true;
}

// --- Init ------------------------------------------------------------------
function init() {
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => activarTab(b.dataset.tab)));
  document.getElementById('btn-ajustes').addEventListener('click', abrirAjustes);
  document.getElementById('btn-guardar-ajustes').addEventListener('click', guardarAjustes);
  document.getElementById('btn-cerrar-ajustes').addEventListener('click', () => { document.getElementById('ajustes').hidden = true; });
  activarTab('semana');
  recargar().catch((e) => { document.getElementById('semaforo').textContent = 'Error cargando datos: ' + e.message; });
  setInterval(() => { if (DATOS.semana.length) renderSemaforo(); }, 60000); // mantén "ahora" fresco
}

document.addEventListener('DOMContentLoaded', init);
