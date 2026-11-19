// gabarito-motor/extractor.js
// Responsavel por:
//   1. Buscar o IDEMPRESA de cada CNPJ via GABARITO_EMPRESAS
//   2. Extrair faturamento mensal via GABARITO_FATURAMENTO_MENSAL
//   3. Extrair contas a pagar via GABARITO_CTAPAGAR_GERAL
//   4. Extrair contas a receber via GABARITO_CTARCEBER_GERAL

const { query } = require('./firebird');
const { logInfo, logWarn, logError } = require('../logger');

// As colunas TEXT das views vêm de campos Firebird CHARACTER SET NONE contendo
// bytes WIN1252 (0xE3=ã, 0xE9=é). O node-firebird decodifica campos NONE como
// UTF-8, então cada byte de acento vira U+FFFD ("♦") — perda irreversível na
// leitura. Solução: as próprias views entregam essas colunas via
// CAST(col AS ... CHARACTER SET OCTETS), que o driver devolve como Buffer com os
// bytes crus; aqui decodificamos WIN1252 corretamente. Ver sql/views_real.sql.
//
// WIN1252 == latin1 exceto na faixa 0x80–0x9F (aspas curvas, €, travessão, etc.),
// mapeada abaixo. Fora dela, o byte é o próprio code point (latin1).
const WIN1252_C1 = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…',
  0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8A: 'Š',
  0x8B: '‹', 0x8C: 'Œ', 0x8E: 'Ž', 0x91: '‘', 0x92: '’',
  0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
  0x98: '˜', 0x99: '™', 0x9A: 'š', 0x9B: '›', 0x9C: 'œ',
  0x9E: 'ž', 0x9F: 'Ÿ'
};

function decodeWin1252(buf) {
  let out = '';
  for (const b of buf) {
    out += (b >= 0x80 && b <= 0x9F && WIN1252_C1[b]) ? WIN1252_C1[b] : String.fromCharCode(b);
  }
  return out;
}

function fixEncoding(v) {
  if (Buffer.isBuffer(v)) return decodeWin1252(v);
  return String(v);
}

/**
 * Lê um campo de texto de uma linha. As views entregam as colunas de texto como
 * OCTETS (Buffer de bytes WIN1252 crus); fixEncoding os decodifica corretamente.
 * Colunas não-OCTETS caem no caminho String (retrocompatível). Sempre retorna
 * string já decodificada e trimada.
 */
function readText(row, campo) {
  const v = row[campo] ?? row[campo.toLowerCase()] ?? '';
  return fixEncoding(v).trim();
}

/**
 * Lê um campo de texto devolvendo `null` (não string vazia) quando não há valor.
 * O ERP grava '' em códigos de conta não usados (ex.: CDSUBSUBSUBCONTA) — a API
 * espera null nesse caso, não "".
 */
function readTextOrNull(row, campo) {
  const s = readText(row, campo);
  return s === '' ? null : s;
}

/** Número ou `null` quando a coluna vem nula/ausente (não converte para 0). */
function readNumberOrNull(row, campo) {
  const v = row[campo] ?? row[campo.toLowerCase()] ?? null;
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Data pura "YYYY-MM-DD" a partir dos componentes LOCAIS do Date.
 *
 * Não use toISOString() aqui: as colunas do destino são DATE e um
 * "2026-09-01T00:00:00-03:00" vira 31/08 no banco — o vencimento cai no mês
 * errado. As colunas de data do CTAPAGAR são TIMESTAMP, então a hora é
 * descartada de propósito.
 *
 * Data impossível (ano < 2000 ou > 2100) vira `null`: descarta-se o VALOR, nunca
 * a linha. Já temos dt_venc gravado como 0219/1023/8202 vindos do contasPagar.
 */
function readDateOnly(row, campo) {
  const v = row[campo] ?? row[campo.toLowerCase()] ?? null;
  const d = (v instanceof Date) ? v : (v ? new Date(v) : null);
  if (!d || Number.isNaN(d.getTime())) return null;
  const ano = d.getFullYear();
  if (ano < 2000 || ano > 2100) return null;
  return `${ano}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
    if (cnpjNormalizado && !(cnpjNormalizado in lookupFirebird)) lookupFirebird[cnpjNormalizado] = id;
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
      ano:           num('ANO'),
      subtotal:      num('SUBTOTAL'),
      desconto:      num('DESCONTO'),
      total:         num('TOTAL'),
      subtotalTroca: num('SUBTOTAL_TROCA'),
      descontoTroca: num('DESCONTO_TROCA'),
      totalTroca:    num('TOTAL_TROCA'),
      qtdVendas:     num('QTD_VENDAS'),
      qtdTrocas:     num('QTD_TROCAS')
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
      subtotal:      0,
      desconto:      0,
      total:         0,
      subtotalTroca: 0,
      descontoTroca: 0,
      totalTroca:    0,
      qtdVendas:     0,
      qtdTrocas:     0
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
    const str = (campo) => readText(row, campo);
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
    const str = (campo) => readText(row, campo);
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
    const str = (campo) => readText(row, campo);
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
      multCaixa:         num('MULTCAIXA'),
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
    const str = (campo) => readText(row, campo);
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

// Passo 8: Extrair Desempenho de Vendedores

/**
 * Busca o desempenho diario por vendedor de um IDEMPRESA.
 * A view ja agrega por empresa/vendedor/dia e filtra status validos.
 * Filtra por DATA_VENDA >= desde (mesma janela da curva/entradas).
 *
 * @param {number} idEmpresa
 * @param {string} desde  YYYY-MM-DD
 * @returns {Promise<Array>}
 */
async function extrairVendedores(idEmpresa, desde) {
  let rows = [];
  try {
    rows = await query(
      `SELECT * FROM GABARITO_VENDEDORES WHERE IDEMPRESA = ? AND DATA_VENDA >= ? ORDER BY DATA_VENDA`,
      [idEmpresa, new Date(desde)]
    );
  } catch (err) {
    logError(`[Gabarito] Erro ao consultar GABARITO_VENDEDORES (IDEMPRESA=${idEmpresa}):`, err);
  }

  return (rows || []).map((row) => {
    const str = (campo) => readText(row, campo);
    const num = (campo) => {
      const v = row[campo] ?? row[campo.toLowerCase()] ?? 0;
      return toNumber(v);
    };
    const dt = (campo) => {
      const v = row[campo] ?? row[campo.toLowerCase()] ?? null;
      return v instanceof Date ? v.toISOString() : (v || null);
    };

    return {
      idEmpresa:                num('IDEMPRESA'),
      cdVendedor:               num('CDVENDEDOR'),
      nomeVend:                 str('NOME_VEND'),
      dataVenda:                dt('DATA_VENDA'),
      totalVendas:              num('TOTAL_VENDAS'),
      totalPedidos:             num('TOTAL_PEDIDOS'),
      clientesAtendidos:        num('CLIENTES_ATENDIDOS'),
      ticketMedio:              num('TICKET_MEDIO'),
      totalDesconto:            num('TOTAL_DESCONTO'),
      descontoItemIndividual:   num('DESCONTO_ITEM_INDIVIDUAL'),
      totalTrocas:              num('TOTAL_TROCAS'),
      qtdTrocas:                num('QTD_TROCAS'),
      qtdProdutos:              num('QTD_PRODUTOS'),
      totalCusto:               num('TOTAL_CUSTO')
    };
  });
}

// Passo 9: Extrair Pedidos por Horario

/**
 * Busca os pedidos faturados detalhados por horario de um IDEMPRESA.
 * A view filtra status validos (1, 3); o motor filtra DTSAIDA >= desde
 * (mesma janela da curva/entradas/vendedores).
 *
 * @param {number} idEmpresa
 * @param {string} desde  YYYY-MM-DD
 * @returns {Promise<Array>}
 */
async function extrairPedidosPorHorario(idEmpresa, desde) {
  let rows = [];
  try {
    rows = await query(
      `SELECT * FROM GABARITO_HORARIO WHERE IDEMPRESA = ? AND DTSAIDA >= ? ORDER BY DTSAIDA`,
      [idEmpresa, new Date(desde)]
    );
  } catch (err) {
    logError(`[Gabarito] Erro ao consultar GABARITO_HORARIO (IDEMPRESA=${idEmpresa}):`, err);
  }

  return (rows || []).map((row) => {
    const str = (campo) => readText(row, campo);
    const num = (campo) => {
      const v = row[campo] ?? row[campo.toLowerCase()] ?? 0;
      return toNumber(v);
    };
    const dt = (campo) => {
      const v = row[campo] ?? row[campo.toLowerCase()] ?? null;
      return v instanceof Date ? v.toISOString() : (v || null);
    };

    return {
      idEmpresa:   num('IDEMPRESA'),
      nomeEmpresa: str('NOMEEMPRESA'),
      dtSaida:     dt('DTSAIDA'),
      horario:     str('HORARIO'),
      hora:        num('HORA'),
      valorPedido: num('VALORPEDIDO'),
      nrPedido:    num('NRPEDIDO')
    };
  });
}

// Passo 10: Extrair Projecao de Pagamento

/**
 * Mapeia uma linha da GABARITO_PROJECAO_PAGAMENTO para o payload da API.
 *
 * Função pura (sem banco) de propósito: é o contrato de campos do recurso e o
 * único ponto onde as regras de formatação da API vivem — datas "YYYY-MM-DD",
 * `null` de verdade (nunca "" nem 0 fabricado), números com ponto decimal e
 * texto já decodificado de WIN1252.
 *
 * @param {object} row  linha crua do driver (colunas em minúsculas)
 * @returns {object}
 */
function mapProjecaoPagamentoRow(row) {
  const str  = (campo) => readTextOrNull(row, campo);
  const num  = (campo) => readNumberOrNull(row, campo);
  const data = (campo) => readDateOnly(row, campo);

  return {
    // PK do CTAPAGAR (CONTROLE) — chave estável do título, única por CNPJ.
    srcKey:        String(row.SRC_KEY ?? row.src_key ?? ''),
    idEmpresa:     num('IDEMPRESA'),
    notaFiscal:    str('NOTAFISCAL'),
    parcela:       num('PARCELA'),
    nrDoc:         str('NRDOC'),
    status:        num('STATUS'),
    dtVenc:        data('DTVENC'),
    dtPagto:       data('DTPAGTO'),
    dtInclusao:    data('DTINCLUSAO'),
    historico:     str('HISTORICO'),
    codPagto:      num('CODPAGTO'),
    // FK inteira para RECEBTO.CDRECEBTO — serializada como string porque é
    // assim que a API declarou o campo. `recebto` é a descrição do CODPAGTO.
    tpPagto:       str('TPPAGTO'),
    recebto:       str('RECEBTO'),
    valor:         num('VALOR'),
    total:         num('TOTAL'),
    juros:         num('JUROS'),
    desconto:      num('DESCONTO'),
    vlPago:        toNumber(row.VLPAGO ?? row.vlpago ?? 0),
    fornecedor:    str('FORNECEDOR'),
    cdFornecedor:  num('CDFORNECEDOR'),
    // Os 4 níveis de conta são VARCHAR no ERP ('007', '7.2'): mandar como
    // número perderia o zero à esquerda e quebraria o agrupamento da tela.
    cdConta1:      str('CDCONTA1'),
    conta1:        str('CONTA1'),
    cdConta2:      str('CDCONTA2'),
    conta2:        str('CONTA2'),
    cdConta3:      str('CDCONTA3'),
    conta3:        str('CONTA3'),
    cdConta4:      str('CDCONTA4'),
    conta4:        str('CONTA4'),
    statusVale:    num('STATUSVALE'),
    cdClienteVale: num('CDCLIENTEVALE')
  };
}

/**
 * Busca a projeção de pagamento de um IDEMPRESA.
 *
 * A janela (mês corrente + 2 meses por DTVENC) e os filtros vivem na view — este
 * recurso não usa `desde`: a janela é FUTURA, o oposto do backfill de 3 anos.
 *
 * Devolve `{ rows, completo }` como extrairCurvaAbc: `completo: false` sinaliza
 * falha de leitura (view ausente, timeout) e é o que impede o Motor de mandar um
 * snapshot vazio — que, com expectedTotal 0, apagaria a tabela viva na API.
 *
 * @param {number} idEmpresa
 * @returns {Promise<{rows: Array, completo: boolean}>}
 */
async function extrairProjecaoPagamento(idEmpresa) {
  let rows = [];
  let completo = true;
  try {
    rows = await query(
      `SELECT * FROM GABARITO_PROJECAO_PAGAMENTO WHERE IDEMPRESA = ? ORDER BY DTVENC, SRC_KEY`,
      [idEmpresa]
    );
  } catch (err) {
    logError(`[Gabarito] Erro ao consultar GABARITO_PROJECAO_PAGAMENTO (IDEMPRESA=${idEmpresa}):`, err);
    completo = false;
  }

  return {
    rows: (rows || [])
      .filter(r => {
        // Filtro antes movido para a VIEW (NOT CONTAINING 'Provis'); feito aqui
        // para evitar "Malformed string" — o Firebird lança esse erro ao comparar
        // HISTORICO (charset ambíguo) com literal string UTF-8 da conexão.
        const hist = String(r.HISTORICO ?? r.historico ?? '');
        return !hist.includes('Provis');
      })
      .map(mapProjecaoPagamentoRow),
    completo
  };
}

// Passo 11: Extrair Orcamentos (conversao em pedido)

// SAIDAESTOQUE.STATUS que contam como pedido gerado (0 aberto, 1/3 faturado).
// 2 = cancelado; trocas (40/42) nem entram na view.
const PEDIDO_VALIDO    = new Set([0, 1, 3]);
const PEDIDO_CANCELADO = 2;

/** Timestamp local do ERP como ISO com o fuso da máquina ("2026-09-29T22:36:13-03:00"). */
function isoLocal(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  const p = (n) => String(Math.abs(n)).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sinal = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    + `${sinal}${p(Math.trunc(off / 60))}:${p(off % 60)}`;
}

function readDate(row, campo) {
  const v = row[campo] ?? row[campo.toLowerCase()] ?? null;
  return (v instanceof Date && !Number.isNaN(v.getTime())) ? v : null;
}

/**
 * Agrega as linhas da GABARITO_ORCAMENTO_PEDIDOS por orçamento.
 *
 * Um orçamento pode ter vários pedidos (27k com 2, até 21 na ARRUDA); o
 * "pedido de conversão" é o válido mais antigo (PEDIDO_TS, desempate NRPEDIDO).
 * O valor convertido soma todos os válidos — é o que de fato virou venda.
 *
 * @param {Array} rows  linhas cruas do driver
 * @returns {Map<string, object>}  chave `${idEmpresa}-${nrOrcamento}`
 */
function agregarPedidosPorOrcamento(rows) {
  const mapa = new Map();
  for (const row of rows || []) {
    const chave  = `${readNumberOrNull(row, 'IDEMPRESA')}-${readNumberOrNull(row, 'NRORCAMENTO')}`;
    const status = readNumberOrNull(row, 'STATUS');
    const a = mapa.get(chave) || { qtdPedidos: 0, qtdPedidosCancelados: 0, nrPedido: null, pedidoTs: null, vlPedidos: 0 };

    if (status === PEDIDO_CANCELADO) {
      a.qtdPedidosCancelados++;
    } else if (PEDIDO_VALIDO.has(status)) {
      a.qtdPedidos++;
      a.vlPedidos += toNumber(row.VLTOTAL ?? row.vltotal ?? 0);
      const ts = readDate(row, 'PEDIDO_TS');
      const nr = readNumberOrNull(row, 'NRPEDIDO');
      const maisAntigo = a.nrPedido === null
        || (ts && (!a.pedidoTs || ts < a.pedidoTs || (+ts === +a.pedidoTs && nr < a.nrPedido)))
        || (!ts && !a.pedidoTs && nr < a.nrPedido);
      if (maisAntigo) { a.nrPedido = nr; a.pedidoTs = ts; }
    }
    mapa.set(chave, a);
  }
  return mapa;
}

/**
 * Mapeia uma linha (item) da GABARITO_ORCAMENTOS + o agregado de pedidos do
 * orçamento para o payload da API. Função pura — é o contrato do recurso.
 *
 * `situacao` vem do PEDIDO, não do ORCAMENTO.STATUS (o trigger do ERP marca
 * finalizado sem olhar IDEMPRESA). Precedência:
 *   CONVERTIDO       — tem pedido válido (0/1/3)
 *   CANCELADO        — orçamento cancelado no ERP
 *   PEDIDO_CANCELADO — gerou pedido, mas todos foram cancelados
 *   ABERTO           — o resto
 * A separação "venda direta × orçamento real" (minutosAtePedido) é da API.
 *
 * @param {object} row     linha crua do driver
 * @param {object} [ped]   agregado de agregarPedidosPorOrcamento()
 * @returns {object}
 */
function mapOrcamentoRow(row, ped) {
  const str  = (campo) => readTextOrNull(row, campo);
  const num  = (campo) => readNumberOrNull(row, campo);
  const p    = ped || { qtdPedidos: 0, qtdPedidosCancelados: 0, nrPedido: null, pedidoTs: null, vlPedidos: 0 };

  const statusErp  = num('STATUS_ERP');
  const dtCancel   = readDateOnly(row, 'DTCANCELAMENTO');
  const dtOrcTs    = readDate(row, 'DTORC_TS');

  let situacao = 'ABERTO';
  if (p.qtdPedidos > 0)                        situacao = 'CONVERTIDO';
  else if (statusErp === 2 || dtCancel)        situacao = 'CANCELADO';
  else if (p.qtdPedidosCancelados > 0)         situacao = 'PEDIDO_CANCELADO';

  const minutosAtePedido = (p.qtdPedidos > 0 && dtOrcTs && p.pedidoTs)
    ? Math.floor((p.pedidoTs - dtOrcTs) / 60000)
    : null;

  return {
    srcKey:               readText(row, 'SRC_KEY'),
    idEmpresa:            num('IDEMPRESA'),
    nrOrcamento:          num('NRORCAMENTO'),
    dtOrc:                readDateOnly(row, 'DTORC'),
    dtOrcTs:              isoLocal(dtOrcTs),
    statusErp,
    dtCancelamento:       dtCancel,
    situacao,
    cdCliente:            num('CDCLIENTE'),
    cliente:              str('CLIENTE'),
    clienteDoc:           str('CLIENTE_DOC'),
    clienteFone:          str('CLIENTE_FONE'),
    clienteEmail:         str('CLIENTE_EMAIL'),
    contato:              str('CONTATO'),
    cdVendedor:           num('CDVENDEDOR'),
    vendedor:             str('VENDEDOR'),
    vendedorFone:         str('VENDEDOR_FONE'),
    vlTotal:              num('VLTOTAL'),
    desconto:             num('DESCONTO'),
    subtotal:             num('SUBTOTAL'),
    observacao:           str('OBSERVACAO'),
    qtdPedidos:           p.qtdPedidos,
    qtdPedidosCancelados: p.qtdPedidosCancelados,
    nrPedido:             p.nrPedido,
    pedidoTs:             isoLocal(p.pedidoTs),
    vlPedidos:            Math.round(p.vlPedidos * 100) / 100,
    minutosAtePedido,
    itemPosic:            num('ITEM_POSIC'),
    itemCodigo:           str('ITEM_CODIGO'),
    itemDescricao:        str('ITEM_DESCRICAO'),
    itemUnidade:          str('ITEM_UNIDADE'),
    itemQtd:              num('ITEM_QTD'),
    itemVlUnit:           num('ITEM_VL_UNIT'),
    itemDesconto:         num('ITEM_DESCONTO'),
    itemVlTotal:          num('ITEM_VL_TOTAL')
  };
}

// Histórico máximo de orçamentos, mesmo na carga única de 3 anos dos demais
// recursos. Medido na ARRUDA: 3 anos = 179k linhas e ~800 MB de heap no Motor;
// 12 meses cabe folgado numa máquina de cliente.
const ORCAMENTOS_HISTORICO_MESES = 12;

/**
 * `desde` efetivo de orçamentos: o mais recente entre o pedido e o teto de
 * ORCAMENTOS_HISTORICO_MESES (1º dia do mês). É esse valor que vai no payload,
 * para a API apagar exatamente a janela que foi lida.
 * @param {string} desde  YYYY-MM-DD
 * @param {Date}   [hoje]
 * @returns {string} YYYY-MM-DD
 */
function limitarDesdeOrcamentos(desde, hoje = new Date()) {
  const teto = new Date(hoje.getFullYear(), hoje.getMonth() - ORCAMENTOS_HISTORICO_MESES, 1);
  const t = `${teto.getFullYear()}-${String(teto.getMonth() + 1).padStart(2, '0')}-01`;
  return desde > t ? desde : t;
}

/**
 * Busca os orçamentos (1 linha por item) de um IDEMPRESA emitidos desde `desde`,
 * já com a conversão em pedido resolvida. Chame com o `desde` já limitado por
 * limitarDesdeOrcamentos().
 *
 * Duas leituras cruzadas em memória: SAIDAESTOQUE não tem índice por
 * NRORCAMENTO, e o JOIN dentro da view varria a tabela por orçamento (>10 min).
 * Pedido de orçamento emitido desde `desde` tem DTSAIDA >= `desde`, então o mesmo
 * filtro (indexado) serve às duas.
 *
 * Os orçamentos são lidos MÊS A MÊS e mapeados na hora: a linha crua do driver
 * (um Buffer por coluna de texto) pesa várias vezes a mapeada, e ler a janela
 * inteira de uma vez segurava as duas versões juntas.
 *
 * `completo: false` se QUALQUER leitura falhar: orçamento sem os pedidos sairia
 * todo como ABERTO — dado errado, pior que dado ausente.
 *
 * @param {number} idEmpresa
 * @param {string} desde  YYYY-MM-DD
 * @returns {Promise<{rows: Array, completo: boolean}>}
 */
async function extrairOrcamentos(idEmpresa, desde) {
  const rows = [];
  try {
    const pedidos = await query(
      `SELECT * FROM GABARITO_ORCAMENTO_PEDIDOS WHERE IDEMPRESA = ? AND DTSAIDA >= ?`,
      [idEmpresa, new Date(`${desde}T00:00:00`)]
    );
    const porOrcamento = agregarPedidosPorOrcamento(pedidos);

    const [ano, mes, dia] = desde.split('-').map(Number);
    const amanha = new Date(); amanha.setHours(0, 0, 0, 0); amanha.setDate(amanha.getDate() + 1);
    let ini = new Date(ano, mes - 1, dia);
    while (ini < amanha) {
      const fim = new Date(ini.getFullYear(), ini.getMonth() + 1, 1);
      const orcs = await query(
        `SELECT * FROM GABARITO_ORCAMENTOS WHERE IDEMPRESA = ? AND DTORC >= ? AND DTORC < ? ORDER BY NRORCAMENTO, ITEM_POSIC`,
        [idEmpresa, ini, fim]
      );
      for (const row of orcs || []) {
        rows.push(mapOrcamentoRow(
          row,
          porOrcamento.get(`${readNumberOrNull(row, 'IDEMPRESA')}-${readNumberOrNull(row, 'NRORCAMENTO')}`)
        ));
      }
      ini = fim;
    }
  } catch (err) {
    logError(`[Gabarito] Erro ao consultar GABARITO_ORCAMENTOS/GABARITO_ORCAMENTO_PEDIDOS (IDEMPRESA=${idEmpresa}):`, err);
    return { rows: [], completo: false };
  }
  return { rows, completo: true };
}

// Passo 12: Extrair Faturamento por Municipio (mapa de faturamento)

// Código IBGE de município: 7 dígitos. O cadastro do ERP tem lixo ('1', '') —
// fora do padrão vira null (descarta-se o VALOR, nunca a linha).
const IBGE_MUNICIPIO = /^\d{7}$/;
const CAMPOS_SOMA_MUNICIPIO = [
  'subtotal', 'desconto', 'total', 'subtotalTroca', 'descontoTroca', 'totalTroca', 'qtdVendas', 'qtdTrocas'
];

/**
 * 1º dia do mês de `desde` (YYYY-MM-DD). O recurso é mensal: uma janela que
 * começasse no meio do mês mandaria o mês de borda pela metade, e a API apagaria
 * o mês inteiro para gravar só parte dele.
 * @param {string} desde  YYYY-MM-DD
 * @returns {string} YYYY-MM-01
 */
function inicioDoMes(desde) {
  return `${desde.slice(0, 7)}-01`;
}

/**
 * Texto livre como chave de agrupamento: o ERP guarda "Centro", "CENTRO ",
 * "centro". A normalização é toda aqui, depois do WIN1252: na view, qualquer
 * TRIM/UPPER sobre coluna NONE dá "Malformed string" pelo driver.
 * @param {string} s
 * @returns {string}  '' quando vazio
 */
function normalizarTexto(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().toLocaleUpperCase('pt-BR');
}

/**
 * Mapeia uma linha da GABARITO_FATURAMENTO_MUNICIPIO para o payload da API.
 * Função pura (sem banco): é o contrato de campos do recurso.
 * @param {object} row  linha crua do driver
 * @returns {object}
 */
function mapFaturamentoMunicipioRow(row) {
  const num = (campo) => toNumber(row[campo] ?? row[campo.toLowerCase()] ?? 0);
  const idEmpresa   = num('IDEMPRESA');
  const ano         = num('ANO');
  const mes         = num('MES');
  // UF do cadastro do município (coerente com o IBGE); a digitada no pedido só
  // quando o município não tem UF.
  const uf          = normalizarTexto(readText(row, 'UF_MUNICIPIO'))
                   || normalizarTexto(readText(row, 'UF_PEDIDO'))
                   || 'SEM UF';
  const cdMunicipio = readNumberOrNull(row, 'CDMUNICIPIO');
  const ibge        = readText(row, 'CDMUNICIPIOIBGE');
  const bairro      = normalizarTexto(readText(row, 'BAIRRO')) || 'SEM BAIRRO';
  const cdVendedor  = readNumberOrNull(row, 'CDVENDEDOR');
  const cdCliente   = readNumberOrNull(row, 'CDCLIENTE');

  return {
    // Chave natural, única por CNPJ. Inclui vendedor e cliente para não fundir
    // nem sobrescrever clientes distintos atendidos no mesmo bairro/mês.
    srcKey:          `${idEmpresa}-${ano}-${mes}-${uf}-${cdMunicipio ?? 0}-${bairro}-${cdVendedor ?? 0}-${cdCliente ?? 0}`,
    idEmpresa,
    ano,
    mes,
    uf,
    cdMunicipio,
    municipio:       readTextOrNull(row, 'MUNICIPIO'),
    cdMunicipioIbge: IBGE_MUNICIPIO.test(ibge) ? ibge : null,
    bairro,
    // Vendedor e cliente: permitem desdobrar o mapa sem join extra na API.
    // Null quando a view não disponibiliza (filial sem a view atualizada).
    cdVendedor,
    nomeVendedor:    readTextOrNull(row, 'NOME_VENDEDOR'),
    cdCliente,
    cliente:         readTextOrNull(row, 'CLIENTE'),
    subtotal:        num('SUBTOTAL'),
    desconto:        num('DESCONTO'),
    total:           num('TOTAL'),
    subtotalTroca:   num('SUBTOTAL_TROCA'),
    descontoTroca:   num('DESCONTO_TROCA'),
    totalTroca:      num('TOTAL_TROCA'),
    qtdVendas:       num('QTD_VENDAS'),
    qtdTrocas:       num('QTD_TROCAS')
  };
}

/**
 * Soma as linhas que caem na mesma chave depois da normalização ("Centro" e
 * "CENTRO " chegam separadas da view, assim como pedidos do mesmo município com
 * UF digitada diferente). Os contadores somam sem erro: cada pedido cai numa
 * única linha (SAIDAESTOQUE é 1 linha por pedido).
 * Sem isso a API receberia chave natural duplicada.
 * @param {object[]} linhas  já mapeadas
 * @returns {object[]}
 */
function agregarFaturamentoMunicipio(linhas) {
  const porChave = new Map();
  for (const l of linhas) {
    const atual = porChave.get(l.srcKey);
    if (!atual) { porChave.set(l.srcKey, { ...l }); continue; }
    for (const c of CAMPOS_SOMA_MUNICIPIO) atual[c] += l[c];
  }
  return [...porChave.values()];
}

/**
 * Faturamento mensal por município/bairro de um IDEMPRESA, desde o mês de
 * `desde`. Chame com o `desde` já alinhado por inicioDoMes().
 *
 * O filtro por IDEMPRESA desce para o índice FK_SE_EMPRESA; o de ANO/MES é sobre
 * o agrupamento. Medido na ARRUDA: 3 anos da maior empresa em ~3 s (5 mil linhas).
 *
 * `completo: false` se a leitura falhar — aí o campo é omitido do envio, para a
 * API não apagar a janela e gravar nada no lugar.
 *
 * @param {number} idEmpresa
 * @param {string} desde  YYYY-MM-01
 * @returns {Promise<{rows: Array, completo: boolean}>}
 */
async function extrairFaturamentoMunicipio(idEmpresa, desde) {
  const [ano, mes] = desde.split('-').map(Number);
  let rows;
  try {
    rows = await query(
      `SELECT * FROM GABARITO_FATURAMENTO_MUNICIPIO WHERE IDEMPRESA = ? AND ANO * 100 + MES >= ? ORDER BY ANO, MES`,
      [idEmpresa, ano * 100 + mes]
    );
  } catch (err) {
    logError(`[Gabarito] Erro ao consultar GABARITO_FATURAMENTO_MUNICIPIO (IDEMPRESA=${idEmpresa}):`, err);
    return { rows: [], completo: false };
  }
  const rawRows = rows || [];
  const agregadas = agregarFaturamentoMunicipio(rawRows.map(mapFaturamentoMunicipioRow));
  if (rawRows.length !== agregadas.length) {
    logWarn(`[Gabarito] [${idEmpresa}] faturamentoMunicipio: ${rawRows.length} linhas do Firebird foram reduzidas para ${agregadas.length} por agrupamento de srcKey. Verifique se a granularidade da chave cobre toda a View.`);
  }
  return { rows: agregadas, completo: true };
}

// ── Auditoria de cadastro de produtos (snapshot, sem janela) ──────────────────
//
// Quatro recursos independentes (auditoriaCodigoBarras, auditoriaNcm,
// auditoriaCustoPreco, auditoriaSemImpostoVenda), todos snapshot completo por CNPJ
// e ligados pelo toggle `auditoriaProdutosEnabled` da API. Só as linhas COM
// problema vão no payload; `situacao` é o código numérico e `situacaoNome` o nome
// (sem acento, de propósito). A ordem dos códigos é a prioridade da regra: vale a
// primeira que se aplica.
//
// Código de barras e NCM: a view entrega a base crua e a classificação é feita
// aqui, sobre texto já decodificado em WIN1252 — função de texto sobre coluna NONE
// dá "Malformed string" no driver, e o REPETIDO exige cruzar todos os códigos
// (JOIN por código dentro do SQL é quadrático no Firebird 2.5).

const SITUACOES_CODIGO_BARRAS = {
  1: 'COM ESPACOS',
  2: 'CARACTERE INVALIDO',
  3: 'TAMANHO ERRADO',
  4: 'REPETIDO'
};
const SITUACOES_NCM = {
  1: 'NCM NULO',
  2: 'NCM EM BRANCO',
  3: 'NCM COM ESPACOS',
  4: 'NCM 99999999',
  5: 'NCM ZERADO',
  6: 'NCM COM CARACTERE NAO NUMERICO',
  7: 'NCM COM MAIS DE 8 DIGITOS',
  8: 'NCM COM MENOS DE 8 DIGITOS'
};
const SITUACOES_CUSTO_PRECO = {
  1: 'CUSTO E PRECO ZERADOS',
  2: 'CUSTO ZERADO',
  3: 'PRECO ZERADO',
  4: 'CUSTO MAIOR QUE PRECO',
  5: 'CUSTO IGUAL AO PRECO'
};
const SITUACOES_SEM_IMPOSTO_VENDA = {
  1: 'SEM IMPOSTO DE VENDA',
  2: 'IMPOSTO DE VENDA INEXISTENTE'
};

// Tamanhos válidos de código de barras: EAN-8, UPC-A, EAN-13 e GTIN-14.
const TAMANHOS_CODIGO_BARRAS = [8, 12, 13, 14];

/** Texto cru (sem trim), `null` quando a coluna é nula — o NCM distingue NULO de EM BRANCO. */
function readTextRaw(row, campo) {
  const v = row[campo] ?? row[campo.toLowerCase()] ?? null;
  return v === null ? null : fixEncoding(v);
}

/** Só espaços nas pontas (o TRIM do Firebird), não tab/quebra de linha. */
function trimEspacos(s) {
  return s.replace(/^ +| +$/g, '');
}

/** INATIVO do ERP: 0 = ativo, -1 = inativo. Nulo não conta como ativo. */
function isInativo(row) {
  return Number(row.INATIVO ?? row.inativo) !== 0;
}

/**
 * Situação de UM código de barras pelas regras locais (que só olham o próprio
 * código). REPETIDO (4) depende do conjunto de produtos e é marcado em
 * auditarCodigosBarras.
 * Em branco/nulo e o texto 'SEM GTIN' (padrão da NF-e) não são problema.
 * @param {string|null} codigo  texto cru, sem trim
 * @returns {number|null}  1 espaço, 2 caractere inválido, 3 tamanho errado, null = ok
 */
function classificarCodigoBarras(codigo) {
  const c = codigo ?? '';
  const t = trimEspacos(c);
  if (t === '' || t.toUpperCase() === 'SEM GTIN') return null;
  if (c.includes(' ')) return 1;
  if (!/^[0-9]+$/.test(c)) return 2;
  if (!TAMANHOS_CODIGO_BARRAS.includes(c.length)) return 3;
  return null;
}

/**
 * Situação de um NCM (PRODUTO.CLASSFISCAL). Válido = exatamente 8 dígitos, sem
 * espaços, diferente de 99999999 e 00000000.
 * @param {string|null} ncm  texto cru, sem trim
 * @returns {number|null}  1..8 (ver SITUACOES_NCM), null = válido
 */
function classificarNcm(ncm) {
  if (ncm === null) return 1;
  if (trimEspacos(ncm) === '') return 2;
  if (ncm.includes(' ')) return 3;
  if (ncm === '99999999') return 4;
  if (/^0+$/.test(ncm)) return 5;
  if (!/^[0-9]+$/.test(ncm)) return 6;
  if (ncm.length > 8) return 7;
  if (ncm.length < 8) return 8;
  return null;
}

/**
 * NCM de 8 dígitos obtido tirando ponto, traço e espaço. `null` quando não há como
 * sugerir (sobra algo que não é NCM válido). É sugestão: conferir antes de aplicar.
 * @param {string|null} ncm
 * @returns {string|null}
 */
function sugerirNcm(ncm) {
  if (ncm === null) return null;
  const limpo = trimEspacos(ncm).replace(/[.\- ]/g, '');
  return /^[0-9]{8}$/.test(limpo) && limpo !== '99999999' && limpo !== '00000000' ? limpo : null;
}

/**
 * Códigos de barras com problema, a partir das linhas da GABARITO_AUD_CODIGO_BARRAS
 * (1 por PRODUTO_CODBARRA). Função pura.
 *
 * REPETIDO: o próprio produto está ativo e o mesmo código (sem espaços nas pontas)
 * aparece em outro produto ATIVO. O mesmo código em várias unidades do MESMO
 * produto não é repetição. `qtdMesmoCodigo` = produtos ativos com o código.
 *
 * @param {object[]} rows  linhas cruas do driver
 * @returns {object[]}
 */
function auditarCodigosBarras(rows) {
  const lidas = rows.map((row) => ({
    cdProduto: readText(row, 'CDPRODUTO'),
    produto:   readText(row, 'PRODUTO'),
    inativo:   isInativo(row),
    cdUnidade: readText(row, 'CDUNIDADE'),
    codBarra:  readTextRaw(row, 'CODBARRA') ?? '',
    padrao:    Number(row.PADRAO ?? row.padrao) === -1
  }));

  // Produtos ATIVOS dono de cada código (chave = código sem espaços nas pontas).
  const donos = new Map();
  for (const l of lidas) {
    const chave = trimEspacos(l.codBarra);
    if (l.inativo || chave === '' || chave.toUpperCase() === 'SEM GTIN') continue;
    if (!donos.has(chave)) donos.set(chave, new Set());
    donos.get(chave).add(l.cdProduto);
  }

  const problemas = [];
  for (const l of lidas) {
    const chave = trimEspacos(l.codBarra);
    const qtd = donos.get(chave)?.size ?? null;
    let situacao = classificarCodigoBarras(l.codBarra);
    if (situacao === null && !l.inativo && qtd > 1) situacao = 4;
    if (situacao === null) continue;
    problemas.push({
      // Todas as colunas da PK de PRODUTO_CODBARRA, com o código cru: único por CNPJ.
      srcKey:               `${l.cdProduto}-${l.cdUnidade}-${l.codBarra}`,
      cdProduto:            l.cdProduto,
      produto:              l.produto,
      inativo:              l.inativo,
      cdUnidade:            l.cdUnidade,
      codigoBarra:          l.codBarra,
      tamanho:              l.codBarra.length,
      padrao:               l.padrao,
      // Código de barras = o próprio código do produto (código interno, não é GTIN).
      codigoIgualCdProduto: chave === l.cdProduto,
      qtdMesmoCodigo:       qtd,
      situacao,
      situacaoNome:         SITUACOES_CODIGO_BARRAS[situacao]
    });
  }
  return problemas;
}

/**
 * NCMs inválidos, a partir das linhas da GABARITO_AUD_NCM (1 por produto). Função pura.
 * @param {object[]} rows  linhas cruas do driver
 * @returns {object[]}
 */
function auditarNcm(rows) {
  const problemas = [];
  for (const row of rows) {
    const ncm = readTextRaw(row, 'CLASSFISCAL');
    const situacao = classificarNcm(ncm);
    if (situacao === null) continue;
    const cdProduto = readText(row, 'CDPRODUTO');
    problemas.push({
      srcKey:          cdProduto,
      cdProduto,
      produto:         readText(row, 'PRODUTO'),
      inativo:         isInativo(row),
      ncm,
      tamanho:         ncm === null ? null : ncm.length,
      cdUnidVenda:     readTextOrNull(row, 'CDUNIDVENDA'),
      idImpostoVenda:  readNumberOrNull(row, 'IDIMPOSTO_VENDA'),
      ncmSugerido:     sugerirNcm(ncm),
      situacao,
      situacaoNome:    SITUACOES_NCM[situacao]
    });
  }
  return problemas;
}

/**
 * Mapeia uma linha da GABARITO_AUD_CUSTO_PRECO (já filtrada e com SITUACAO em SQL).
 * @param {object} row  linha crua do driver
 * @returns {object}
 */
function mapAuditoriaCustoPrecoRow(row) {
  const cdProduto = readText(row, 'CDPRODUTO');
  const idPreco   = readNumberOrNull(row, 'IDPRECO');
  const cdUnidade = readText(row, 'CDUNIDADE');
  const situacao  = toNumber(row.SITUACAO ?? row.situacao);
  return {
    // PK de PRODUTOPRECO.
    srcKey:        `${cdProduto}-${idPreco ?? 0}-${cdUnidade}`,
    cdProduto,
    produto:       readText(row, 'PRODUTO'),
    inativo:       isInativo(row),
    idPreco,
    tabelaPreco:   readTextOrNull(row, 'TABELA_PRECO'),
    cdUnidade,
    vlCusto:       toNumber(row.VLCUSTO ?? row.vlcusto),
    preco:         toNumber(row.PRECO ?? row.preco),
    vlCustoMedio:  readNumberOrNull(row, 'VLCUSTOMEDIO'),
    diferenca:     toNumber(row.DIFERENCA ?? row.diferenca),
    percPrejuizo:  readNumberOrNull(row, 'PERC_PREJUIZO'),
    situacao,
    situacaoNome:  SITUACOES_CUSTO_PRECO[situacao] ?? null,
    dtReajuste:    readDateOnly(row, 'DTREAJUSTE'),
    dtAlter:       readDateOnly(row, 'DTALTER')
  };
}

/**
 * Mapeia uma linha da GABARITO_AUD_SEM_IMPOSTO_VENDA (já filtrada e com SITUACAO em SQL).
 * @param {object} row  linha crua do driver
 * @returns {object}
 */
function mapAuditoriaSemImpostoVendaRow(row) {
  const cdProduto = readText(row, 'CDPRODUTO');
  const situacao  = toNumber(row.SITUACAO ?? row.situacao);
  return {
    srcKey:         cdProduto,
    cdProduto,
    produto:        readText(row, 'PRODUTO'),
    inativo:        isInativo(row),
    classFiscal:    readTextOrNull(row, 'CLASSFISCAL'),
    cdUnidVenda:    readTextOrNull(row, 'CDUNIDVENDA'),
    idImpostoVenda: readNumberOrNull(row, 'IDIMPOSTO_VENDA'),
    situacao,
    situacaoNome:   SITUACOES_SEM_IMPOSTO_VENDA[situacao] ?? null
  };
}

/**
 * Lê uma view da auditoria e transforma as linhas em payload. `completo: false` se
 * a leitura falhar — aí o recurso é omitido do envio e a API preserva o que tinha
 * (um [] de extração falha NÃO pode esvaziar o snapshot dela).
 * @param {string}   recurso   nome do recurso (para o log)
 * @param {string}   view      view do Firebird
 * @param {Function} transformar  (rowsCrus) => linhas do payload
 * @returns {Promise<{rows: Array, completo: boolean}>}
 */
async function extrairAuditoria(recurso, view, transformar) {
  let cruas;
  try {
    cruas = await query(`SELECT * FROM ${view}`, []);
  } catch (err) {
    logError(`[Gabarito] Erro ao consultar ${view} (${recurso}):`, err);
    return { rows: [], completo: false };
  }
  const rows = transformar(cruas || []);
  const chaves = new Set(rows.map(r => r.srcKey));
  if (chaves.size !== rows.length) {
    logWarn(`[Gabarito] ${recurso}: ${rows.length} linhas com apenas ${chaves.size} chaves srcKey únicas (colisão de chave!). Verifique a composição da chave.`);
  }
  return { rows, completo: true };
}

const extrairAuditoriaCodigoBarras = () =>
  extrairAuditoria('auditoriaCodigoBarras', 'GABARITO_AUD_CODIGO_BARRAS', auditarCodigosBarras);
const extrairAuditoriaNcm = () =>
  extrairAuditoria('auditoriaNcm', 'GABARITO_AUD_NCM', auditarNcm);
const extrairAuditoriaCustoPreco = () =>
  extrairAuditoria('auditoriaCustoPreco', 'GABARITO_AUD_CUSTO_PRECO', (rows) => rows.map(mapAuditoriaCustoPrecoRow));
const extrairAuditoriaSemImpostoVenda = () =>
  extrairAuditoria('auditoriaSemImpostoVenda', 'GABARITO_AUD_SEM_IMPOSTO_VENDA', (rows) => rows.map(mapAuditoriaSemImpostoVendaRow));

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
  const str = (campo) => readText(row, campo);
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
    multCaixa:         num('MULTCAIXA'),
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
  extrairEntradas,
  extrairVendedores,
  extrairPedidosPorHorario,
  extrairProjecaoPagamento,
  mapProjecaoPagamentoRow,
  extrairOrcamentos,
  limitarDesdeOrcamentos,
  agregarPedidosPorOrcamento,
  mapOrcamentoRow,
  extrairFaturamentoMunicipio,
  mapFaturamentoMunicipioRow,
  agregarFaturamentoMunicipio,
  inicioDoMes,
  extrairAuditoriaCodigoBarras,
  extrairAuditoriaNcm,
  extrairAuditoriaCustoPreco,
  extrairAuditoriaSemImpostoVenda,
  classificarCodigoBarras,
  classificarNcm,
  sugerirNcm,
  auditarCodigosBarras,
  auditarNcm,
  mapAuditoriaCustoPrecoRow,
  mapAuditoriaSemImpostoVendaRow
};
