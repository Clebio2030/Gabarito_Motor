// Testes do enviarRecurso (Fase 1 — entrega íntegra).
// Roda sem framework: node --test src/gabarito-motor/enviarRecurso.test.js
//
// GABARITO_DISABLE_BOOTSTRAP impede o módulo de subir cron / conectar no Firebird
// ao ser requerido. A flag GABARITO_EXPECTED_TOTAL é lida no load do módulo, então
// cada bloco que precisa de um valor diferente faz require isolado (cache bust).

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');

process.env.GABARITO_DISABLE_BOOTSTRAP = 'true';

const MODULE_PATH = require.resolve('./index');

function carregarComFlag(expectedTotalOn) {
  delete require.cache[MODULE_PATH];
  if (expectedTotalOn) process.env.GABARITO_EXPECTED_TOTAL = 'true';
  else delete process.env.GABARITO_EXPECTED_TOTAL;
  return require('./index');
}

// Mock do enviarSync: registra cada payload e devolve respostas roteiradas.
function criarMock(respostas) {
  const chamadas = [];
  let i = 0;
  const sendFn = async (payload) => {
    chamadas.push(JSON.parse(JSON.stringify(payload)));
    const r = typeof respostas === 'function' ? respostas(payload, i) : respostas[i];
    i++;
    return r || { ok: true };
  };
  return { sendFn, chamadas };
}

const baseMeta = { dataReferencia: '2026-06-26', sourceVersion: '1.8.0', syncMode: 'incremental', desde: '2026-04-01' };
const linhas = (n) => Array.from({ length: n }, (_, k) => ({ id: k }));

// ── Flag ON ───────────────────────────────────────────────────────────────────

test('ON: 12001 linhas → 3 lotes, chunkInfo honesto e expectedTotal em todos', async () => {
  const { enviarRecurso } = carregarComFlag(true);
  const persisted = { contasPagar: { total: 12001, previousTotal: 12000 } };
  const { sendFn, chamadas } = criarMock((p) =>
    p.chunkInfo.atual === p.chunkInfo.total ? { ok: true, persisted } : { ok: true });

  const ok = await enviarRecurso('CNPJ1', baseMeta, 'contasPagar', linhas(12001), sendFn);

  assert.equal(ok, true);
  assert.equal(chamadas.length, 3);
  assert.deepEqual(chamadas.map(c => c.chunkInfo), [
    { atual: 1, total: 3 }, { atual: 2, total: 3 }, { atual: 3, total: 3 }
  ]);
  assert.ok(chamadas.every(c => c.expectedTotal === 12001), 'expectedTotal em todos os lotes');
  // tamanhos de lote: 5000, 5000, 2001
  assert.deepEqual(chamadas.map(c => c.registros[0].contasPagar.length), [5000, 5000, 2001]);
});

test('ON: snapshotId é igual em todos os lotes e é um uuid', async () => {
  const { enviarRecurso } = carregarComFlag(true);
  const { sendFn, chamadas } = criarMock({});
  await enviarRecurso('CNPJ1', baseMeta, 'contasPagar', linhas(11000), sendFn);

  const ids = new Set(chamadas.map(c => c.snapshotId));
  assert.equal(ids.size, 1, 'um único snapshotId para a entrega');
  assert.match([...ids][0], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('ON: cada POST carrega exatamente um recurso × um cnpj', async () => {
  const { enviarRecurso } = carregarComFlag(true);
  const { sendFn, chamadas } = criarMock({});
  await enviarRecurso('CNPJ1', baseMeta, 'contasReceber', linhas(6000), sendFn);

  for (const c of chamadas) {
    assert.equal(c.registros.length, 1);
    const campos = Object.keys(c.registros[0]).filter(k => k !== 'cnpj');
    assert.deepEqual(campos, ['contasReceber']);
  }
});

test('ON: fail-fast — aborta no 1º lote que falha e não envia os seguintes', async () => {
  const { enviarRecurso } = carregarComFlag(true);
  const { sendFn, chamadas } = criarMock((p) =>
    p.chunkInfo.atual === 2 ? { ok: false } : { ok: true });

  const ok = await enviarRecurso('CNPJ1', baseMeta, 'contasPagar', linhas(15000), sendFn); // 3 lotes

  assert.equal(ok, false);
  assert.equal(chamadas.length, 2, 'parou no lote 2, não enviou o 3');
});

test('ON: count_mismatch no último lote → recurso falha (não salva hash)', async () => {
  const { enviarRecurso } = carregarComFlag(true);
  const { sendFn } = criarMock((p) =>
    p.chunkInfo.atual === p.chunkInfo.total
      ? { ok: true, persisted: { contasPagar: { total: 9000 } } }   // esperado 10000
      : { ok: true });

  const ok = await enviarRecurso('CNPJ1', baseMeta, 'contasPagar', linhas(10000), sendFn);
  assert.equal(ok, false);
});

test('ON: persisted batendo → sucesso', async () => {
  const { enviarRecurso } = carregarComFlag(true);
  const { sendFn } = criarMock((p) =>
    p.chunkInfo.atual === p.chunkInfo.total
      ? { ok: true, persisted: { contasPagar: { total: 10000 } } }
      : { ok: true });

  const ok = await enviarRecurso('CNPJ1', baseMeta, 'contasPagar', linhas(10000), sendFn);
  assert.equal(ok, true);
});

test('ON: faturamentoMensal NÃO é stagingável → vai sem expectedTotal/snapshotId', async () => {
  const { enviarRecurso } = carregarComFlag(true);
  const { sendFn, chamadas } = criarMock({});
  const ok = await enviarRecurso('CNPJ1', baseMeta, 'faturamentoMensal', linhas(6), sendFn);
  assert.equal(ok, true);
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].expectedTotal, undefined, 'sem expectedTotal (API não faz staging)');
  assert.equal(chamadas[0].snapshotId, undefined, 'sem snapshotId');
});

test('ON: faturamento não faz fail-fast (segue legado mesmo com flag on)', async () => {
  const { enviarRecurso } = carregarComFlag(true);
  const { sendFn, chamadas } = criarMock((p) => (p.chunkInfo.atual === 1 ? { ok: false } : { ok: true }));
  // 2 lotes de faturamento (10000 linhas); lote 1 falha
  const ok = await enviarRecurso('CNPJ1', baseMeta, 'faturamentoMensal', linhas(10000), sendFn);
  assert.equal(ok, false);
  assert.equal(chamadas.length, 2, 'legado: seguiu para o lote 2 apesar da falha');
});

test('ON: recurso vazio → não envia nada e retorna true', async () => {
  const { enviarRecurso } = carregarComFlag(true);
  const { sendFn, chamadas } = criarMock({});
  const ok = await enviarRecurso('CNPJ1', baseMeta, 'contasPagar', [], sendFn);
  assert.equal(ok, true);
  assert.equal(chamadas.length, 0);
});

// ── Flag OFF (legado) ───────────────────────────────────────────────────────────

test('OFF: sem expectedTotal/snapshotId; segue mesmo após falha (não fail-fast)', async () => {
  const { enviarRecurso } = carregarComFlag(false);
  const { sendFn, chamadas } = criarMock((p) =>
    p.chunkInfo.atual === 2 ? { ok: false } : { ok: true });

  const ok = await enviarRecurso('CNPJ1', baseMeta, 'contasPagar', linhas(15000), sendFn); // 3 lotes

  assert.equal(ok, false, 'agrega falha mas retorna false');
  assert.equal(chamadas.length, 3, 'legado continua enviando todos os lotes');
  assert.ok(chamadas.every(c => c.expectedTotal === undefined), 'sem expectedTotal');
  assert.ok(chamadas.every(c => c.snapshotId === undefined), 'sem snapshotId');
});
