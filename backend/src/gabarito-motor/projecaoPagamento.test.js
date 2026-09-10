// Testes do mapper de projecaoPagamento (contrato de campos do recurso).
// Roda sem banco: node --test src/gabarito-motor/projecaoPagamento.test.js
//
// Cada asserção aqui corresponde a uma regra de formatação da API que já custou
// um bug em produção: data com fuso caindo no mês errado, "" no lugar de null,
// acento virando U+FFFD e código de conta perdendo o zero à esquerda.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { mapProjecaoPagamentoRow } = require('./extractor');

// O driver devolve as chaves em minúsculas (lowercase_keys) e as colunas de texto
// como Buffer de bytes WIN1252 (CAST ... CHARACTER SET OCTETS nas views).
const win1252 = (s) => Buffer.from(
  [...s].map(c => ({ 'ç': 0xE7, 'ã': 0xE3, 'é': 0xE9, 'ó': 0xF3, 'á': 0xE1 }[c] ?? c.charCodeAt(0)))
);

function linha(over = {}) {
  return {
    src_key: 8524,
    idempresa: 1,
    notafiscal: win1252('2085422'),
    parcela: 8,
    nrdoc: win1252('2085422-8'),
    status: 1,
    dtvenc: new Date(2026, 8, 3, 0, 0, 0),
    dtpagto: null,
    dtinclusao: new Date(2026, 2, 3, 14, 35, 0),
    historico: win1252('Manutenção prédio'),
    codpagto: 6,
    tppagto: 0,
    recebto: win1252('Depósito em Conta'),
    valor: 1200,
    total: 1234.56,
    juros: 0,
    desconto: 0,
    vlpago: 0,
    fornecedor: win1252('DISTRIBUIDORA EXEMPLO LTDA'),
    cdfornecedor: 4471,
    cdconta1: win1252('007'),
    conta1: win1252('Movimentações Não Operacionais'),
    cdconta2: win1252('2'),
    conta2: win1252('7.2 SAIDA NAO OPERACIONAL'),
    cdconta3: win1252('1'),
    conta3: win1252('DETALHE'),
    cdconta4: win1252(''),
    conta4: null,
    statusvale: null,
    cdclientevale: null,
    ...over
  };
}

test('srcKey é a PK CONTROLE como string', () => {
  assert.equal(mapProjecaoPagamentoRow(linha()).srcKey, '8524');
});

test('datas saem como YYYY-MM-DD puro, sem hora e sem fuso', () => {
  const r = mapProjecaoPagamentoRow(linha());
  assert.equal(r.dtVenc, '2026-09-03');
  assert.equal(r.dtInclusao, '2026-03-03', 'TIMESTAMP com hora vira data pura');
  assert.equal(r.dtPagto, null);
});

test('data impossível vira null (descarta o valor, não a linha)', () => {
  const r = mapProjecaoPagamentoRow(linha({
    dtvenc: new Date(1899, 11, 30),
    dtinclusao: new Date(8202, 0, 1)
  }));
  assert.equal(r.dtVenc, null);
  assert.equal(r.dtInclusao, null);
  assert.equal(r.total, 1234.56, 'o resto da linha continua íntegro');
});

test('texto WIN1252 é decodificado (sem U+FFFD)', () => {
  const r = mapProjecaoPagamentoRow(linha());
  assert.equal(r.historico, 'Manutenção prédio');
  assert.equal(r.recebto, 'Depósito em Conta');
  assert.equal(r.conta1, 'Movimentações Não Operacionais');
  assert.ok(!JSON.stringify(r).includes('�'), 'nenhum campo com caractere de substituição');
});

test('vazio vira null, nunca ""', () => {
  const r = mapProjecaoPagamentoRow(linha());
  assert.equal(r.cdConta4, null, "CDSUBSUBSUBCONTA vem '' do ERP");
  assert.equal(r.conta4, null);
});

test('códigos de conta são string — zero à esquerda preservado', () => {
  const r = mapProjecaoPagamentoRow(linha());
  assert.equal(r.cdConta1, '007');
  assert.equal(typeof r.cdConta1, 'string');
});

test('nulos numéricos continuam null (não viram 0)', () => {
  const r = mapProjecaoPagamentoRow(linha({ cdfornecedor: null, parcela: null }));
  assert.equal(r.cdFornecedor, null);
  assert.equal(r.parcela, null);
  assert.equal(r.statusVale, null);
  assert.equal(r.cdClienteVale, null);
});

test('números vêm como number (a API rejeita "1.234,56")', () => {
  const r = mapProjecaoPagamentoRow(linha());
  for (const campo of ['total', 'valor', 'juros', 'desconto', 'vlPago']) {
    assert.equal(typeof r[campo], 'number', `${campo} numérico`);
  }
  assert.equal(r.vlPago, 0, 'não pago → 0, não null');
});

test('status é o domínio do ERP (1 aberto, 2 pago) e não é normalizado', () => {
  assert.equal(mapProjecaoPagamentoRow(linha({ status: 2 })).status, 2);
});

test('o payload tem exatamente os campos do contrato', () => {
  assert.deepEqual(Object.keys(mapProjecaoPagamentoRow(linha())).sort(), [
    'cdClienteVale', 'cdConta1', 'cdConta2', 'cdConta3', 'cdConta4', 'cdFornecedor',
    'codPagto', 'conta1', 'conta2', 'conta3', 'conta4', 'desconto', 'dtInclusao',
    'dtPagto', 'dtVenc', 'fornecedor', 'historico', 'idEmpresa', 'juros', 'notaFiscal',
    'nrDoc', 'parcela', 'recebto', 'srcKey', 'status', 'statusVale', 'total', 'tpPagto',
    'valor', 'vlPago'
  ]);
});
