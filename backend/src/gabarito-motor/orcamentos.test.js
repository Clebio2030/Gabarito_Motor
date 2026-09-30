// Testes do recurso orcamentos (conversão orçamento → pedido).
// Roda sem banco: node --test src/gabarito-motor/orcamentos.test.js
//
// Os casos reproduzem o que foi medido no ERP ARRUDA em 29/09/2026: orçamento
// finalizado sem pedido (trigger do ERP sem IDEMPRESA), pedido cancelado,
// vários pedidos por orçamento e a simulação 18503/18505.

const test   = require('node:test');
const assert = require('node:assert/strict');

process.env.GABARITO_DISABLE_BOOTSTRAP = 'true';

const { agregarPedidosPorOrcamento, mapOrcamentoRow } = require('./extractor');
const { recursosComJanela } = require('./index');

const win1252 = (s) => Buffer.from(
  [...s].map(c => ({ 'ç': 0xE7, 'ã': 0xE3, 'é': 0xE9, 'ó': 0xF3, 'á': 0xE1 }[c] ?? c.charCodeAt(0)))
);

function orc(over = {}) {
  return {
    idempresa: 2,
    src_key: '2-18503-369766',
    nrorcamento: 18503,
    dtorc: new Date(2026, 8, 29, 0, 0, 0),
    dtorc_ts: new Date(2026, 8, 29, 22, 36, 13),
    status_erp: 1,
    dtcancelamento: null,
    cdcliente: 1,
    cliente: win1252('JOÃO BALCÃO'),
    cliente_doc: win1252(''),
    cliente_fone: null,
    cliente_email: win1252(''),
    contato: null,
    cdvendedor: 105,
    vendedor: win1252('VENDEDOR TESTE'),
    vendedor_fone: win1252('89999999999'),
    vltotal: 32.4,
    desconto: 0,
    subtotal: 32.4,
    observacao: null,
    item_posic: 369766,
    item_codigo: win1252('6744'),
    item_descricao: win1252('ABAFADOR DE RUÍDOS'),
    item_unidade: win1252('UN'),
    item_qtd: 1,
    item_vl_unit: 30.5,
    item_desconto: 0,
    item_vl_total: 30.5,
    ...over
  };
}

const ped = (over = {}) => ({
  idempresa: 2, nrorcamento: 18503, nrpedido: 21360, status: 0,
  dtsaida: new Date(2026, 8, 29), pedido_ts: new Date(2026, 8, 29, 22, 36, 40), vltotal: 32.4,
  ...over
});

function mapear(orcRow, pedidos) {
  const mapa = agregarPedidosPorOrcamento(pedidos);
  return mapOrcamentoRow(orcRow, mapa.get(`${orcRow.idempresa}-${orcRow.nrorcamento}`));
}

test('com pedido válido → CONVERTIDO, com minutos até o pedido', () => {
  const r = mapear(orc(), [ped()]);
  assert.equal(r.situacao, 'CONVERTIDO');
  assert.equal(r.qtdPedidos, 1);
  assert.equal(r.nrPedido, 21360);
  assert.equal(r.minutosAtePedido, 0);   // 27s — "venda direta"
  assert.equal(r.vlPedidos, 32.4);
});

test('simulação 18505: 6 min até o pedido', () => {
  const r = mapear(
    orc({ nrorcamento: 18505, dtorc_ts: new Date(2026, 8, 29, 22, 49, 30) }),
    [ped({ nrorcamento: 18505, nrpedido: 21362, pedido_ts: new Date(2026, 8, 29, 22, 55, 30) })]
  );
  assert.equal(r.minutosAtePedido, 6);
});

test('STATUS_ERP 1 sem pedido → ABERTO (o trigger do ERP marca sem olhar IDEMPRESA)', () => {
  const r = mapear(orc({ status_erp: 1 }), []);
  assert.equal(r.situacao, 'ABERTO');
  assert.equal(r.statusErp, 1);
  assert.equal(r.minutosAtePedido, null);
  assert.equal(r.nrPedido, null);
});

test('pedido de OUTRA empresa com o mesmo número não converte', () => {
  const r = mapear(orc(), [ped({ idempresa: 1 })]);
  assert.equal(r.situacao, 'ABERTO');
});

test('só pedido cancelado → PEDIDO_CANCELADO, sem valor convertido', () => {
  const r = mapear(orc(), [ped({ status: 2 })]);
  assert.equal(r.situacao, 'PEDIDO_CANCELADO');
  assert.equal(r.qtdPedidos, 0);
  assert.equal(r.qtdPedidosCancelados, 1);
  assert.equal(r.vlPedidos, 0);
  assert.equal(r.minutosAtePedido, null);
});

test('orçamento cancelado no ERP → CANCELADO', () => {
  assert.equal(mapear(orc({ status_erp: 2 }), []).situacao, 'CANCELADO');
  assert.equal(mapear(orc({ status_erp: 0, dtcancelamento: new Date(2026, 8, 30) }), []).situacao, 'CANCELADO');
});

test('pedido válido vence cancelamento (virou venda)', () => {
  assert.equal(mapear(orc({ status_erp: 2 }), [ped({ status: 3 })]).situacao, 'CONVERTIDO');
});

test('vários pedidos: conversão = o válido mais antigo; valor soma só os válidos', () => {
  const r = mapear(orc(), [
    ped({ nrpedido: 30, status: 3, pedido_ts: new Date(2026, 8, 30, 10, 0, 0), vltotal: 10 }),
    ped({ nrpedido: 20, status: 1, pedido_ts: new Date(2026, 8, 29, 23, 36, 13), vltotal: 20.1 }),
    ped({ nrpedido: 10, status: 2, pedido_ts: new Date(2026, 8, 29, 22, 40, 0), vltotal: 99 })
  ]);
  assert.equal(r.nrPedido, 20);
  assert.equal(r.minutosAtePedido, 60);
  assert.equal(r.qtdPedidos, 2);
  assert.equal(r.qtdPedidosCancelados, 1);
  assert.equal(r.vlPedidos, 30.1);
});

test('sem hora no orçamento → minutos null (nunca meia-noite inventada)', () => {
  const r = mapear(orc({ dtorc_ts: null }), [ped()]);
  assert.equal(r.situacao, 'CONVERTIDO');
  assert.equal(r.dtOrcTs, null);
  assert.equal(r.minutosAtePedido, null);
});

test('datas: dtOrc YYYY-MM-DD; timestamps em ISO com fuso', () => {
  const r = mapear(orc(), [ped()]);
  assert.equal(r.dtOrc, '2026-09-29');
  assert.match(r.dtOrcTs, /^2026-09-29T22:36:13[+-]\d{2}:\d{2}$/);
  assert.match(r.pedidoTs, /^2026-09-29T22:36:40[+-]\d{2}:\d{2}$/);
});

test('texto WIN1252 decodificado; vazio vira null', () => {
  const r = mapear(orc(), []);
  assert.equal(r.cliente, 'JOÃO BALCÃO');
  assert.equal(r.itemDescricao, 'ABAFADOR DE RUÍDOS');
  assert.equal(r.clienteDoc, null);
  assert.equal(r.clienteEmail, null);
  assert.equal(r.contato, null);
});

test('srcKey vem da view (empresa-orçamento-item)', () => {
  assert.equal(mapear(orc(), []).srcKey, '2-18503-369766');
});

test('o payload tem exatamente os campos do contrato', () => {
  assert.deepEqual(Object.keys(mapear(orc(), [ped()])), [
    'srcKey', 'idEmpresa', 'nrOrcamento', 'dtOrc', 'dtOrcTs', 'statusErp', 'dtCancelamento',
    'situacao', 'cdCliente', 'cliente', 'clienteDoc', 'clienteFone', 'clienteEmail', 'contato',
    'cdVendedor', 'vendedor', 'vendedorFone', 'vlTotal', 'desconto', 'subtotal', 'observacao',
    'qtdPedidos', 'qtdPedidosCancelados', 'nrPedido', 'pedidoTs', 'vlPedidos', 'minutosAtePedido',
    'itemPosic', 'itemCodigo', 'itemDescricao', 'itemUnidade', 'itemQtd', 'itemVlUnit',
    'itemDesconto', 'itemVlTotal'
  ]);
});

test('toggle desligado: orcamentos fora dos recursos com janela (não cobra nem carimba backfill)', () => {
  assert.ok(!recursosComJanela(false).includes('orcamentos'));
  assert.ok(recursosComJanela(true).includes('orcamentos'));
  assert.deepEqual(recursosComJanela(false), ['curvaAbc', 'entradas', 'vendedores', 'pedidosHorario']);
});

test('histórico de orçamentos tem teto de 12 meses (1º dia do mês)', () => {
  const { limitarDesdeOrcamentos } = require('./extractor');
  const hoje = new Date(2026, 8, 30);
  assert.equal(limitarDesdeOrcamentos('2023-09-30', hoje), '2025-09-01', 'carga de 3 anos é limitada');
  assert.equal(limitarDesdeOrcamentos('2026-06-01', hoje), '2026-06-01', 'janela incremental passa intacta');
});
