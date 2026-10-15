// Testes do recurso faturamentoMunicipio (mapa de faturamento por município/bairro).
// Roda sem banco: node --test src/gabarito-motor/faturamentoMunicipio.test.js
//
// As linhas imitam o que a GABARITO_FATURAMENTO_MUNICIPIO devolve na ARRUDA
// (colunas em minúsculas, texto em OCTETS = Buffer de bytes WIN1252).

const test   = require('node:test');
const assert = require('node:assert/strict');

process.env.GABARITO_DISABLE_BOOTSTRAP = 'true';

const { mapFaturamentoMunicipioRow, agregarFaturamentoMunicipio, inicioDoMes } = require('./extractor');
const { recursosComJanela } = require('./index');

const win1252 = (s) => Buffer.from(
  [...s].map(c => ({ 'ã': 0xE3, 'Ã': 0xC3, 'é': 0xE9, 'É': 0xC9, 'í': 0xED, 'Í': 0xCD }[c] ?? c.charCodeAt(0)))
);

function linha(over = {}) {
  return {
    idempresa: 1,
    ano: 2026,
    mes: 9,
    cdmunicipio: 751,
    municipio: win1252('FLORIANO'),
    cdmunicipioibge: win1252('2203909'),
    uf_municipio: win1252('PI'),
    uf_pedido: win1252('PI'),
    bairro: win1252('TIBERAO'),
    cdvendedor: 42,
    nome_vendedor: win1252('JOÃO SILVA'),
    cdcliente: 1001,
    cliente: win1252('MARIA LTDA'),
    subtotal: 82000.5,
    desconto: 100,
    total: 81900.5,
    subtotal_troca: 0,
    desconto_troca: 0,
    total_troca: 0,
    qtd_vendas: 681,
    qtd_trocas: 0,
    ...over
  };
}

test('o payload tem exatamente os campos do contrato', () => {
  assert.deepEqual(Object.keys(mapFaturamentoMunicipioRow(linha())), [
    'srcKey', 'idEmpresa', 'ano', 'mes', 'uf', 'cdMunicipio', 'municipio', 'cdMunicipioIbge', 'bairro',
    'cdVendedor', 'nomeVendedor', 'cdCliente', 'cliente',
    'subtotal', 'desconto', 'total', 'subtotalTroca', 'descontoTroca', 'totalTroca', 'qtdVendas', 'qtdTrocas'
  ]);
});

test('cdVendedor/nomeVendedor/cdCliente/cliente são mapeados corretamente', () => {
  const r = mapFaturamentoMunicipioRow(linha());
  assert.equal(r.cdVendedor, 42);
  assert.equal(r.nomeVendedor, 'JOÃO SILVA');
  assert.equal(r.cdCliente, 1001);
  assert.equal(r.cliente, 'MARIA LTDA');
});

test('cdVendedor/nomeVendedor/cdCliente/cliente viram null quando a view não tem os campos (filial desatualizada)', () => {
  const semCampos = linha({ cdvendedor: null, nome_vendedor: null, cdcliente: null, cliente: null });
  const r = mapFaturamentoMunicipioRow(semCampos);
  assert.equal(r.cdVendedor, null);
  assert.equal(r.nomeVendedor, null);
  assert.equal(r.cdCliente, null);
  assert.equal(r.cliente, null);
  assert.equal(r.srcKey, '1-2026-9-PI-751-TIBERAO-0-0');
});

test('mapeia a linha da view (WIN1252 decodificado, números, chave natural)', () => {
  const r = mapFaturamentoMunicipioRow(linha({ bairro: win1252('SÃO JOSÉ') }));
  assert.equal(r.srcKey, '1-2026-9-PI-751-SÃO JOSÉ-42-1001');
  assert.equal(r.municipio, 'FLORIANO');
  assert.equal(r.cdMunicipioIbge, '2203909');
  assert.equal(r.bairro, 'SÃO JOSÉ');
  assert.equal(r.total, 81900.5);
  assert.equal(r.qtdVendas, 681);
});

test('IBGE fora de 7 dígitos vira null — a linha continua', () => {
  // Cadastro real da ARRUDA: "FLORIANO Errado", UF AL, IBGE '1'.
  assert.equal(mapFaturamentoMunicipioRow(linha({ cdmunicipioibge: win1252('1') })).cdMunicipioIbge, null);
  assert.equal(mapFaturamentoMunicipioRow(linha({ cdmunicipioibge: win1252('') })).cdMunicipioIbge, null);
  assert.equal(mapFaturamentoMunicipioRow(linha({ cdmunicipioibge: null })).cdMunicipioIbge, null);
});

test('pedido sem município: cdMunicipio/municipio null, UF do pedido separa a chave', () => {
  const r = mapFaturamentoMunicipioRow(linha({
    cdmunicipio: null, municipio: null, cdmunicipioibge: null, uf_municipio: null, uf_pedido: win1252('ma')
  }));
  assert.equal(r.cdMunicipio, null);
  assert.equal(r.municipio, null);
  assert.equal(r.uf, 'MA');
  assert.equal(r.srcKey, '1-2026-9-MA-0-TIBERAO-42-1001');
});

test('UF: cadastro do município vence a digitada no pedido; sem nenhuma → SEM UF', () => {
  // ARRUDA: 357 pedidos com UF do pedido diferente da UF do município.
  assert.equal(mapFaturamentoMunicipioRow(linha({ uf_municipio: win1252('PI'), uf_pedido: win1252('MA') })).uf, 'PI');
  assert.equal(mapFaturamentoMunicipioRow(linha({ uf_municipio: win1252('  '), uf_pedido: win1252('MA') })).uf, 'MA');
  assert.equal(mapFaturamentoMunicipioRow(linha({ uf_municipio: null, uf_pedido: win1252('') })).uf, 'SEM UF');
});

test('bairro: caixa alta com acento, espaço duplicado some, vazio vira SEM BAIRRO', () => {
  assert.equal(mapFaturamentoMunicipioRow(linha({ bairro: win1252(' São  José ') })).bairro, 'SÃO JOSÉ');
  assert.equal(mapFaturamentoMunicipioRow(linha({ bairro: win1252('') })).bairro, 'SEM BAIRRO');
  assert.equal(mapFaturamentoMunicipioRow(linha({ bairro: null })).bairro, 'SEM BAIRRO');
});

test('linhas que colidem após normalizar o bairro são somadas (chave única p/ a API)', () => {
  const rows = [
    linha({ bairro: win1252('SÃO JOSÉ'), total: 100, subtotal: 110, qtd_vendas: 2, total_troca: -5, qtd_trocas: 1 }),
    linha({ bairro: win1252('SãO JOSé'), total: 50, subtotal: 55, qtd_vendas: 1, total_troca: 0, qtd_trocas: 0 }),
    linha({ bairro: win1252('CENTRO'), total: 7, subtotal: 7, qtd_vendas: 1 })
  ].map(mapFaturamentoMunicipioRow);

  const out = agregarFaturamentoMunicipio(rows);

  assert.equal(out.length, 2);
  const sj = out.find(r => r.bairro === 'SÃO JOSÉ');
  assert.equal(sj.total, 150);
  assert.equal(sj.subtotal, 165);
  assert.equal(sj.qtdVendas, 3);
  assert.equal(sj.totalTroca, -5);
  assert.equal(sj.qtdTrocas, 1);
  assert.equal(new Set(out.map(r => r.srcKey)).size, out.length, 'srcKey sem duplicata');
});

test('clientes diferentes no mesmo bairro têm srcKeys distintas e não são fundidos', () => {
  const rows = [
    linha({ cdcliente: 1001, cliente: win1252('MARIA LTDA'), bairro: win1252('CENTRO'), total: 100 }),
    linha({ cdcliente: 659, cliente: win1252('ARNALDO TAVARES'), bairro: win1252('CENTRO'), total: 200 })
  ].map(mapFaturamentoMunicipioRow);

  const out = agregarFaturamentoMunicipio(rows);

  assert.equal(out.length, 2);
  assert.equal(out.find(r => r.cdCliente === 659)?.cliente, 'ARNALDO TAVARES');
  assert.equal(out.find(r => r.cdCliente === 1001)?.cliente, 'MARIA LTDA');
  assert.equal(new Set(out.map(r => r.srcKey)).size, 2);
});

test('mesmo município com UF do pedido diferente vira uma linha só', () => {
  const out = agregarFaturamentoMunicipio([
    linha({ uf_pedido: win1252('PI'), total: 10, qtd_vendas: 1 }),
    linha({ uf_pedido: win1252('MA'), total: 5, qtd_vendas: 1 })
  ].map(mapFaturamentoMunicipioRow));
  assert.equal(out.length, 1);
  assert.equal(out[0].uf, 'PI');
  assert.equal(out[0].total, 15);
  assert.equal(out[0].qtdVendas, 2);
});

test('agregar não altera as linhas de entrada', () => {
  const a = mapFaturamentoMunicipioRow(linha({ total: 1 }));
  const b = mapFaturamentoMunicipioRow(linha({ total: 2 }));
  agregarFaturamentoMunicipio([a, b]);
  assert.equal(a.total, 1);
});

test('janela mensal: desde é alinhado ao 1º dia do mês', () => {
  assert.equal(inicioDoMes('2023-10-13'), '2023-10-01', 'carga de 3 anos não manda mês de borda pela metade');
  assert.equal(inicioDoMes('2026-07-01'), '2026-07-01', 'janela incremental passa intacta');
});

test('toggle: faturamentoMunicipio só entra nos recursos com janela quando ligado', () => {
  assert.ok(!recursosComJanela(new Set()).includes('faturamentoMunicipio'));
  assert.ok(!recursosComJanela(new Set(['orcamentos'])).includes('faturamentoMunicipio'));
  assert.ok(recursosComJanela(new Set(['faturamentoMunicipio'])).includes('faturamentoMunicipio'));
  assert.ok(!recursosComJanela(new Set(['faturamentoMunicipio'])).includes('orcamentos'), 'toggles independentes');
});
