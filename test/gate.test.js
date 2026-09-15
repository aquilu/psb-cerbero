'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createGateService, VERDICTS, describeDueDate } = require('../src/services/gate');
const { MMS_ID, makeItem, makeLoan, createFakeAlma, silentLogger } = require('./helpers/fake-alma');

const NOW = new Date('2026-09-15T15:00:00.000Z');

function gateWith(almaOptions, gateOptions = {}) {
  const alma = createFakeAlma(almaOptions);
  const gate = createGateService({ alma, now: () => NOW, logger: silentLogger, ...gateOptions });
  return { alma, gate };
}

describe('gate.checkItem', () => {
  const onLoan = makeItem({ barcode: '29000000000001', pid: '230000000000017486', base: '0', process: 'LOAN' });

  it('PRESTADO: préstamo activo y vigente', async () => {
    const { gate } = gateWith({
      items: [onLoan],
      loans: [{ itemPid: onLoan.item_data.pid, loan: makeLoan({ item: onLoan }) }],
      users: { 1000000001: { full_name: 'Usuaria De Prueba', user_group: { desc: 'Socio' } } },
    });

    const result = await gate.checkItem('29000000000001');

    assert.equal(result.verdict, VERDICTS.PRESTADO);
    assert.equal(result.allowed, true);
    assert.equal(result.loan.userId, '1000000001');
    assert.equal(result.loan.userName, 'Usuaria De Prueba');
    assert.equal(result.loan.dueDate.text, '1 de octubre de 2026');
    assert.equal(result.loan.dueDate.overdue, false);
    assert.equal(result.item.title, 'Cien años de soledad');
    assert.equal(result.item.author, 'García Márquez, Gabriel');
    assert.equal(result.item.isbn, '8423919005');
    assert.equal(result.item.year, '1982');
  });

  it('PRESTADO_VENCIDO: no autoriza la salida y pide un representante de la biblioteca', async () => {
    const { gate } = gateWith({
      items: [onLoan],
      loans: [{ itemPid: onLoan.item_data.pid, loan: makeLoan({ item: onLoan, dueDate: '2025-06-17T00:00:00.000Z' }) }],
    });

    const result = await gate.checkItem('29000000000001');

    assert.equal(result.verdict, VERDICTS.PRESTADO_VENCIDO);
    assert.equal(result.allowed, false);
    assert.equal(result.loan.dueDate.daysOverdue, 455);
    assert.match(result.message, /hace 455 días/);
    assert.match(result.message, /representante de la biblioteca/);
  });

  it('OVERDUE_GRACE_DAYS: un vencido dentro del margen puede salir, fuera del margen no', async () => {
    const recent = makeItem({ barcode: '29000000000040', pid: '230000000000407486', base: '0', process: 'LOAN' });
    const { gate } = gateWith(
      {
        items: [onLoan, recent],
        loans: [
          { itemPid: recent.item_data.pid, loan: makeLoan({ item: recent, dueDate: '2026-09-05T00:00:00.000Z' }) },
          { itemPid: onLoan.item_data.pid, loan: makeLoan({ item: onLoan, dueDate: '2025-06-17T00:00:00.000Z' }) },
        ],
      },
      { overdueGraceDays: 30 },
    );

    const inGrace = await gate.checkItem('29000000000040');
    const tooLate = await gate.checkItem('29000000000001');

    assert.equal(inGrace.verdict, VERDICTS.PRESTADO);
    assert.equal(inGrace.allowed, true);
    assert.match(inGrace.message, /hace 10 días, dentro del margen de 30 días/);
    assert.equal(tooLate.verdict, VERDICTS.PRESTADO_VENCIDO);
    assert.equal(tooLate.allowed, false);
  });

  it('NO_PRESTADO: ejemplar en estantería sin préstamo', async () => {
    const inPlace = makeItem({ barcode: '29000000000002', pid: '230000000000027486' });
    const { gate } = gateWith({ items: [inPlace] });

    const result = await gate.checkItem('29000000000002');

    assert.equal(result.verdict, VERDICTS.NO_PRESTADO);
    assert.equal(result.allowed, false);
    assert.equal(result.loan, null);
  });

  it('regresión v1: con varias copias usa el préstamo del ejemplar escaneado, no el del título', async () => {
    const copyA = makeItem({ barcode: '29000000000010', pid: '230000000000107486' });
    const copyB = makeItem({ barcode: '29000000000011', pid: '230000000000117486', base: '0', process: 'LOAN' });
    const copyC = makeItem({ barcode: '29000000000012', pid: '230000000000127486', base: '0', process: 'LOAN' });
    const { gate, alma } = gateWith({
      items: [copyA, copyB, copyC],
      loans: [
        { itemPid: copyB.item_data.pid, loan: makeLoan({ item: copyB, userId: 'USUARIO-B', dueDate: '2025-06-17T00:00:00.000Z' }) },
        { itemPid: copyC.item_data.pid, loan: makeLoan({ item: copyC, userId: 'USUARIO-C' }) },
      ],
    });

    const a = await gate.checkItem('29000000000010');
    const c = await gate.checkItem('29000000000012');

    assert.equal(a.verdict, VERDICTS.NO_PRESTADO, 'la copia en estantería no puede salir');
    assert.equal(c.verdict, VERDICTS.PRESTADO);
    assert.equal(c.loan.userId, 'USUARIO-C');
    assert.ok(
      !alma.calls.some((call) => call.endpoint === `/bibs/${MMS_ID}/loans`),
      'no debe consultar los préstamos de todo el título',
    );
  });

  it('ignora préstamos que Alma devuelva para otra copia', async () => {
    const copyA = makeItem({ barcode: '29000000000020', pid: '230000000000207486' });
    const copyB = makeItem({ barcode: '29000000000021', pid: '230000000000217486' });
    const { gate } = gateWith({
      items: [copyA],
      loans: [{ itemPid: copyA.item_data.pid, loan: makeLoan({ item: copyB, userId: 'OTRO' }) }],
    });

    const result = await gate.checkItem('29000000000020');

    assert.equal(result.verdict, VERDICTS.NO_PRESTADO);
  });

  it('EN_PROCESO: ejemplar en tránsito u otro proceso sin préstamo', async () => {
    const transit = makeItem({ barcode: '29000000000030', pid: '230000000000307486', base: '0', process: 'TRANSIT' });
    const { gate } = gateWith({ items: [transit] });

    const result = await gate.checkItem('29000000000030');

    assert.equal(result.verdict, VERDICTS.EN_PROCESO);
    assert.equal(result.allowed, false);
    assert.match(result.message, /En tránsito/);
    assert.equal(result.item.process.code, 'TRANSIT');
  });

  it('EN_PROCESO: Alma marca LOAN pero no hay préstamo activo', async () => {
    const orphan = makeItem({ barcode: '29000000000031', pid: '230000000000317486', base: '0', process: 'LOAN' });
    const { gate } = gateWith({ items: [orphan] });

    const result = await gate.checkItem('29000000000031');

    assert.equal(result.verdict, VERDICTS.EN_PROCESO);
    assert.equal(result.allowed, false);
  });

  it('NO_ENCONTRADO: código inexistente', async () => {
    const { gate } = gateWith({ items: [] });

    const result = await gate.checkItem('29009999999999');

    assert.equal(result.verdict, VERDICTS.NO_ENCONTRADO);
    assert.equal(result.allowed, false);
  });

  it('CODIGO_INVALIDO: no consulta Alma con códigos vacíos o con caracteres raros', async () => {
    const { gate, alma } = gateWith({ items: [] });

    assert.equal((await gate.checkItem('')).verdict, VERDICTS.CODIGO_INVALIDO);
    assert.equal((await gate.checkItem('abc&limit=1')).verdict, VERDICTS.CODIGO_INVALIDO);
    assert.equal((await gate.checkItem('<script>')).verdict, VERDICTS.CODIGO_INVALIDO);
    assert.equal(alma.calls.length, 0);
  });

  it('limpia espacios y caracteres de control que envía el lector', async () => {
    const inPlace = makeItem({ barcode: '29000000000002', pid: '230000000000027486' });
    const { gate } = gateWith({ items: [inPlace] });

    const result = await gate.checkItem('  29000000000002\r\n');

    assert.equal(result.verdict, VERDICTS.NO_PRESTADO);
    assert.equal(result.barcode, '29000000000002');
  });

  it('ERROR_ALMA: si Alma no responde pide verificación manual', async () => {
    const { gate } = gateWith({ unavailable: true });

    const result = await gate.checkItem('29000000000001');

    assert.equal(result.verdict, VERDICTS.ERROR_ALMA);
    assert.equal(result.allowed, false);
  });

  it('sin permiso de Usuarios muestra la identificación y no repite la consulta', async () => {
    const { gate, alma } = gateWith({
      items: [onLoan],
      loans: [{ itemPid: onLoan.item_data.pid, loan: makeLoan({ item: onLoan }) }],
      usersDenied: true,
    });

    const first = await gate.checkItem('29000000000001');
    await gate.checkItem('29000000000001');

    assert.equal(first.verdict, VERDICTS.PRESTADO);
    assert.equal(first.loan.userName, null);
    assert.equal(first.loan.userId, '1000000001');
    assert.equal(alma.calls.filter((call) => call.endpoint.startsWith('/users/')).length, 1);
  });

  it('SHOW_FULL_USER_ID=false enmascara la identificación', async () => {
    const { gate } = gateWith(
      { items: [onLoan], loans: [{ itemPid: onLoan.item_data.pid, loan: makeLoan({ item: onLoan }) }] },
      { showFullUserId: false },
    );

    const result = await gate.checkItem('29000000000001');

    assert.equal(result.loan.userId, '••••••0001');
    assert.equal(result.loan.userIdMasked, true);
  });

  it('lecturas dobles simultáneas comparten una sola consulta a Alma', async () => {
    const inPlace = makeItem({ barcode: '29000000000002', pid: '230000000000027486' });
    const { gate, alma } = gateWith({ items: [inPlace] });

    const [r1, r2] = await Promise.all([gate.checkItem('29000000000002'), gate.checkItem('29000000000002')]);

    assert.equal(r1, r2);
    assert.equal(alma.calls.filter((call) => call.endpoint === '/items').length, 1);
  });
});

describe('describeDueDate', () => {
  const tz = 'America/Bogota';

  it('un préstamo por días vence al final del día local, no a medianoche UTC', () => {
    const due = '2026-09-15T00:00:00.000Z';
    // 23:30 del 15 de septiembre en Bogotá
    assert.equal(describeDueDate(due, new Date('2026-09-16T04:30:00.000Z'), tz).overdue, false);
    // 00:30 del 16 de septiembre en Bogotá
    const late = describeDueDate(due, new Date('2026-09-16T05:30:00.000Z'), tz);
    assert.equal(late.overdue, true);
    assert.equal(late.daysOverdue, 1);
  });

  it('un préstamo por horas vence a la hora exacta', () => {
    const due = '2026-09-15T20:00:00.000Z';
    assert.equal(describeDueDate(due, new Date('2026-09-15T19:59:00.000Z'), tz).overdue, false);
    assert.equal(describeDueDate(due, new Date('2026-09-15T20:01:00.000Z'), tz).overdue, true);
  });

  it('fechas ausentes o inválidas', () => {
    assert.equal(describeDueDate(null, NOW, tz), null);
    assert.equal(describeDueDate('no-es-fecha', NOW, tz), null);
  });
});
