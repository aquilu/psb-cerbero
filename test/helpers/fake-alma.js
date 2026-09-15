'use strict';

const { AlmaNotFoundError, AlmaUnauthorizedError, AlmaUnavailableError } = require('../../src/alma/client');

// Datos ficticios: no corresponden a ejemplares ni usuarios reales.
const MMS_ID = '991000000000007486';

function makeItem({ barcode, pid, holdingId = '220000000000007486', base = '1', process = '', mmsId = MMS_ID }) {
  return {
    link: `https://alma.test/almaws/v1/bibs/${mmsId}/holdings/${holdingId}/items/${pid}`,
    bib_data: {
      mms_id: mmsId,
      title: 'Cien años de soledad /',
      author: 'García Márquez, Gabriel,',
      isbn: '8423919005 (rústica)',
      publisher_const: 'Editorial Ejemplo',
      date_of_publication: '1982.',
    },
    holding_data: { holding_id: holdingId, call_number: 'Co863.6 G17c' },
    item_data: {
      barcode,
      pid,
      base_status: { value: base, desc: base === '1' ? 'Item in place' : 'Item not in place' },
      process_type: { value: process, desc: process || null },
      library: { value: 'BLAA', desc: 'Biblioteca Luis Ángel Arango' },
      location: { value: 'DC1', desc: 'Depósito C1' },
      description: 'Ej. 1',
      physical_material_type: { value: 'BOOK', desc: 'Libro' },
    },
  };
}

function makeLoan({ item, userId = '1000000001', dueDate = '2026-10-01T00:00:00.000Z' }) {
  return {
    loan_id: `L-${item.item_data.pid}`,
    loan_status: 'ACTIVE',
    item_id: item.item_data.pid,
    item_barcode: item.item_data.barcode,
    mms_id: item.bib_data.mms_id,
    user_id: userId,
    due_date: dueDate,
    loan_date: '2026-09-02T22:17:03.000Z',
    library: { value: 'BLAA', desc: 'Biblioteca Luis Ángel Arango' },
    circ_desk: { value: 'DESK', desc: 'Sala General' },
  };
}

// Cliente de Alma falso con la misma interfaz que createAlmaClient (get).
function createFakeAlma({ items = [], loans = [], users = {}, usersDenied = false, unavailable = false } = {}) {
  const calls = [];

  async function get(endpoint, query = {}) {
    calls.push({ endpoint, query });
    if (unavailable) throw new AlmaUnavailableError('Alma no respondió en 8000 ms');

    if (endpoint === '/items') {
      const item = items.find((i) => i.item_data.barcode === query.item_barcode);
      if (!item) throw new AlmaNotFoundError(`No items found for barcode ${query.item_barcode}.`, { code: '401689' });
      return structuredClone(item);
    }

    let m = endpoint.match(/^\/bibs\/([^/]+)\/holdings\/([^/]+)\/items\/([^/]+)\/loans$/);
    if (m) {
      const own = loans.filter((l) => l.itemPid === m[3]).map((l) => l.loan);
      return own.length ? { item_loan: own, total_record_count: own.length } : { total_record_count: 0 };
    }

    m = endpoint.match(/^\/bibs\/([^/]+)\/loans$/);
    if (m) {
      const all = loans.map((l) => l.loan);
      return { item_loan: all, total_record_count: all.length };
    }

    m = endpoint.match(/^\/users\/(.+)$/);
    if (m) {
      if (usersDenied) throw new AlmaUnauthorizedError('API-key not defined or not configured to allow this API.');
      const user = users[decodeURIComponent(m[1])];
      if (!user) throw new AlmaNotFoundError('User not found', { code: '401861' });
      return user;
    }

    throw new Error(`Endpoint no simulado: ${endpoint}`);
  }

  return { get, calls };
}

const silentLogger = { error() {}, warn() {}, info() {}, log() {} };

module.exports = { MMS_ID, makeItem, makeLoan, createFakeAlma, silentLogger };
