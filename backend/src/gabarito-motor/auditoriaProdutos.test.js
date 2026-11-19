// Testes da auditoria de cadastro de produtos (4 snapshots: código de barras, NCM,
// custo × preço, sem imposto de venda). Roda sem banco:
//   node --test src/gabarito-motor/auditoriaProdutos.test.js
//
// As linhas imitam o que as views GABARITO_AUD_* devolvem (colunas em minúsculas,
// texto em OCTETS = Buffer de bytes WIN1252).

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const STATE_FILE = path.join(os.tmpdir(), `gabarito-auditoria-test-${process.pid}.json`);
process.env.GABARITO_STATE_FILE = STATE_FILE;
process.env.GABARITO_DISABLE_BOOTSTRAP = 'true';

const {
  classificarCodigoBarras, classificarNcm, sugerirNcm,
  auditarCodigosBarras, auditarNcm,
  mapAuditoriaCustoPrecoRow, mapAuditoriaSemImpostoVendaRow
} = require('./extractor');
const { sincronizarAuditoriaProdutos } = require('./index');

const win1252 = (s) => Buffer.from(
  [...s].map(c => ({ 'ã': 0xE3, 'Ã': 0xC3, 'é': 0xE9, 'ç': 0xE7, 'Ç': 0xC7 }[c] ?? c.charCodeAt(0)))
);

test.afterEach(() => { try { fs.unlinkSync(STATE_FILE); } catch {} });

// ── Código de barras ────────────────────────────────────────────────────────────

test('classificarCodigoBarras: regras locais, na ordem de prioridade', () => {
  assert.equal(classificarCodigoBarras('7898059540010'), null);   // EAN-13
  assert.equal(classificarCodigoBarras('12345678'), null);        // EAN-8
  assert.equal(classificarCodigoBarras('123456789012'), null);    // UPC-A
  assert.equal(classificarCodigoBarras('12345678901234'), null);  // GTIN-14
  assert.equal(classificarCodigoBarras('7898059540010 '), 1);     // espaço no fim
  assert.equal(classificarCodigoBarras(' 7898059540010'), 1);     // espaço no início
  assert.equal(classificarCodigoBarras('789 805954001'), 1);      // espaço no meio
  assert.equal(classificarCodigoBarras('7898059540010-'), 2);     // traço
  assert.equal(classificarCodigoBarras('ABC123'), 2);             // letras
  assert.equal(classificarCodigoBarras('123'), 3);                // curto
  assert.equal(classificarCodigoBarras('123456789'), 3);          // 9 dígitos
  assert.equal(classificarCodigoBarras('123 '), 1);               // espaço vence tamanho
  assert.equal(classificarCodigoBarras('12 A'), 1);               // espaço vence caractere
});

test('classificarCodigoBarras: vazio, nulo e SEM GTIN não são problema', () => {
  assert.equal(classificarCodigoBarras(null), null);
  assert.equal(classificarCodigoBarras(''), null);
  assert.equal(classificarCodigoBarras('   '), null);
  assert.equal(classificarCodigoBarras('SEM GTIN'), null);
  assert.equal(classificarCodigoBarras('sem gtin'), null);
  assert.equal(classificarCodigoBarras(' SEM GTIN '), null);
});

function linhaCb(over = {}) {
  return {
    cdproduto: win1252('100'), produto: win1252('CAMISA AÇO'), inativo: 0,
    cdunidade: win1252('UN'), codbarra: win1252('7898059540010'), padrao: -1, ...over
  };
}

test('auditarCodigosBarras: payload tem exatamente os campos do contrato', () => {
  const [r] = auditarCodigosBarras([linhaCb({ codbarra: win1252('123') })]);
  assert.deepEqual(Object.keys(r), [
    'srcKey', 'cdProduto', 'produto', 'inativo', 'cdUnidade', 'codigoBarra', 'tamanho',
    'padrao', 'codigoIgualCdProduto', 'qtdMesmoCodigo', 'situacao', 'situacaoNome'
  ]);
  assert.equal(r.produto, 'CAMISA AÇO');   // WIN1252 decodificado
  assert.equal(r.situacao, 3);
  assert.equal(r.situacaoNome, 'TAMANHO ERRADO');
  assert.equal(r.padrao, true);
  assert.equal(r.inativo, false);
  assert.equal(r.tamanho, 3);
  assert.equal(r.srcKey, '100-UN-123');
});

test('auditarCodigosBarras: só entram as linhas com problema', () => {
  const r = auditarCodigosBarras([
    linhaCb({ cdproduto: win1252('1'), codbarra: win1252('7898059540010') }),
    linhaCb({ cdproduto: win1252('2'), codbarra: win1252('7898059540027 ') }),
    linhaCb({ cdproduto: win1252('3'), codbarra: win1252('') }),
    linhaCb({ cdproduto: win1252('4'), codbarra: win1252('SEM GTIN') })
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].cdProduto, '2');
  assert.equal(r[0].situacao, 1);
  // O código sai cru, com o espaço — é o que o cliente precisa enxergar.
  assert.equal(r[0].codigoBarra, '7898059540027 ');
});

test('REPETIDO: mesmo código em outro produto ATIVO marca os dois', () => {
  const r = auditarCodigosBarras([
    linhaCb({ cdproduto: win1252('1'), codbarra: win1252('7898059540010') }),
    linhaCb({ cdproduto: win1252('2'), codbarra: win1252('7898059540010') }),
    linhaCb({ cdproduto: win1252('3'), codbarra: win1252('7898059540027') })
  ]);
  assert.deepEqual(r.map(x => [x.cdProduto, x.situacao, x.qtdMesmoCodigo]), [['1', 4, 2], ['2', 4, 2]]);
  assert.equal(r[0].situacaoNome, 'REPETIDO');
});

test('REPETIDO: produto inativo não é marcado, nem conta como dono do código', () => {
  const r = auditarCodigosBarras([
    linhaCb({ cdproduto: win1252('1'), codbarra: win1252('7898059540010') }),
    linhaCb({ cdproduto: win1252('2'), codbarra: win1252('7898059540010'), inativo: -1 })
  ]);
  assert.deepEqual(r, []);
});

test('REPETIDO: mesmo código em várias unidades do MESMO produto não é repetição', () => {
  const r = auditarCodigosBarras([
    linhaCb({ cdproduto: win1252('1'), cdunidade: win1252('UN'), codbarra: win1252('7898059540010') }),
    linhaCb({ cdproduto: win1252('1'), cdunidade: win1252('CX'), codbarra: win1252('7898059540010'), padrao: 0 })
  ]);
  assert.deepEqual(r, []);
});

test('REPETIDO: ignora espaço nas pontas ao comparar, e a linha com espaço fica COM ESPACOS', () => {
  const r = auditarCodigosBarras([
    linhaCb({ cdproduto: win1252('1'), codbarra: win1252('7898059540010') }),
    linhaCb({ cdproduto: win1252('2'), codbarra: win1252('7898059540010 ') })
  ]);
  const porProduto = Object.fromEntries(r.map(x => [x.cdProduto, x.situacao]));
  assert.equal(porProduto['2'], 1);   // espaço é a primeira regra
  assert.equal(porProduto['1'], 4);   // o outro dono ativo faz o 1 ser repetido
});

test('codigoIgualCdProduto: o código de barras é o próprio código do produto', () => {
  const [r] = auditarCodigosBarras([linhaCb({ cdproduto: win1252('4521'), codbarra: win1252('4521') })]);
  assert.equal(r.situacao, 3);
  assert.equal(r.codigoIgualCdProduto, true);
});

test('srcKey de código de barras é único por (produto, unidade, código)', () => {
  const r = auditarCodigosBarras([
    linhaCb({ cdproduto: win1252('1'), cdunidade: win1252('UN'), codbarra: win1252('1') }),
    linhaCb({ cdproduto: win1252('1'), cdunidade: win1252('CX'), codbarra: win1252('1') }),
    linhaCb({ cdproduto: win1252('1'), cdunidade: win1252('UN'), codbarra: win1252('1 ') })
  ]);
  assert.equal(r.length, 3);
  assert.equal(new Set(r.map(x => x.srcKey)).size, 3);
});

// ── NCM ─────────────────────────────────────────────────────────────────────────

test('classificarNcm: as 8 situações e o NCM válido', () => {
  assert.equal(classificarNcm(null), 1);
  assert.equal(classificarNcm(''), 2);
  assert.equal(classificarNcm('   '), 2);
  assert.equal(classificarNcm('4016 9300'), 3);
  assert.equal(classificarNcm('40169300 '), 3);
  assert.equal(classificarNcm('99999999'), 4);
  assert.equal(classificarNcm('00000000'), 5);
  assert.equal(classificarNcm('0'), 5);
  assert.equal(classificarNcm('4016.93.00'), 6);
  assert.equal(classificarNcm('4016930X'), 6);
  assert.equal(classificarNcm('401693001'), 7);
  assert.equal(classificarNcm('4016930'), 8);
  assert.equal(classificarNcm('40169300'), null);
});

test('sugerirNcm: tira ponto, traço e espaço; só sugere NCM de 8 dígitos válido', () => {
  assert.equal(sugerirNcm('4016.93.00'), '40169300');
  assert.equal(sugerirNcm('4016-93-00'), '40169300');
  assert.equal(sugerirNcm(' 4016 9300 '), '40169300');
  assert.equal(sugerirNcm('4016.93'), null);     // sobra menos de 8
  assert.equal(sugerirNcm('9999.99.99'), null);  // genérico
  assert.equal(sugerirNcm(null), null);
  assert.equal(sugerirNcm(''), null);
});

test('auditarNcm: payload, NULO × EM BRANCO e filtro dos válidos', () => {
  const base = { cdproduto: win1252('1'), produto: win1252('PARAFUSO'), inativo: 0, cdunidvenda: win1252('UN'), idimposto_venda: 7 };
  const r = auditarNcm([
    { ...base, cdproduto: win1252('1'), classfiscal: null },
    { ...base, cdproduto: win1252('2'), classfiscal: win1252('') },
    { ...base, cdproduto: win1252('3'), classfiscal: win1252('4016.93.00') },
    { ...base, cdproduto: win1252('4'), classfiscal: win1252('40169300') }   // válido: fora
  ]);
  assert.deepEqual(r.map(x => [x.cdProduto, x.situacao]), [['1', 1], ['2', 2], ['3', 6]]);
  assert.deepEqual(Object.keys(r[2]), [
    'srcKey', 'cdProduto', 'produto', 'inativo', 'ncm', 'tamanho', 'cdUnidVenda',
    'idImpostoVenda', 'ncmSugerido', 'situacao', 'situacaoNome'
  ]);
  assert.equal(r[0].ncm, null);
  assert.equal(r[0].tamanho, null);
  assert.equal(r[2].ncm, '4016.93.00');
  assert.equal(r[2].ncmSugerido, '40169300');
  assert.equal(r[2].situacaoNome, 'NCM COM CARACTERE NAO NUMERICO');
  assert.equal(r[2].idImpostoVenda, 7);
});

// ── Custo × preço e sem imposto de venda ───────────────────────────────────────

test('mapAuditoriaCustoPrecoRow: contrato de campos e chave da PK', () => {
  const r = mapAuditoriaCustoPrecoRow({
    cdproduto: win1252('10'), produto: win1252('BOLA'), inativo: -1, idpreco: 2,
    tabela_preco: win1252('ATACADO'), cdunidade: win1252('UN'), vlcusto: 12.5, preco: 10,
    vlcustomedio: 11, diferenca: 2.5, perc_prejuizo: 20, situacao: 4,
    dtreajuste: new Date(2026, 4, 3), dtalter: null
  });
  assert.deepEqual(Object.keys(r), [
    'srcKey', 'cdProduto', 'produto', 'inativo', 'idPreco', 'tabelaPreco', 'cdUnidade',
    'vlCusto', 'preco', 'vlCustoMedio', 'diferenca', 'percPrejuizo',
    'situacao', 'situacaoNome', 'dtReajuste', 'dtAlter'
  ]);
  assert.equal(r.srcKey, '10-2-UN');
  assert.equal(r.inativo, true);
  assert.equal(r.situacaoNome, 'CUSTO MAIOR QUE PRECO');
  assert.equal(r.dtReajuste, '2026-05-03');
  assert.equal(r.dtAlter, null);
  assert.equal(r.percPrejuizo, 20);
});

test('mapAuditoriaCustoPrecoRow: custo/preço nulos viram 0 e percentual nulo segue nulo', () => {
  const r = mapAuditoriaCustoPrecoRow({
    cdproduto: win1252('10'), produto: win1252('BOLA'), inativo: 0, idpreco: 1, cdunidade: win1252('UN'),
    vlcusto: null, preco: null, diferenca: 0, perc_prejuizo: null, situacao: 1
  });
  assert.equal(r.vlCusto, 0);
  assert.equal(r.preco, 0);
  assert.equal(r.percPrejuizo, null);
  assert.equal(r.tabelaPreco, null);
  assert.equal(r.situacaoNome, 'CUSTO E PRECO ZERADOS');
});

test('mapAuditoriaSemImpostoVendaRow: contrato de campos', () => {
  const r = mapAuditoriaSemImpostoVendaRow({
    cdproduto: win1252('2769'), produto: win1252('PNEU'), inativo: 0,
    classfiscal: win1252('40111000'), cdunidvenda: win1252('UN'), idimposto_venda: 99, situacao: 2
  });
  assert.deepEqual(Object.keys(r), [
    'srcKey', 'cdProduto', 'produto', 'inativo', 'classFiscal', 'cdUnidVenda', 'idImpostoVenda',
    'situacao', 'situacaoNome'
  ]);
  assert.equal(r.srcKey, '2769');
  assert.equal(r.situacaoNome, 'IMPOSTO DE VENDA INEXISTENTE');
  assert.equal(r.idImpostoVenda, 99);
});

// ── Orquestração: hash próprio, snapshot vazio, falha, reenvio ─────────────────

function envio() {
  const postados = [];
  const sendFn = async (payload) => {
    postados.push(payload);
    const campo = Object.keys(payload.registros[0]).find(k => k !== 'cnpj');
    return { ok: true, persisted: { [campo]: { total: payload.expectedTotal } } };
  };
  return { postados, sendFn };
}

const ext = (rows, completo = true) => async () => ({ rows, completo });
const linhaNcm = { srcKey: '1', cdProduto: '1', situacao: 6 };

test('envia cada recurso como POST isolado, staging, sem `desde`, syncMode full', async () => {
  const { postados, sendFn } = envio();
  const r = await sincronizarAuditoriaProdutos('CNPJ1', '2026-11-18', {
    sendFn,
    extratores: [['auditoriaNcm', ext([linhaNcm])], ['auditoriaSemImpostoVenda', ext([{ srcKey: '9' }])]]
  });
  assert.deepEqual(r.enviados, ['auditoriaNcm', 'auditoriaSemImpostoVenda']);
  assert.equal(postados.length, 2);
  for (const p of postados) {
    assert.equal(p.syncMode, 'full');
    assert.equal('desde' in p, false);
    assert.equal(p.expectedTotal, 1);
    assert.ok(p.snapshotId);
    assert.equal(Object.keys(p.registros[0]).length, 2);   // cnpj + um recurso
  }
  assert.ok(postados[0].registros[0].auditoriaNcm);
});

test('dedup por hash próprio: segundo ciclo sem mudança não reenvia', async () => {
  const { postados, sendFn } = envio();
  const opts = { sendFn, extratores: [['auditoriaNcm', ext([linhaNcm])]] };
  await sincronizarAuditoriaProdutos('CNPJ1', '2026-11-18', opts);
  const r2 = await sincronizarAuditoriaProdutos('CNPJ1', '2026-11-18', opts);
  assert.deepEqual(r2.inalterados, ['auditoriaNcm']);
  assert.equal(postados.length, 1);
});

test('mudou o conteúdo → reenvia; forcar (resyncToken) ignora o hash', async () => {
  const { postados, sendFn } = envio();
  await sincronizarAuditoriaProdutos('CNPJ1', '2026-11-18', { sendFn, extratores: [['auditoriaNcm', ext([linhaNcm])]] });
  await sincronizarAuditoriaProdutos('CNPJ1', '2026-11-18', { sendFn, extratores: [['auditoriaNcm', ext([linhaNcm, { srcKey: '2', cdProduto: '2', situacao: 1 }])]] });
  assert.equal(postados.length, 2);
  await sincronizarAuditoriaProdutos('CNPJ1', '2026-11-18', { sendFn, forcar: true, extratores: [['auditoriaNcm', ext([linhaNcm])]] });
  assert.equal(postados.length, 3);
});

test('snapshot vazio com extração OK é enviado (esvazia o que o cliente já corrigiu)', async () => {
  const { postados, sendFn } = envio();
  const r = await sincronizarAuditoriaProdutos('CNPJ1', '2026-11-18', { sendFn, extratores: [['auditoriaNcm', ext([])]] });
  assert.deepEqual(r.enviados, ['auditoriaNcm']);
  assert.equal(postados.length, 1);
  assert.equal(postados[0].expectedTotal, 0);
  assert.deepEqual(postados[0].registros[0].auditoriaNcm, []);
});

test('extração falha: campo omitido, nada carimbado, os demais seguem', async () => {
  const { postados, sendFn } = envio();
  const r = await sincronizarAuditoriaProdutos('CNPJ1', '2026-11-18', {
    sendFn,
    extratores: [['auditoriaNcm', ext([], false)], ['auditoriaSemImpostoVenda', ext([{ srcKey: '9' }])]]
  });
  assert.deepEqual(r.falhas, ['auditoriaNcm']);
  assert.deepEqual(r.enviados, ['auditoriaSemImpostoVenda']);
  assert.equal(postados.length, 1);
  assert.ok(!postados[0].registros[0].auditoriaNcm);
  // No ciclo seguinte, a extração que voltou é enviada (nada foi carimbado).
  const { postados: p2, sendFn: s2 } = envio();
  await sincronizarAuditoriaProdutos('CNPJ1', '2026-11-18', { sendFn: s2, extratores: [['auditoriaNcm', ext([linhaNcm])]] });
  assert.equal(p2.length, 1);
});

test('envio falho não carimba o hash: o próximo ciclo reenvia', async () => {
  const falha = async () => ({ ok: false });
  const r1 = await sincronizarAuditoriaProdutos('CNPJ1', '2026-11-18', { sendFn: falha, extratores: [['auditoriaNcm', ext([linhaNcm])]] });
  assert.deepEqual(r1.falhas, ['auditoriaNcm']);
  const { postados, sendFn } = envio();
  await sincronizarAuditoriaProdutos('CNPJ1', '2026-11-18', { sendFn, extratores: [['auditoriaNcm', ext([linhaNcm])]] });
  assert.equal(postados.length, 1);
});

test('divergência de persisted reprova o recurso (não confia só no 200)', async () => {
  const truncado = async (p) => ({ ok: true, persisted: { auditoriaNcm: { total: p.expectedTotal - 1 } } });
  const r = await sincronizarAuditoriaProdutos('CNPJ1', '2026-11-18', {
    sendFn: truncado, extratores: [['auditoriaNcm', ext([linhaNcm])]]
  });
  assert.deepEqual(r.falhas, ['auditoriaNcm']);
});

test('hash de auditoria é por CNPJ e por recurso', async () => {
  const { postados, sendFn } = envio();
  const opts = { sendFn, extratores: [['auditoriaNcm', ext([linhaNcm])]] };
  await sincronizarAuditoriaProdutos('CNPJ1', '2026-11-18', opts);
  await sincronizarAuditoriaProdutos('CNPJ2', '2026-11-18', opts);
  assert.equal(postados.length, 2);
});

test('o hash da auditoria sobrevive ao updateState do ciclo principal', async () => {
  const { updateState } = require('./syncState');
  const { postados, sendFn } = envio();
  const opts = { sendFn, extratores: [['auditoriaNcm', ext([linhaNcm])]] };
  await sincronizarAuditoriaProdutos('CNPJ1', '2026-11-18', opts);
  updateState('CNPJ1', 'hash-do-ciclo-principal');
  const r = await sincronizarAuditoriaProdutos('CNPJ1', '2026-11-18', opts);
  assert.deepEqual(r.inalterados, ['auditoriaNcm']);
  assert.equal(postados.length, 1);
});
