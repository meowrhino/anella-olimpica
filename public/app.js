/* =========================================================================
 * Anella Olímpica — front (vanilla JS, sin build).
 *
 * Habla con el Worker (API_BASE). Si no hay API_BASE configurada, entra en
 * MODO DEMO y lee `estado-ejemplo.json` para poder verlo funcionando.
 * ========================================================================= */

'use strict';

// --- Almacenamiento seguro -------------------------------------------------
// localStorage puede lanzar (Safari modo privado, contextos sandbox). Lo
// envolvemos para que nunca tumbe la app.
function lsGet(k) { try { return localStorage.getItem(k); } catch (_e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_e) { /* ignora */ } }
function lsDel(k) { try { localStorage.removeItem(k); } catch (_e) { /* ignora */ } }

// --- Configuración ---------------------------------------------------------
// La URL del Worker se guarda en el dispositivo (localStorage), o se puede
// fijar aquí directamente. Sin ella -> modo demo.
const API_BASE = (lsGet('apiBase') || '').replace(/\/$/, '');

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

// --- Funciones puras de fecha/horario --------------------------------------

/** ¿La fecha (YYYY-MM-DD) cae en temporada de verano? */
function esVerano(fechaISO) {
  const mmdd = fechaISO.slice(5);
  return mmdd >= HORARIOS.inicioVerano && mmdd <= HORARIOS.finVerano;
}

/** Horario base {apertura, cierre} para una fecha. */
function horarioDe(fechaISO) {
  return esVerano(fechaISO) ? HORARIOS.verano : HORARIOS.invierno;
}

/** Fecha y hora actuales en Europe/Madrid: { fechaISO, hhmm }. */
function ahoraMadrid() {
  const ahora = new Date();
  const fechaISO = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(ahora);
  const hhmm = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(ahora);
  return { fechaISO, hhmm };
}

/** ¿Está "hh:mm" dentro del horario {apertura, cierre}? (compara strings 24h) */
function estaDentroDeHorario(hhmm, h) {
  return hhmm >= h.apertura && hhmm < h.cierre;
}

/** Día de la semana (0=dom) de una fecha ISO, sin sustos de zona horaria. */
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
  return txt.charAt(0).toUpperCase() + txt.slice(1); // solo la 1ª letra
}

// ===========================================================================
// LÓGICA DEL SEMÁFORO  (orden de prioridad; siempre devuelve el motivo)
//   1. accesoReal === 'cerrado'  -> CERRADO (tu dato real manda)
//   2. accesoReal === 'abierto'  -> ABIERTO (tu dato real manda)
//   3. evento que afecta a la explanada (Estadi Olímpic) -> PROBABLE CIERRE
//   4. si no, compara la hora actual con el horario base -> ABIERTO / CERRADO
// ===========================================================================
function calcularSemaforo(dia, hhmm) {
  const h = horarioDe(dia.fecha);
  const ev = dia.evento || {};

  if (dia.accesoReal === 'cerrado') {
    return { nivel: 'cerrado', titulo: 'Cerrado', motivo: 'Confirmado por ti', horario: h };
  }
  if (dia.accesoReal === 'abierto') {
    return { nivel: 'abierto', titulo: 'Abierto', motivo: 'Confirmado por ti', horario: h };
  }
  if (ev.hayEvento && ev.afectaExplanada) {
    return {
      nivel: 'evento',
      titulo: 'Probable cierre',
      motivo: `Concierto en ${ev.recinto}${ev.nombre ? ': ' + ev.nombre : ''}`,
      horario: h,
    };
  }

  const notaEvento = ev.hayEvento && !ev.afectaExplanada
    ? `Hay evento en ${ev.recinto} (no afecta a la explanada)`
    : null;

  if (estaDentroDeHorario(hhmm, h)) {
    return { nivel: 'abierto', titulo: 'Abierto', motivo: `Dentro del horario · ${h.apertura}–${h.cierre}`, horario: h, nota: notaEvento };
  }
  return { nivel: 'cerrado', titulo: 'Cerrado', motivo: `Fuera de horario · ${h.apertura}–${h.cierre}`, horario: h, nota: notaEvento };
}

// --- Estado global del front -----------------------------------------------
let DATOS = { meta: {}, semana: [], historico: [] };

// --- Carga de datos (live o demo) ------------------------------------------
async function cargarDatos() {
  if (!API_BASE) {
    const d = await fetch('estado-ejemplo.json').then((r) => r.json());
    return {
      meta: { lastrun: d.lastrun, fuente: d.fuente, scraperStale: d.scraperStale, demo: true },
      semana: d.semana,
      historico: d.historico,
    };
  }
  const [s, h] = await Promise.all([
    fetch(`${API_BASE}/api/semana`).then((r) => r.json()),
    fetch(`${API_BASE}/api/historico`).then((r) => r.json()),
  ]);
  return {
    meta: { lastrun: s.lastrun, fuente: s.fuente, scraperStale: s.scraperStale, demo: false },
    semana: s.dias,
    historico: h.dias,
  };
}

// --- Marcar acceso real (POST con token) -----------------------------------
async function marcarAcceso(fecha, estado) {
  if (!API_BASE) {
    alert('Modo demo: configura la URL del Worker en ⚙ Ajustes para poder guardar marcas.');
    return;
  }
  let token = lsGet('accesoToken');
  if (!token) {
    token = prompt('Token de acceso (se guarda solo en este dispositivo):');
    if (!token) return;
    lsSet('accesoToken', token);
  }
  try {
    const res = await fetch(`${API_BASE}/api/acceso`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Acceso-Token': token },
      body: JSON.stringify({ fecha, estado }),
    });
    if (res.status === 403) {
      lsDel('accesoToken');
      alert('Token inválido. Inténtalo de nuevo.');
      return;
    }
    if (!res.ok) { alert('No se pudo guardar.'); return; }
    await recargar();
  } catch (_e) {
    alert('Error de red al guardar.');
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
    b.className = 'btn-acceso' + (dia.accesoReal === op.estado ? ' activo' : '') +
      (op.estado ? ` btn-${op.estado}` : ' btn-vacio');
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
    cont.innerHTML = '<p class="vacio">Aún no hay histórico. Se irá construyendo día a día desde que despliegues la app y empieces a marcar el acceso real.</p>';
    return;
  }

  const cab = document.createElement('div');
  cab.className = 'hist-row hist-cabecera';
  cab.innerHTML = '<div>Día</div><div>Evento en agenda</div><div>Acceso real</div>';
  cont.appendChild(cab);

  // Orden cronológico inverso (lo más reciente arriba).
  const dias = [...DATOS.historico].sort((a, b) => (a.fecha < b.fecha ? 1 : -1));
  dias.forEach((dia) => {
    const ev = dia.evento || {};
    const ac = etiquetaAcceso(dia.accesoReal);
    const fila = document.createElement('div');
    fila.className = 'hist-row' +
      (dia.accesoReal === 'cerrado' ? ' fila-cerrada' : '') +
      (ev.hayEvento && ev.afectaExplanada ? ' fila-evento' : '');

    const cDia = document.createElement('div');
    cDia.className = 'hist-dia';
    cDia.textContent = fechaCorta(dia.fecha);

    const cEv = document.createElement('div');
    cEv.className = 'hist-evento';
    if (ev.hayEvento) {
      const chip = chipEvento(ev);
      cEv.appendChild(chip);
    } else {
      cEv.innerHTML = '<span class="tenue">—</span>';
    }

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
  const cont = document.getElementById('meta-info');
  const m = DATOS.meta;
  const partes = [];
  if (m.demo) partes.push('🧪 modo demo (datos de ejemplo)');
  if (m.lastrun) {
    const f = new Date(m.lastrun);
    partes.push(`scraper: ${f.toLocaleString('es-ES', { timeZone: TZ })}`);
  }
  if (m.fuente) partes.push(`fuente: ${m.fuente}`);
  cont.textContent = partes.join(' · ');

  const aviso = document.getElementById('aviso-stale');
  aviso.hidden = !(m.scraperStale && !m.demo);
}

// --- Pestañas --------------------------------------------------------------
function activarTab(tab) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('activo', b.dataset.tab === tab));
  document.getElementById('vista-semana').hidden = tab !== 'semana';
  document.getElementById('vista-historico').hidden = tab !== 'historico';
}

// --- Ajustes (URL del Worker + token) --------------------------------------
function abrirAjustes() {
  document.getElementById('in-apibase').value = lsGet('apiBase') || '';
  document.getElementById('in-token').value = lsGet('accesoToken') || '';
  document.getElementById('ajustes').hidden = false;
}
function guardarAjustes() {
  const base = document.getElementById('in-apibase').value.trim();
  const token = document.getElementById('in-token').value.trim();
  if (base) lsSet('apiBase', base); else lsDel('apiBase');
  if (token) lsSet('accesoToken', token); else lsDel('accesoToken');
  location.reload();
}

// --- Orquestación ----------------------------------------------------------
async function recargar() {
  DATOS = await cargarDatos();
  renderSemaforo();
  renderSemana();
  renderHistorico();
  renderMeta();
}

function init() {
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => activarTab(b.dataset.tab)));
  document.getElementById('btn-ajustes').addEventListener('click', abrirAjustes);
  document.getElementById('btn-guardar-ajustes').addEventListener('click', guardarAjustes);
  document.getElementById('btn-cerrar-ajustes').addEventListener('click', () => { document.getElementById('ajustes').hidden = true; });
  activarTab('semana');
  recargar().catch((e) => {
    document.getElementById('semaforo').textContent = 'Error cargando datos: ' + e.message;
  });
  // Mantén fresco el semáforo de "ahora" si la página queda abierta.
  setInterval(() => { if (DATOS.semana.length) renderSemaforo(); }, 60000);
}

document.addEventListener('DOMContentLoaded', init);
