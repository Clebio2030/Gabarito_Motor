// Testes do reenvio completo pedido pela API (`resyncToken` em GET /companies).
// Roda sem framework: node --test src/gabarito-motor/resync.test.js

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const STATE_FILE = path.join(os.tmpdir(), `gabarito-resync-test-${process.pid}.json`);
process.env.GABARITO_STATE_FILE = STATE_FILE;
process.env.GABARITO_DISABLE_BOOTSTRAP = 'true';

const { getResyncApplied, markResyncApplied, updateState, markResourcesFullSynced } = require('./syncState');
const { precisaResync } = require('./index');

function escreverEstado(obj) { fs.writeFileSync(STATE_FILE, JSON.stringify(obj), 'utf8'); }
function lerEstado()         { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }

test.afterEach(() => { try { fs.unlinkSync(STATE_FILE); } catch {} });

test('sem token da API (API antiga / toggle off) → nunca reenvia', () => {
  assert.equal(precisaResync(null, null), false);
  assert.equal(precisaResync(null, 'r1'), false);
});

test('token novo → reenvia; token já cumprido → não', () => {
  assert.equal(precisaResync('r1', null), true);
  assert.equal(precisaResync('r2', 'r1'), true);
  assert.equal(precisaResync('r1', 'r1'), false);
});

test('CNPJ desconhecido → nenhum token cumprido', () => {
  escreverEstado({});
  assert.equal(getResyncApplied('X'), null);
});

test('markResyncApplied grava e preserva o resto do estado', () => {
  escreverEstado({ C1: { hash: 'h', lastSyncedAt: 't', fullSyncedResources: ['curvaAbc'] } });
  markResyncApplied('C1', 'r1');
  assert.deepEqual(lerEstado().C1, { hash: 'h', lastSyncedAt: 't', fullSyncedResources: ['curvaAbc'], resyncApplied: 'r1' });
});

test('updateState e markResourcesFullSynced preservam o token cumprido', () => {
  escreverEstado({ C1: { hash: 'h', lastSyncedAt: 't', resyncApplied: 'r1' } });
  updateState('C1', 'h2');
  markResourcesFullSynced('C1', ['vendedores']);
  assert.equal(getResyncApplied('C1'), 'r1');
  assert.equal(lerEstado().C1.hash, 'h2');
});
