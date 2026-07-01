// Testes do watermark por recurso (carga histórica única + incremental).
// Roda sem framework: node --test src/gabarito-motor/syncState.test.js
//
// Usa GABARITO_STATE_FILE para isolar o estado num arquivo temporário — nunca
// toca no sync_state.json de produção.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const STATE_FILE = path.join(os.tmpdir(), `gabarito-state-test-${process.pid}.json`);
process.env.GABARITO_STATE_FILE = STATE_FILE;

const {
  getFullSyncedResources,
  markResourcesFullSynced,
  updateState,
  WINDOWED_RESOURCES
} = require('./syncState');

function escreverEstado(obj) { fs.writeFileSync(STATE_FILE, JSON.stringify(obj), 'utf8'); }
function lerEstado()         { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }

test.afterEach(() => { try { fs.unlinkSync(STATE_FILE); } catch {} });

test('CNPJ desconhecido → nenhum recurso carregado', () => {
  escreverEstado({});
  assert.deepEqual(getFullSyncedResources('X'), []);
});

test('legado (já sincronizou, sem campo) → curvaAbc e entradas são assumidos carregados', () => {
  escreverEstado({ 'CNPJ1': { hash: 'h', lastSyncedAt: '2026-05-01T00:00:00.000Z' } });
  const r = getFullSyncedResources('CNPJ1');
  assert.deepEqual(r.sort(), ['curvaAbc', 'entradas']);
  // vendedores e pedidosHorario ficam de fora → serão carregados
  assert.ok(!r.includes('vendedores'));
  assert.ok(!r.includes('pedidosHorario'));
});

test('markResourcesFullSynced faz união e materializa o seed legado', () => {
  escreverEstado({ 'CNPJ1': { hash: 'h', lastSyncedAt: '2026-05-01T00:00:00.000Z' } });
  markResourcesFullSynced('CNPJ1', ['vendedores', 'pedidosHorario']);
  const r = getFullSyncedResources('CNPJ1');
  assert.deepEqual(r.sort(), ['curvaAbc', 'entradas', 'pedidosHorario', 'vendedores']);
});

test('markResourcesFullSynced é idempotente (sem duplicatas)', () => {
  escreverEstado({ 'CNPJ1': { hash: 'h', lastSyncedAt: '2026-05-01T00:00:00.000Z', fullSyncedResources: ['vendedores'] } });
  markResourcesFullSynced('CNPJ1', ['vendedores', 'vendedores']);
  assert.deepEqual(getFullSyncedResources('CNPJ1'), ['vendedores']);
});

test('updateState preserva o watermark por recurso', () => {
  escreverEstado({ 'CNPJ1': { hash: 'h0', lastSyncedAt: '2026-05-01T00:00:00.000Z', fullSyncedResources: [...WINDOWED_RESOURCES] } });
  updateState('CNPJ1', 'h1');
  const entry = lerEstado()['CNPJ1'];
  assert.equal(entry.hash, 'h1');
  assert.deepEqual(entry.fullSyncedResources, [...WINDOWED_RESOURCES]);
  assert.ok(entry.lastSyncedAt); // atualizado
});

test('marcar todos os recursos com janela → nenhum pendente no próximo ciclo', () => {
  escreverEstado({ 'CNPJ1': { hash: 'h', lastSyncedAt: '2026-05-01T00:00:00.000Z' } });
  markResourcesFullSynced('CNPJ1', WINDOWED_RESOURCES);
  const backfilled = new Set(getFullSyncedResources('CNPJ1'));
  const pendentes = WINDOWED_RESOURCES.filter(r => !backfilled.has(r));
  assert.deepEqual(pendentes, []);
});
