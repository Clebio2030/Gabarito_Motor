// gabarito-motor/extractor.js
// Responsavel por:
//   1. Buscar o IDEMPRESA de cada CNPJ via GABARITO_EMPRESAS
//   2. Extrair faturamento mensal via GABARITO_FATURAMENTO_MENSAL
//   3. Extrair contas a pagar via GABARITO_CTAPAGAR_GERAL
//   4. Extrair contas a receber via GABARITO_CTARCEBER_GERAL

const { query } = require('./firebird');
const { logInfo, logWarn, logError } = require('../logger');

function fixEncoding(v) {
  if (Buffer.isBuffer(v)) return v.toString('latin1');
  return String(v);
}

// Passo 2: Mapear CNPJ -> IDEMPRESA

/**
 * Retorna dicionario { "12.345.678/0001-90": 1, ... }
 * cruzando a lista de CNPJs ativos com a view GABARITO_EMPRESAS.
 *
 * @param {string[]} cnpjsAtivos  Lista de CNPJs vindos da API Gabarito.
 * @returns {Promise<Record<string,number>>}
 */
async function mapearCnpjsParaIdEmpresa(cnpjsAtivos) {
  const rows = await query('SELECT IDEMPRESA, TRIM(CGC) AS CGC FROM GABARITO_EMPRESAS');

  // Monta lookup normalizado: remove formatacao do CGC vindo do Firebird
  const lookupFirebird = {};
  for (const row of rows) {
    const cnpjNormalizado = normalizarCnpj(row.cgc || row.CGC || '');
    const id = row.idempresa ?? row.IDEMPRESA;
    if (cnpjNormalizado) lookupFirebird[cnpjNormalizado] = id;
  }

  const mapa = {};
  for (const cnpj of cnpjsAtivos) {
    const chave = normalizarCnpj(cnpj);
    if (lookupFirebird[chave] !== undefined) {
      mapa[cnpj] = lookupFirebird[chave];
    } else {
      logWarn(`[Gabarito] CNPJ ${cnpj} nao encontrado na GABARITO_EMPRESAS — ignorando.`);
    }
  }

  return mapa;
}

// Passo 3: Extrair Faturamento Mensal

/**
 * Busca o faturamento mensal de um IDEMPRESA para o ano informado.
 * Retorna array com um objeto por mes.
 *
 * @param {number} idEmpresa
 * @param {number} ano  Ex: 2026
 * @returns {Promise<Array>}
 */
async function extrairFaturamentoMensal(idEmpresa, ano) {
  let rows = [];
  try {
    rows = await query(
      `SELECT * FROM GABARITO_FATURAMENTO_MENSAL WHERE IDEMPRESA = ? AND ANO = ? ORDER BY MES`,
      [idEmpresa, ano]
    );
  } catch (err) {
    logError(`[Gabarito] Erro ao consultar GABARITO_FATURAMENTO_MENSAL (IDEMPRESA=${idEmpresa}):`, err);
  }

  // Monta lookup dos meses que vieram do Firebird
  const lookup = {};
  for (const row of (rows || [])) {
    const num = (campo) => {
      const v = row[campo] ?? row[campo.toLowerCase()] ?? 0;
      return toNumber(v);
    };
    const mes = num('MES');
    lookup[mes] = {
      mes,
      ano:       num('ANO'),
      subtotal:  num('SUBTOTAL'),
      desconto:  num('DESCONTO'),
      total:     num('TOTAL'),
      qtdVendas: num('QTD_VENDAS')
    };
  }

  // Garante todos os meses de Jan ate o mes atual (inclusive)
  // Meses sem vendas recebem zeros — isso forca a API a zerar o Dashboard
  const mesAtual = (new Date().getFullYear() === ano)
    ? new Date().getMonth() + 1  // mes corrente se for o ano atual
    : 12;                         // todos os meses para anos anteriores

  const resultado = [];
  for (let mes = 1; mes <= mesAtual; mes++) {
    resultado.push(lookup[mes] || {
      mes,
      ano,
      subtotal:  0,
      desconto:  0,
      total:     0,
      qtdVendas: 0
    });
  }

  return resultado;
}

// Passo 4: Extrair Contas a Pagar

/**
 * Busca contas a pagar de um IDEMPRESA.
 * A view ja filtra STATUS IN (1,2) e ultimos 3 anos.
 *
 * @param {number} idEmpresa
 * @returns {Promise<Array>}
 */
async function extrairContasPagar(idEmpresa) {
  let rows = [];
  try {
    rows = await query(
      `SELECT * FROM GABARITO_CTAPAGAR_GERAL WHERE IDEMPRESA = ? ORDER BY DTVENC`,
      [idEmpresa]
    );
  } catch (err) {
    logError(`[Gabarito] Erro ao consultar GABARITO_CTAPAGAR_GERAL (IDEMPRESA=${idEmpresa}):`, err);
  }

  return (rows || []).map((row) => {
    const str = (campo) => {
      const v = row[campo] ?? row[campo.toLowerCase()] ?? '';
      return fixEncoding(v).trim();
    };
    const num = (campo) => {
      const v = row[campo] ?? row[campo.toLowerCase()] ?? 0;
      return toNumber(v);
    };
    const dt = (campo) => {
      const v = row[campo] ?? row[campo.toLowerCase()] ?? null;
      return v instanceof Date ? v.toISOString() : (v || null);
    };

    return {
      nrPedidoVale:  num('NRPEDIDOVALE'),
      nrDoc:         str('NRDOC'),
      dtAlter:       dt('DTALTER'),
      dtLog:         dt('DTLOG'),
      dtVenc:        dt('DTVENC'),
      dtPagto:       dt('DTPAGTO'),
      valor:         num('VALOR'),
      total:         num('TOTAL'),
      formaRecebida: str('FORMARECEBIDA'),
      formaPaga:     str('FORMAPAGA'),
      status:        num('STATUS'),
      nomeEmpresa:   str('NOMEEMPRESA'),
      parcela:       num('PARCELA'),
      cCusto:        str('CCUSTO'),
      historico:     str('HISTORICO'),
      cdFornecedor:  num('CDFORNECEDOR'),
      fornecedor:    str('FORNECEDOR'),
      notaFiscal:    str('NOTAFISCAL'),
      acordo:        str('ACORDO'),
      vlPago:        num('VLPAGO'),
      horaLog:       str('HORALOG'),
      cdConta1:      num('CDCONTA1'),
      conta1:        str('CONTA1'),
      cdDocumento:   num('CDDOCUMENTO'),
      documento:     str('DOCUMENTO'),
      conta2:        str('CONTA2'),
      conta3:        str('CONTA3'),
      conta4:        str('CONTA4')
    };
  });
}

// Passo 5: Extrair Contas a Receber

/**
 * Busca contas a receber de um IDEMPRESA.
 * A view ja filtra STATUS IN (1,2).
 *
 * @param {number} idEmpresa
 * @returns {Promise<Array>}
 */
async function extrairContasReceber(idEmpresa) {
  let rows = [];
  try {
    rows = await query(
      `SELECT * FROM GABARITO_CTARCEBER_GERAL WHERE IDEMPRESA = ? ORDER BY DTVENC`,
      [idEmpresa]
    );
  } catch (err) {
    logError(`[Gabarito] Erro ao consultar GABARITO_CTARCEBER_GERAL (IDEMPRESA=${idEmpresa}):`, err);
  }

  return (rows || []).map((row) => {
    const str = (campo) => {
      const v = row[campo] ?? row[campo.toLowerCase()] ?? '';
      return fixEncoding(v).trim();
    };
    const num = (campo) => {
      const v = row[campo] ?? row[campo.toLowerCase()] ?? 0;
      return toNumber(v);
    };
    const dt = (campo) => {
      const v = row[campo] ?? row[campo.toLowerCase()] ?? null;
      return v instanceof Date ? v.toISOString() : (v || null);
    };

    return {
      nrPedido:      num('NRPEDIDO'),
      nrDoc:         str('NRDOC'),
      dtSaida:       dt('DTSAIDA'),
      dtMov:         dt('DTMOV'),
      dtVenc:        dt('DTVENC'),
      dtCob:         dt('DTCOB'),
      valor:         num('VALOR'),
      divida:        num('DIVIDA'),
      totalPg:       num('TOTALPG'),
      formaRecebida: str('FORMARECEBIDA'),
      formaPaga:     str('FORMAPAGA'),
      status:        num('STATUS'),
      nomeEmpresa:   str('NOMEEMPRESA'),
      vendedor:      str('VENDEDOR'),
      cdCliente:     num('CDCLIENTE'),
      cliente:       str('CLIENTE'),
      cdCaixa:       num('CDCAIXA'),
      parcela:       num('PARCELA'),
      origem:        str('ORIGEM'),
      caixa:         str('CAIXA')
    };
  });
}

// Passo 6: Extrair Curva ABC

/**
 * Busca a curva ABC de produtos de um IDEMPRESA.
 * Filtra pelos últimos 3 anos para otimização de performance.
 *
 * @param {number} idEmpresa
 * @returns {Promise<Array>}
 */
async function extrairCurvaAbc(idEmpresa, desde) {
  // Mapas auxiliares carregados uma vez — independente do número de fatias anuais
  const mapaCodforn = {};
  try {
    const codfornRows = await query(`SELECT CDPRODUTO, CDFORN_PROD FROM PRODUTO_CODFORN`, []);
    for (const r of (codfornRows || [])) {
      const cd = r.CDPRODUTO ?? r.cdproduto;
      const cod = String(r.CDFORN_PROD ?? r.cdforn_prod ?? '').trim();
      if (!cd || !cod) continue;
      if (mapaCodforn[cd]) mapaCodforn[cd].push(cod);
      else mapaCodforn[cd] = [cod];
    }
  } catch (err) {
    logError(`[Gabarito] Erro ao consultar PRODUTO_CODFORN:`, err);
  }

  const mapaCodbarra = {};
  try {
    const codbarraRows = await query(`SELECT CDPRODUTO, CODBARRA FROM PRODUTO_CODBARRA`, []);
    for (const r of (codbarraRows || [])) {
      const cd = r.CDPRODUTO ?? r.cdproduto;
      const cod = String(r.CODBARRA ?? r.codbarra ?? '').trim();
      if (!cd || !cod) continue;
      if (mapaCodbarra[cd]) mapaCodbarra[cd].push(cod);
      else mapaCodbarra[cd] = [cod];
    }
  } catch (err) {
    logError(`[Gabarito] Erro ao consultar PRODUTO_CODBARRA:`, err);
  }

  const mapaPercUbstTrib = {};
  try {
    const percRows = await query(`SELECT CDPRODUTO, PERCSUBSTTRIB FROM PRODUTOPRECO`, []);
    for (const r of (percRows || [])) {
      const cd = r.CDPRODUTO ?? r.cdproduto;
      if (cd == null) continue;
      if (mapaPercUbstTrib[cd] === undefined) {
        mapaPercUbstTrib[cd] = Number(r.PERCSUBSTTRIB ?? r.percsubsttrib ?? 0) || 0;
      }
    }
  } catch (err) {
    logError(`[Gabarito] Erro ao consultar PRODUTOPRECO:`, err);
  }

  // Busca GABARITO_CURVA_ABC fatiada por ano para evitar timeout em janelas longas.
  // Incremental (~2 meses): 1 iteração. Full (3 anos): 1 iteração por ano.
  // Se qualquer ano falhar, `completo=false` é retornado para que o motor
  // não salve o hash — garantindo retry automático no próximo ciclo.
  const desdeDate = new Date(desde);
  const anoInicio = desdeDate.getFullYear();
  const anoAtual  = new Date().getFullYear();
  const allRows   = [];
  let completo    = true;

  for (let ano = anoInicio; ano <= anoAtual; ano++) {
    const inicioFatia = ano === anoInicio ? desdeDate : new Date(ano, 0, 1);
    const fimFatia    = new Date(ano + 1, 0, 1);

    let rows = [];
    try {
      rows = await query(
        `SELECT * FROM GABARITO_CURVA_ABC WHERE IDEMPRESA = ? AND DTSAIDA >= ? AND DTSAIDA < ? ORDER BY DTSAIDA`,
        [idEmpresa, inicioFatia, fimFatia]
      );
      logInfo(`[Gabarito] GABARITO_CURVA_ABC IDEMPRESA=${idEmpresa} ano=${ano}: ${rows.length} registros`);
    } catch (err) {
      logError(`[Gabarito] Erro ao consultar GABARITO_CURVA_ABC (IDEMPRESA=${idEmpresa}, ano=${ano}):`, err);
      completo = false;
    }
    for (const row of (rows || [])) allRows.push(row);
  }

  const rows = allRows;
  return { rows: rows.map((row) => {
    const str = (campo) => {
      const v = row[campo] ?? row[campo.toLowerCase()] ?? '';
      return fixEncoding(v).trim();
    };
    const num = (campo) => {
      const v = row[campo] ?? row[campo.toLowerCase()] ?? 0;
      return toNumber(v);
    };
    const dt = (campo) => {
      const v = row[campo] ?? row[campo.toLowerCase()] ?? null;
      return v instanceof Date ? v.toISOString() : (v || null);
    };

    const cdProduto = num('CDPRODUTO');

    return {
      cdProduto,
      produto:           str('PRODUTO'),
      unidade:           str('UNIDADE'),
      idEmpresa:         num('IDEMPRESA'),
      nrPedido:          num('NRPEDIDO'),
      idPreco:           num('IDPRECO'),
      cdDeposito:        num('CDDEPOSITO'),
      deposito:          str('DEPOSITO'),
      vlUnit:            num('VLUNIT'),
      vlCusto:           num('VLCUSTO'),
      qtdProduto:        num('QTDPRODUTO'),
      qtdeAtual:         num('QTDEATUAL'),
      qtdeMinima:        num('QTDEMINIMA'),
      descProd:          num('DESCPROD'),
      descPed:           num('DESCPED'),
      total:             num('TOTAL'),
      subTotal:          num('SUBTOTAL'),
      tpEntrega:         num('TPENTREGA'),
      inativo:           str('INATIVO'),
      promocao:          str('PROMOCAO'),
      tabPromocao:       str('TABPROMOCAO'),
      codCentral:        str('COD_CENTRAL'),
      cdFabricante:      num('CDFABRICANTE'),
      fabricante:        str('FABRICANTE'),
      cdFornecedor:      num('CDFORNECEDOR'),
      cdGrupo:           num('CDGRUPO'),
      grupo:             str('GRUPO'),
      cdTipo:            num('CDTIPO'),
      tipo:              str('TIPO'),
      cdLinha:           num('CDLINHA'),
      linha:             str('LINHA'),
      cdFamilia:         num('CDFAMILIA'),
      familia:           str('FAMILIA'),
      cdCliente:         num('CDCLIENTE'),
      cdVendedor:        num('CDVENDEDOR'),
      dtSaida:           dt('DTSAIDA'),
      status:            num('STATUS'),
      vlComDescComPromo: num('VLCOMDESCCOMPROMO'),
      vlSemDescComPromo: num('VLSEMDESCCOMPROMO'),
      vlComDescSemPromo: num('VLCOMDESCSEMPROMO'),
      vlSemDescSemPromo: num('VLSEMDESCSEMPROMO'),
      fatorConv:         num('FATORCONV'),
      vlCustoCompra:     num('VLCUSTO_COMPRA'),
      codFornProd:       (mapaCodforn[cdProduto] || []).join(', '),
      codBarra:          (mapaCodbarra[cdProduto] || []).join(', '),
      frete:             num('FRETE'),
      ipi:               num('IPI'),
      icms:              num('ICMS'),
      percUbstTrib:      mapaPercUbstTrib[cdProduto] ?? 0
    };
  }), completo };
}

// Passo 7: Extrair Entradas de Estoque

/**
 * Busca itens de entrada de estoque de um IDEMPRESA.
 * A view ja filtra STATUS = 1 (entradas confirmadas).
 * Usa VLUNIT de ENTRPRODUTO como valor de custo inicial.
 *
 * @param {number} idEmpresa
 * @returns {Promise<Array>}
 */
async function extrairEntradas(idEmpresa, desde) {
  let rows = [];
  try {
    rows = await query(
      `SELECT * FROM GABARITO_ENTRADAS WHERE IDEMPRESA = ? AND DTENTRADA >= ? ORDER BY DTENTRADA`,
      [idEmpresa, new Date(desde)]
    );
  } catch (err) {
    logError(`[Gabarito] Erro ao consultar GABARITO_ENTRADAS (IDEMPRESA=${idEmpresa}):`, err);
  }

  return (rows || []).map((row) => {
    const str = (campo) => {
      const v = row[campo] ?? row[campo.toLowerCase()] ?? '';
      return fixEncoding(v).trim();
    };
    const num = (campo) => {
      const v = row[campo] ?? row[campo.toLowerCase()] ?? 0;
      return toNumber(v);
    };
    const dt = (campo) => {
      const v = row[campo] ?? row[campo.toLowerCase()] ?? null;
      return v instanceof Date ? v.toISOString() : (v || null);
    };

    return {
      notaFiscal:   str('NOTAFISCAL'),
      dtNotaFiscal: dt('DTNOTAFISCAL'),
      dtEntrada:    dt('DTENTRADA'),
      cdProduto:    num('CDPRODUTO'),
      descricao:    str('DESCRICAO'),
      qtde:         num('QTDE'),
      vlCusto:      num('VLCUSTO'),
      idEmpresa:    num('IDEMPRESA'),
      idEntrada:    num('IDENTRADA'),
      empresa:      str('EMPRESA'),
      total:        num('TOTAL'),
      fornecedor:   str('FORNECEDOR'),
      cdFornecedor: num('CDFORNECEDOR')
    };
  });
}

// ── Streaming Curva ABC (Full Sync) ───────────────────────────────────────────

/**
 * Carrega os mapas auxiliares da Curva ABC (codforn, codbarra, percUbstTrib).
 * Chamado uma única vez por CNPJ antes do loop de anos.
 */
async function buildMapasCurvaAbc() {
  const mapaCodforn = {};
  try {
    const rows = await query(`SELECT CDPRODUTO, CDFORN_PROD FROM PRODUTO_CODFORN`, []);
    for (const r of (rows || [])) {
      const cd = r.CDPRODUTO ?? r.cdproduto;
      const cod = String(r.CDFORN_PROD ?? r.cdforn_prod ?? '').trim();
      if (!cd || !cod) continue;
      if (mapaCodforn[cd]) mapaCodforn[cd].push(cod);
      else mapaCodforn[cd] = [cod];
    }
  } catch (err) { logError(`[Gabarito] Erro ao consultar PRODUTO_CODFORN:`, err); }

  const mapaCodbarra = {};
  try {
    const rows = await query(`SELECT CDPRODUTO, CODBARRA FROM PRODUTO_CODBARRA`, []);
    for (const r of (rows || [])) {
      const cd = r.CDPRODUTO ?? r.cdproduto;
      const cod = String(r.CODBARRA ?? r.codbarra ?? '').trim();
      if (!cd || !cod) continue;
      if (mapaCodbarra[cd]) mapaCodbarra[cd].push(cod);
      else mapaCodbarra[cd] = [cod];
    }
  } catch (err) { logError(`[Gabarito] Erro ao consultar PRODUTO_CODBARRA:`, err); }

  const mapaPercUbstTrib = {};
  try {
    const rows = await query(`SELECT CDPRODUTO, PERCSUBSTTRIB FROM PRODUTOPRECO`, []);
    for (const r of (rows || [])) {
      const cd = r.CDPRODUTO ?? r.cdproduto;
      if (cd == null) continue;
      if (mapaPercUbstTrib[cd] === undefined) {
        mapaPercUbstTrib[cd] = Number(r.PERCSUBSTTRIB ?? r.percsubsttrib ?? 0) || 0;
      }
    }
  } catch (err) { logError(`[Gabarito] Erro ao consultar PRODUTOPRECO:`, err); }

  return { mapaCodforn, mapaCodbarra, mapaPercUbstTrib };
}

/**
 * Mapeia uma linha bruta do Firebird para o formato de saída da Curva ABC.
 */
function mapCurvaAbcRow(row, mapaCodforn, mapaCodbarra, mapaPercUbstTrib) {
  const str = (campo) => {
    const v = row[campo] ?? row[campo.toLowerCase()] ?? '';
    return fixEncoding(v).trim();
  };
  const num = (campo) => toNumber(row[campo] ?? row[campo.toLowerCase()] ?? 0);
  const dt  = (campo) => {
    const v = row[campo] ?? row[campo.toLowerCase()] ?? null;
    return v instanceof Date ? v.toISOString() : (v || null);
  };
  const cdProduto = num('CDPRODUTO');
  return {
    cdProduto,
    produto:           str('PRODUTO'),
    unidade:           str('UNIDADE'),
    idEmpresa:         num('IDEMPRESA'),
    nrPedido:          num('NRPEDIDO'),
    idPreco:           num('IDPRECO'),
    cdDeposito:        num('CDDEPOSITO'),
    deposito:          str('DEPOSITO'),
    vlUnit:            num('VLUNIT'),
    vlCusto:           num('VLCUSTO'),
    qtdProduto:        num('QTDPRODUTO'),
    qtdeAtual:         num('QTDEATUAL'),
    qtdeMinima:        num('QTDEMINIMA'),
    descProd:          num('DESCPROD'),
    descPed:           num('DESCPED'),
    total:             num('TOTAL'),
    subTotal:          num('SUBTOTAL'),
    tpEntrega:         num('TPENTREGA'),
    inativo:           str('INATIVO'),
    promocao:          str('PROMOCAO'),
    tabPromocao:       str('TABPROMOCAO'),
    codCentral:        str('COD_CENTRAL'),
    cdFabricante:      num('CDFABRICANTE'),
    fabricante:        str('FABRICANTE'),
    cdFornecedor:      num('CDFORNECEDOR'),
    cdGrupo:           num('CDGRUPO'),
    grupo:             str('GRUPO'),
    cdTipo:            num('CDTIPO'),
    tipo:              str('TIPO'),
    cdLinha:           num('CDLINHA'),
    linha:             str('LINHA'),
    cdFamilia:         num('CDFAMILIA'),
    familia:           str('FAMILIA'),
    cdCliente:         num('CDCLIENTE'),
    cdVendedor:        num('CDVENDEDOR'),
    dtSaida:           dt('DTSAIDA'),
    status:            num('STATUS'),
    vlComDescComPromo: num('VLCOMDESCCOMPROMO'),
    vlSemDescComPromo: num('VLSEMDESCCOMPROMO'),
    vlComDescSemPromo: num('VLCOMDESCSEMPROMO'),
    vlSemDescSemPromo: num('VLSEMDESCSEMPROMO'),
    fatorConv:         num('FATORCONV'),
    vlCustoCompra:     num('VLCUSTO_COMPRA'),
    codFornProd:       (mapaCodforn[cdProduto] || []).join(', '),
    codBarra:          (mapaCodbarra[cdProduto] || []).join(', '),
    frete:             num('FRETE'),
    ipi:               num('IPI'),
    icms:              num('ICMS'),
    percUbstTrib:      mapaPercUbstTrib[cdProduto] ?? 0
  };
}

/**
 * Versão streaming da Curva ABC para o full sync.
 * Carrega mapas auxiliares uma vez e processa cada ano separadamente,
 * chamando onAno({ ano, anoDesde, rows, completo }) e aguardando.
 * Cada ano é liberado da memória antes do próximo ser carregado.
 *
 * @param {number}   idEmpresa
 * @param {string}   desde       YYYY-MM-DD — data de início da janela
 * @param {Function} onAno       async ({ ano, anoDesde, rows, completo }) => void
 */
async function extrairCurvaAbcStreaming(idEmpresa, desde, onAno) {
  const mapas = await buildMapasCurvaAbc();

  const desdeDate = new Date(desde);
  const anoInicio = desdeDate.getFullYear();
  const anoAtual  = new Date().getFullYear();

  for (let ano = anoInicio; ano <= anoAtual; ano++) {
    const inicioFatia = ano === anoInicio ? desdeDate : new Date(ano, 0, 1);
    const fimFatia    = new Date(ano + 1, 0, 1);
    // Data local YYYY-MM-DD (evita deslocamento de fuso do toISOString)
    const anoDesde = `${inicioFatia.getFullYear()}-${String(inicioFatia.getMonth() + 1).padStart(2, '0')}-${String(inicioFatia.getDate()).padStart(2, '0')}`;

    let rawRows = [];
    let completo = true;
    try {
      rawRows = await query(
        `SELECT * FROM GABARITO_CURVA_ABC WHERE IDEMPRESA = ? AND DTSAIDA >= ? AND DTSAIDA < ? ORDER BY DTSAIDA`,
        [idEmpresa, inicioFatia, fimFatia]
      );
      logInfo(`[Gabarito] GABARITO_CURVA_ABC IDEMPRESA=${idEmpresa} ano=${ano}: ${rawRows.length} registros`);
    } catch (err) {
      logError(`[Gabarito] Erro ao consultar GABARITO_CURVA_ABC (IDEMPRESA=${idEmpresa}, ano=${ano}):`, err);
      completo = false;
    }

    // Mapeia e passa para o callback — rawRows pode ser GC'd após o await
    const rows = (rawRows || []).map(r => mapCurvaAbcRow(r, mapas.mapaCodforn, mapas.mapaCodbarra, mapas.mapaPercUbstTrib));
    await onAno({ ano, anoDesde, rows, completo });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Remove tudo que nao e digito para comparacao neutra de CNPJ. */
function normalizarCnpj(cnpj) {
  return String(cnpj).replace(/\D/g, '');
}

/** Garante que o valor e sempre number (nunca null/undefined). */
function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

module.exports = {
  mapearCnpjsParaIdEmpresa,
  extrairFaturamentoMensal,
  extrairContasPagar,
  extrairContasReceber,
  extrairCurvaAbc,
  extrairCurvaAbcStreaming,
  extrairEntradas
};
