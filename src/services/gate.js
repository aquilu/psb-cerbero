'use strict';

const { AlmaError, AlmaNotFoundError, AlmaUnauthorizedError } = require('../alma/client');

const VERDICTS = Object.freeze({
  PRESTADO: 'PRESTADO',
  PRESTADO_VENCIDO: 'PRESTADO_VENCIDO',
  NO_PRESTADO: 'NO_PRESTADO',
  EN_PROCESO: 'EN_PROCESO',
  NO_ENCONTRADO: 'NO_ENCONTRADO',
  CODIGO_INVALIDO: 'CODIGO_INVALIDO',
  ERROR_ALMA: 'ERROR_ALMA',
});

// Un préstamo vencido no autoriza la salida: la decide un representante de la biblioteca.
const ALLOWED = new Set([VERDICTS.PRESTADO]);

const MESSAGES = {
  [VERDICTS.PRESTADO]: 'Préstamo activo para este ejemplar.',
  [VERDICTS.PRESTADO_VENCIDO]: 'Préstamo vencido. La salida debe autorizarla un representante de la biblioteca.',
  [VERDICTS.NO_PRESTADO]: 'Este ejemplar no está prestado. El usuario debe pasar por el mostrador de préstamo.',
  [VERDICTS.EN_PROCESO]: 'El ejemplar no está prestado. Verifique en el mostrador de préstamo.',
  [VERDICTS.NO_ENCONTRADO]: 'No existe ningún ejemplar con este código de barras.',
  [VERDICTS.CODIGO_INVALIDO]: 'El código leído no es válido. Vuelva a escanear.',
  [VERDICTS.ERROR_ALMA]: 'No fue posible consultar Alma. Verifique el préstamo manualmente.',
};

// Alma devuelve estas descripciones en inglés
const BASE_STATUS_LABELS = { 1: 'En estantería', 0: 'Fuera de estantería' };
const PROCESS_LABELS = {
  LOAN: 'Prestado',
  TRANSIT: 'En tránsito',
  TRANSIT_TO_REMOTE_STORAGE: 'En tránsito a depósito remoto',
  HOLDSHELF: 'En estante de reservas',
  REQUESTED: 'Solicitado',
  MISSING: 'No localizado',
  LOST_LOAN: 'Perdido',
  LOST_LOAN_AND_PAID: 'Perdido y pagado',
  CLAIMED_RETURNED_LOAN: 'Reclamado como devuelto',
  TECHNICAL: 'En proceso técnico',
  ACQ: 'En adquisición',
  WORK_ORDER_DEPARTMENT: 'En orden de trabajo',
  BINDERY: 'En encuadernación',
  ILL: 'En préstamo interbibliotecario',
};

const BARCODE_RE =/^[\p{L}\p{N}][\p{L}\p{N} ._/-]{0,63}$/u;
// Cuánto tiempo se recuerda que la API key no tiene permiso de Usuarios, para no repetir la llamada.
const USERS_DENIED_TTL_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeBarcode(raw) {
  return String(raw ?? '').replace(/\p{Cc}/gu, '').trim();
}

// Quita la puntuación final de los campos MARC ("Título /", "Autor,", "1982.").
function cleanMarc(value) {
  if (!value) return null;
  return String(value).replace(/[\s/:;,.=]+$/u, '').trim() || null;
}

function firstIsbn(value) {
  const match = String(value ?? '').replace(/-/g, '').match(/\b(97[89]\d{10}|\d{9}[\dXx])\b/);
  return match ? match[1].toUpperCase() : null;
}

function daysText(n) {
  return `${n} ${n === 1 ? 'día' : 'días'}`;
}

function maskId(id) {
  const s = String(id);
  return s.length <= 4 ? s : '•'.repeat(Math.min(s.length - 4, 6)) + s.slice(-4);
}

// Fecha de calendario (YYYY-MM-DD) en la zona horaria dada.
function calendarDay(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function daysBetween(fromDay, toDay) {
  return Math.round((Date.parse(toDay) - Date.parse(fromDay)) / DAY_MS);
}

// Alma guarda los préstamos por días con hora 00:00 UTC: esa fecha es el día de vencimiento,
// no la medianoche UTC (que en Bogotá sería el día anterior a las 19:00).
function describeDueDate(isoString, now, timeZone) {
  if (!isoString) return null;
  const due = new Date(isoString);
  if (Number.isNaN(due.getTime())) return null;
  const today = calendarDay(now, timeZone);

  if (due.getUTCHours() === 0 && due.getUTCMinutes() === 0) {
    const dueDay = due.toISOString().slice(0, 10);
    const overdue = today > dueDay;
    return {
      iso: isoString,
      text: new Intl.DateTimeFormat('es-CO', { timeZone: 'UTC', dateStyle: 'long' }).format(due),
      overdue,
      daysOverdue: overdue ? daysBetween(dueDay, today) : 0,
    };
  }

  const overdue = due < now;
  return {
    iso: isoString,
    text: new Intl.DateTimeFormat('es-CO', { timeZone, dateStyle: 'long', timeStyle: 'short' }).format(due),
    overdue,
    daysOverdue: overdue ? daysBetween(calendarDay(due, timeZone), today) : 0,
  };
}

function describeItem(item) {
  const bib = item.bib_data || {};
  const holding = item.holding_data || {};
  const data = item.item_data || {};
  return {
    title: cleanMarc(bib.title),
    author: cleanMarc(bib.author),
    publisher: cleanMarc(bib.publisher_const),
    year: cleanMarc(bib.date_of_publication),
    isbn: firstIsbn(bib.isbn),
    callNumber: holding.call_number || data.alternative_call_number || null,
    description: data.description || null,
    library: data.library?.desc || null,
    location: data.location?.desc || null,
    materialType: data.physical_material_type?.desc || null,
    status: BASE_STATUS_LABELS[data.base_status?.value] || data.base_status?.desc || null,
    process: data.process_type?.value
      ? {
          code: data.process_type.value,
          desc: PROCESS_LABELS[data.process_type.value] || data.process_type.desc || data.process_type.value,
        }
      : null,
  };
}

function buildResult(verdict, fields) {
  return {
    verdict,
    allowed: ALLOWED.has(verdict),
    message: MESSAGES[verdict],
    item: null,
    loan: null,
    ...fields,
  };
}

function createGateService({
  alma,
  timeZone = 'America/Bogota',
  showFullUserId = true,
  overdueGraceDays = 0,
  now = () => new Date(),
  logger = console,
}) {
  let usersDeniedUntil = 0;
  // Un lector de código de barras puede enviar el mismo código dos veces seguidas:
  // las consultas simultáneas del mismo código comparten una sola llamada a Alma.
  const inFlight = new Map();

  async function lookupUser(userId) {
    if (!userId || Date.now() < usersDeniedUntil) return null;
    try {
      const user = await alma.get(`/users/${encodeURIComponent(userId)}`, {
        user_id_type: 'all_unique',
        view: 'brief',
        expand: 'none',
      });
      return {
        name: user.full_name || [user.first_name, user.last_name].filter(Boolean).join(' ') || null,
        group: user.user_group?.desc || null,
      };
    } catch (err) {
      if (err instanceof AlmaUnauthorizedError) {
        usersDeniedUntil = Date.now() + USERS_DENIED_TTL_MS;
        logger.warn('[gate] La API key no tiene permiso para la API de Usuarios; se muestra solo la identificación.');
      } else if (!(err instanceof AlmaNotFoundError)) {
        logger.warn(`[gate] No se pudo consultar el usuario del préstamo: ${err.message}`);
      }
      return null;
    }
  }

  // Préstamo activo DEL EJEMPLAR. No usar /bibs/{mms}/loans: devuelve los préstamos de todas
  // las copias del título y hacía que la puerta mostrara el usuario de otra copia.
  async function findActiveLoan(item) {
    const mmsId = item.bib_data?.mms_id;
    const holdingId = item.holding_data?.holding_id;
    const pid = item.item_data?.pid;
    const barcode = item.item_data?.barcode;
    if (!mmsId || !holdingId || !pid) throw new AlmaError('Alma devolvió un ejemplar sin identificadores');

    const enc = encodeURIComponent;
    const data = await alma.get(`/bibs/${enc(mmsId)}/holdings/${enc(holdingId)}/items/${enc(pid)}/loans`);
    const loans = data?.item_loan ? [].concat(data.item_loan) : [];
    return (
      loans.find(
        (loan) =>
          (!loan.loan_status || String(loan.loan_status).toUpperCase() === 'ACTIVE') &&
          (String(loan.item_id) === String(pid) || (barcode && loan.item_barcode === barcode)),
      ) || null
    );
  }

  async function evaluate(barcode) {
    const checkedAt = now();
    const base = { barcode, checkedAt: checkedAt.toISOString() };
    if (!BARCODE_RE.test(barcode)) return buildResult(VERDICTS.CODIGO_INVALIDO, base);

    let item;
    try {
      item = await alma.get('/items', { item_barcode: barcode });
    } catch (err) {
      if (err instanceof AlmaNotFoundError) return buildResult(VERDICTS.NO_ENCONTRADO, base);
      throw err;
    }

    const found = { ...base, barcode: item.item_data?.barcode || barcode, item: describeItem(item) };
    const loan = await findActiveLoan(item);

    if (loan) {
      const dueDate = describeDueDate(loan.due_date, checkedAt, timeZone);
      const user = await lookupUser(loan.user_id);
      const overdue = Boolean(dueDate?.overdue);
      const withinGrace = overdue && overdueGraceDays > 0 && dueDate.daysOverdue <= overdueGraceDays;
      const verdict = overdue && !withinGrace ? VERDICTS.PRESTADO_VENCIDO : VERDICTS.PRESTADO;

      let message;
      if (verdict === VERDICTS.PRESTADO_VENCIDO && dueDate.daysOverdue > 0) {
        message = `Préstamo vencido hace ${daysText(dueDate.daysOverdue)}. La salida debe autorizarla un representante de la biblioteca.`;
      } else if (withinGrace) {
        message = `Préstamo vencido hace ${daysText(dueDate.daysOverdue)}, dentro del margen de ${daysText(overdueGraceDays)}.`;
      }

      return buildResult(verdict, {
        ...found,
        ...(message && { message }),
        loan: {
          userId: loan.user_id ? (showFullUserId ? String(loan.user_id) : maskId(loan.user_id)) : null,
          userIdMasked: !showFullUserId,
          userName: user?.name ?? null,
          userGroup: user?.group ?? null,
          dueDate,
          loanDate: loan.loan_date || null,
          library: loan.library?.desc || null,
          circDesk: loan.circ_desk?.desc || null,
        },
      });
    }

    const process = found.item.process;
    if (process) {
      const message =
        process.code === 'LOAN'
          ? 'Alma marca el ejemplar como prestado, pero no tiene un préstamo activo. Verifique en el mostrador de préstamo.'
          : `El ejemplar no está prestado (estado en Alma: ${process.desc}). Verifique en el mostrador de préstamo.`;
      return buildResult(VERDICTS.EN_PROCESO, { ...found, message });
    }
    return buildResult(VERDICTS.NO_PRESTADO, found);
  }

  function checkItem(rawBarcode) {
    const barcode = normalizeBarcode(rawBarcode);
    if (inFlight.has(barcode)) return inFlight.get(barcode);

    const promise = evaluate(barcode)
      .catch((err) => {
        const tracking = err.trackingId ? ` (trackingId ${err.trackingId})` : '';
        logger.error(`[gate] Error consultando el código ${barcode}: ${err.message}${tracking}`);
        return buildResult(VERDICTS.ERROR_ALMA, { barcode, checkedAt: now().toISOString() });
      })
      .finally(() => inFlight.delete(barcode));
    inFlight.set(barcode, promise);
    return promise;
  }

  return { checkItem };
}

module.exports = { createGateService, VERDICTS, describeDueDate, normalizeBarcode };
