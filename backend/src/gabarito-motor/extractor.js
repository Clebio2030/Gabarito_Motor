// gabarito-motor/extractor.js
// Responsavel por:
//   1. Buscar o IDEMPRESA de cada CNPJ via GABARITO_EMPRESAS
//   2. Extrair faturamento mensal via GABARITO_FATURAMENTO_MENSAL
//   3. Extrair contas a pagar via GABARITO_CTAPAGAR_GERAL
//   4. Extrair contas a receber via GABARITO_CTARCEBER_GERAL

const { query } = require('./firebird');
const { logInfo, logWarn, logError } = require('../logger');

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
      return String(v).trim();
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
      return String(v).trim();
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
async function extrairCurvaAbc(idEmpresa) {
  let rows = [];
  try {
    rows = await query(
      `SELECT * FROM GABARITO_CURVA_ABC WHERE IDEMPRESA = ? AND DTSAIDA >= DATEADD(-3 YEAR TO CURRENT_DATE) ORDER BY DTSAIDA`,
      [idEmpresa]
    );
  } catch (err) {
    logError(`[Gabarito] Erro ao consultar GABARITO_CURVA_ABC (IDEMPRESA=${idEmpresa}):`, err);
  }

  return (rows || []).map((row) => {
    const str = (campo) => {
      const v = row[campo] ?? row[campo.toLowerCase()] ?? '';
      return String(v).trim();
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
      cdProduto:         num('CDPRODUTO'),
      produto:           str('PRODUTO'),
      unidade:           str('UNIDADE'),
      idEmpresa:         num('IDEMPRESA'),
      nrPedido:          num('NRPEDIDO'),
      idPreco:           num('IDPRECO'),
      cdDeposito:        num('CDDEPOSITO'),
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
      vlCustoCompra:     num('VLCUSTO_COMPRA')
    };
  });
}

// Helpers

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
  extrairCurvaAbc
};
