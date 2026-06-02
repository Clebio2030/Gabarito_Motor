/* =============================================================
   GABARITO - Views de Integracao (Firebird)
   Arquivo : sql/criar_views_gabarito.sql
   Execute via: criar_views_gabarito.bat
   =============================================================

   Pre-requisitos
   - Estas views sao lidas pelo gabarito-motor a cada ciclo.
   - Execute este script UMA VEZ na implantacao inicial.
   - Pode ser executado novamente sem problemas (CREATE OR ALTER).

   Adapte os SQLs ao banco do cliente se o nome das tabelas
   ou colunas for diferente.
   ============================================================= */


/* GABARITO_EMPRESAS
   Mapeia IDEMPRESA <-> CNPJ para que o motor cruze os CNPJs
   retornados pela API Gabarito com as empresas no ERP.

   - IDEMPRESA : numero inteiro que identifica a empresa no ERP
   - CGC       : CNPJ da empresa

   Origem: tabela CONFIGURACAO (colunas IDEMPRESA e CNPJ)
   ------------------------------------------------------------------ */

CREATE OR ALTER VIEW GABARITO_EMPRESAS (
  IDEMPRESA,
  CGC
) AS
SELECT
    c.IDEMPRESA        AS IDEMPRESA,
    TRIM(c.CNPJ)       AS CGC
FROM CONFIGURACAO c;


/* GABARITO_FATURAMENTO_MENSAL
   Faturamento mensal agrupado por empresa, mes e ano.
   Filtra apenas vendas com STATUS validos (1, 3, 40, 43).

   Colunas:
   - IDEMPRESA   : empresa no ERP
   - SUBTOTAL    : soma dos subtotais do mes
   - DESCONTO    : soma dos descontos do mes
   - TOTAL       : soma dos valores totais do mes
   - MES         : numero do mes (1-12)
   - ANO         : ano (ex: 2026)
   - QTD_VENDAS  : quantidade de pedidos no mes

   Filtro usado pelo motor:
       WHERE IDEMPRESA = :id AND ANO = :ano
   ------------------------------------------------------------------ */

CREATE OR ALTER VIEW GABARITO_FATURAMENTO_MENSAL (
  IDEMPRESA,
  SUBTOTAL,
  DESCONTO,
  TOTAL,
  MES,
  ANO,
  QTD_VENDAS
) AS
SELECT
    se.IDEMPRESA,
    SUM(se.SUBTOTAL)                     AS SUBTOTAL,
    SUM(se.DESCONTO)                     AS DESCONTO,
    SUM(se.VLTOTAL)                      AS TOTAL,
    EXTRACT(MONTH FROM se.DTSAIDA)       AS MES,
    EXTRACT(YEAR FROM se.DTSAIDA)        AS ANO,
    COUNT(DISTINCT se.NRPEDIDO)          AS QTD_VENDAS
FROM
    saidaestoque se
WHERE
    se.STATUS IN (1, 3, 40, 43)
GROUP BY
    se.IDEMPRESA,
    EXTRACT(YEAR FROM se.DTSAIDA),
    EXTRACT(MONTH FROM se.DTSAIDA);


/* GABARITO_CTAPAGAR_GERAL
   Contas a pagar consolidadas com todos os dados de apoio.

   Colunas:
   - IDEMPRESA      : empresa no ERP
   - NRPEDIDOVALE   : numero do pedido/vale
   - NRDOC          : numero do documento
   - DTALTER        : data de alteracao
   - DTLOG          : data do log
   - DTVENC         : data de vencimento
   - DTPAGTO        : data de pagamento
   - VALOR          : valor do lancamento
   - TOTAL          : valor total
   - FORMARECEBIDA  : forma de recebimento (descricao)
   - FORMAPAGA      : forma de pagamento (descricao)
   - STATUS         : status do lancamento (1=Aberto, 2=Pago)
   - NOMEEMPRESA    : nome da empresa (CONFIGURACAO)
   - PARCELA        : numero da parcela
   - CCUSTO         : centro de custo
   - HISTORICO      : historico/descricao
   - CDFORNECEDOR   : codigo do fornecedor
   - FORNECEDOR     : nome do fornecedor
   - NOTAFISCAL     : numero da nota fiscal
   - ACORDO         : acordo/negociacao
   - VLPAGO         : valor pago
   - HORALOG        : hora do log
   - CDCONTA1       : codigo da conta contabil
   - CONTA1         : descricao da conta contabil
   - CDDOCUMENTO    : codigo do tipo de documento
   - DOCUMENTO      : descricao do tipo de documento
   - CONTA2         : subconta
   - CONTA3         : subsubconta
   - CONTA4         : subsubsubconta

   Filtro: STATUS IN (1, 2) e DTINCLUSAO dos ultimos 3 anos.
   ------------------------------------------------------------------ */

CREATE OR ALTER VIEW GABARITO_CTAPAGAR_GERAL (
    IDEMPRESA,
    NRPEDIDOVALE,
    NRDOC,
    DTALTER,
    DTLOG,
    DTVENC,
    DTPAGTO,
    VALOR,
    TOTAL,
    FORMARECEBIDA,
    FORMAPAGA,
    STATUS,
    NOMEEMPRESA,
    PARCELA,
    CCUSTO,
    HISTORICO,
    CDFORNECEDOR,
    FORNECEDOR,
    NOTAFISCAL,
    ACORDO,
    VLPAGO,
    HORALOG,
    CDCONTA1,
    CONTA1,
    CDDOCUMENTO,
    DOCUMENTO,
    CONTA2,
    CONTA3,
    CONTA4
) AS
SELECT
    a.IDEMPRESA,
    a.NRPEDIDOVALE,
    a.NRDOC,
    a.DTALTER,
    a.DTLOG,
    a.DTVENC,
    a.DTPAGTO,
    a.VALOR,
    a.TOTAL,
    c.RECEBTO                   AS FORMARECEBIDA,
    d.RECEBTO                   AS FORMAPAGA,
    a.STATUS,
    e.NOMEEMPRESA,
    a.PARCELA,
    a.CCUSTO,
    a.HISTORICO,
    h.CDFORNECEDOR,
    h.FORNECEDOR,
    a.NOTAFISCAL,
    a.ACORDO,
    a.VLPAGTO                   AS VLPAGO,
    a.HORALOG,
    f.CDCONTA                   AS CDCONTA1,
    f.CONTA                     AS CONTA1,
    i.CDDOCUMENTO,
    i.DOCUMENTO,
    j.SUBCONTA                  AS CONTA2,
    b.SUBSUBCONTA               AS CONTA3,
    g.SUBSUBSUBCONTA            AS CONTA4
FROM CTAPAGAR a
    LEFT JOIN RECEBTO          c ON (a.CODPAGTO        = c.CDRECEBTO)
    LEFT JOIN RECEBTO          d ON (a.TPPAGTO         = d.CDRECEBTO)
    LEFT JOIN CONFIGURACAO     e ON (a.IDEMPRESA        = e.IDEMPRESA)
    LEFT JOIN FORNECEDOR       h ON (h.CDFORNECEDOR     = a.CDFORNECEDOR)
    LEFT JOIN CONTAS           f ON (f.CDCONTA          = a.CDCONTA)
    LEFT JOIN TIPODOCUMENTO    i ON (i.CDDOCUMENTO      = a.CDDOCUMENTO)
    LEFT JOIN SUBCONTAS        j ON (j.CDSUBCONTA       = a.CDSUBCONTA)
                                AND (j.CDCONTA          = a.CDCONTA)
    LEFT JOIN SUBSUBCONTAS     b ON (b.CDSUBSUBCONTA    = a.CDSUBSUBCONTA)
                                AND (b.CDSUBCONTA       = a.CDSUBCONTA)
                                AND (b.CDCONTA          = a.CDCONTA)
    LEFT JOIN SUBSUBSUBCONTAS  g ON (g.CDSUBSUBSUBCONTA = a.CDSUBSUBSUBCONTA)
                                AND (g.CDSUBSUBCONTA    = a.CDSUBSUBCONTA)
                                AND (g.CDSUBCONTA       = a.CDSUBCONTA)
                                AND (g.CDCONTA          = a.CDCONTA)
WHERE
    a.STATUS IN (1, 2)
    AND a.DTINCLUSAO >= DATEADD(-3 YEAR TO CURRENT_DATE);


/* GABARITO_CTARCEBER_GERAL
   Contas a receber consolidadas com dados de apoio.

   Colunas:
   - IDEMPRESA      : empresa no ERP
   - NRPEDIDO       : numero do pedido
   - NRDOC          : numero do documento
   - DTSAIDA        : data de saida (saidaestoque)
   - DTMOV          : data de movimentacao
   - DTVENC         : data de vencimento
   - DTCOB          : data de cobranca
   - VALOR          : valor do lancamento
   - DIVIDA         : valor da divida
   - TOTALPG        : total pago
   - FORMARECEBIDA  : forma de recebimento (descricao)
   - FORMAPAGA      : forma de pagamento (descricao)
   - STATUS         : status do lancamento (1=Aberto, 2=Pago)
   - NOMEEMPRESA    : nome da empresa (CONFIGURACAO)
   - VENDEDOR       : nome do vendedor
   - CDCLIENTE      : codigo do cliente
   - CLIENTE        : nome do cliente
   - CDCAIXA        : codigo do caixa (campo caixa de ctareceber)
   - PARCELA        : numero da parcela
   - ORIGEM         : origem do lancamento
   - CAIXA          : descricao do caixa (TPCAIXA)

   Filtro: STATUS IN (1, 2).
   ------------------------------------------------------------------ */

CREATE OR ALTER VIEW GABARITO_CTARCEBER_GERAL (
    IDEMPRESA,
    NRPEDIDO,
    NRDOC,
    DTSAIDA,
    DTMOV,
    DTVENC,
    DTCOB,
    VALOR,
    DIVIDA,
    TOTALPG,
    FORMARECEBIDA,
    FORMAPAGA,
    STATUS,
    NOMEEMPRESA,
    VENDEDOR,
    CDCLIENTE,
    CLIENTE,
    CDCAIXA,
    PARCELA,
    ORIGEM,
    CAIXA
) AS
SELECT
    a.IDEMPRESA,
    a.NRPEDIDO,
    a.NRDOC,
    b.DTSAIDA,
    a.DTMOV,
    a.DTVENC,
    a.DTCOB,
    a.VALOR,
    a.DIVIDA,
    a.TOTALPG,
    c.RECEBTO                   AS FORMARECEBIDA,
    d.RECEBTO                   AS FORMAPAGA,
    a.STATUS,
    e.NOMEEMPRESA,
    f.VENDEDOR,
    g.CDCLIENTE,
    g.CLIENTE,
    a.CAIXA                     AS CDCAIXA,
    a.PARCELA,
    a.ORIGEM,
    h.CAIXA
FROM CTARECEBER a
    LEFT JOIN SAIDAESTOQUE     b ON (a.IDEMPRESA  = b.IDEMPRESA)
                                AND (a.NRPEDIDO   = b.NRPEDIDO)
    LEFT JOIN RECEBTO          c ON (a.CODPAGTO   = c.CDRECEBTO)
    LEFT JOIN RECEBTO          d ON (a.TPPAGTO    = d.CDRECEBTO)
    LEFT JOIN CONFIGURACAO     e ON (a.IDEMPRESA   = e.IDEMPRESA)
    LEFT JOIN VENDEDOR         f ON (b.CDVENDEDOR  = f.CDVENDEDOR)
    LEFT JOIN CLIENTE          g ON (g.CDCLIENTE   = a.CDCLIENTE)
    LEFT JOIN TPCAIXA          h ON (h.CDCAIXA     = a.CAIXA)
WHERE
    a.STATUS IN (1, 2);


/* V_CURVA_ABC
   Curva ABC de produtos vendidos com detalhes de custos, precos, descontos e promocoes.
   ------------------------------------------------------------------ */

CREATE OR ALTER VIEW GABARITO_CURVA_ABC(
    CDPRODUTO,
    PRODUTO,
    UNIDADE,
    IDEMPRESA,
    NRPEDIDO,
    IDPRECO,
    CDDEPOSITO,
    DEPOSITO,
    VLUNIT,
    VLCUSTO,
    QTDPRODUTO,
    QTDEATUAL,
    QTDEMINIMA,
    DESCPROD,
    DESCPED,
    TOTAL,
    SUBTOTAL,
    TPENTREGA,
    INATIVO,
    PROMOCAO,
    TABPROMOCAO,
    COD_CENTRAL,
    CDFABRICANTE,
    FABRICANTE,
    CDFORNECEDOR,
    CDGRUPO,
    GRUPO,
    CDTIPO,
    TIPO,
    CDLINHA,
    LINHA,
    CDFAMILIA,
    FAMILIA,
    CDCLIENTE,
    CDVENDEDOR,
    DTSAIDA,
    STATUS,
    VLCOMDESCCOMPROMO,
    VLSEMDESCCOMPROMO,
    VLCOMDESCSEMPROMO,
    VLSEMDESCSEMPROMO,
    FATORCONV,
    VLCUSTO_COMPRA,
    FRETE,
    IPI,
    ICMS)
AS
SELECT P.CDPRODUTO, P.PRODUTO, P.CDUNIDADE, SE.IDEMPRESA, SE.NRPEDIDO, SP.IDPRECO,
       SP.CDDEPOSITO, DEP.DEPOSITO, COALESCE(SP.VLUNIT,0), IIF(COALESCE(SP.VLCUSTO,0) > 0, SP.VLCUSTO, COALESCE(PP.VLCUSTO,0)),
       COALESCE(SP.QTDPRODUTO*IIF(COALESCE(SP.FATORCONV,0) > 0, SP.FATORCONV, COALESCE(PP.FATORCONV,0)) ,0), COALESCE(MV.QTDEATUAL,0), COALESCE(MV.QTDEMINIMA,0),
       SP.DESCONTO, SE.DESCONTO, SP.TOTAL, SE.SUBTOTAL, SP.STATUS, P.INATIVO, P.PROMOCAO,
       TB.TABPROMOCAO, P.COD_CENTRAL, P.CDFABRICANTE, FAB.FABRICANTE, P.CDFORNECEDOR, P.CDGRUPO, P.GRUPO,
       P.CDTIPO, P.TIPO, P.CDLINHA, P.LINHA, P.CDFAMILIA, P.FAMILIA, SE.CDCLIENTE, SE.CDVENDEDOR, SE.DTSAIDA, SE.STATUS,
       SP.VLUNIT - IIF(AUX.TOTCOMPROMOCAO <> 0, (COALESCE(SE.DESCONTO,0) * SP.VLUNIT / AUX.TOTCOMPROMOCAO), 0),
       SP.VLUNIT - COALESCE(SP.DESCONTO,0) - IIF(AUX.TOTCOMPROMOCAO <> 0, (COALESCE(SE.DESCONTO,0) * SP.VLUNIT / AUX.TOTCOMPROMOCAO), 0),
       SP.VLUNIT - IIF(AUX.TOTSEMPROMOCAO <> 0, (COALESCE(SE.DESCONTO,0) * SP.VLUNIT / AUX.TOTSEMPROMOCAO), 0),
       SP.VLUNIT - COALESCE(SP.DESCONTO,0) - IIF(AUX.TOTSEMPROMOCAO <> 0, (COALESCE(SE.DESCONTO,0) * SP.VLUNIT / AUX.TOTSEMPROMOCAO), 0),
       IIF(COALESCE(SP.FATORCONV,0) > 0, SP.FATORCONV, COALESCE(PP.FATORCONV,0)),
       COALESCE(PP.vlcustoinicial,0),
       COALESCE(P.FRETE,0), COALESCE(P.IPI,0), COALESCE(P.ICMS,0)
FROM PRODUTO P
JOIN SAIDAPRODUTO SP ON (P.CDPRODUTO = SP.CDPRODUTO) AND (SP.STATUSSE NOT IN (2,9)) AND (SP.MOSTRAR = -1)
JOIN SAIDAESTOQUE SE ON (SP.IDEMPRESA = SE.IDEMPRESA) AND (SP.NRPEDIDO = SE.NRPEDIDO) AND (SE.STATUS IN (1,3,40,43))
JOIN MOVIMENTO MV ON (SP.CDPRODUTO = MV.CDPRODUTO) AND (SP.CDDEPOSITO = MV.CDDEPOSITO)
JOIN TABELAPRECO TB ON (SP.IDPRECO = TB.IDPRECO)
LEFT JOIN PRODUTOPRECO PP ON (SP.CDPRODUTO = PP.CDPRODUTO) AND (SP.IDPRECO = PP.IDPRECO) AND (SP.UNID = PP.CDUNIDADE)
LEFT JOIN FABRICANTE FAB ON (P.CDFABRICANTE = FAB.CDFABRICANTE)
LEFT JOIN DEPOSITO DEP ON (SP.CDDEPOSITO = DEP.CDDEPOSITO)
JOIN V_CURVA_AUXILIAR AUX ON (SE.IDEMPRESA = AUX.IDEMPRESA) AND (SE.NRPEDIDO = AUX.NRPEDIDO)
;

/* GABARITO_ENTRADAS
   Itens de entrada de estoque com custo inicial (VLUNIT de ENTRPRODUTO).

   Colunas:
   - NOTAFISCAL    : numero da nota fiscal
   - DTNOTAFISCAL  : data da nota fiscal (DTNTFISCAL em ENTRESTOQUE)
   - DTENTRADA     : data de entrada
   - CDPRODUTO     : codigo do produto
   - DESCRICAO     : descricao do produto
   - QTDE          : quantidade do item
   - VLCUSTO       : valor unitario de custo (VLUNIT da ENTRPRODUTO)
   - IDEMPRESA     : empresa no ERP
   - IDENTRADA     : identificador da entrada
   - EMPRESA       : nome da empresa (CONFIGURACAO)
   - TOTAL         : total do item (QTDE * VLUNIT)
   - FORNECEDOR    : nome do fornecedor
   - CDFORNECEDOR  : codigo do fornecedor

   Filtro: B.STATUS = 1 (entradas confirmadas).
   ------------------------------------------------------------------ */

CREATE OR ALTER VIEW GABARITO_ENTRADAS (
    NOTAFISCAL,
    DTNOTAFISCAL,
    DTENTRADA,
    CDPRODUTO,
    DESCRICAO,
    QTDE,
    VLCUSTO,
    IDEMPRESA,
    IDENTRADA,
    EMPRESA,
    TOTAL,
    FORNECEDOR,
    CDFORNECEDOR
) AS
SELECT
    B.NOTAFISCAL,
    B.DTNTFISCAL                     AS DTNOTAFISCAL,
    B.DTENTRADA,
    A.CDPRODUTO,
    A.DESCRICAO,
    A.QTDE,
    A.VLUNIT                         AS VLCUSTO,
    B.IDEMPRESA,
    B.IDENTRADA,
    C.NOMEEMPRESA                    AS EMPRESA,
    (A.QTDE * A.VLUNIT)              AS TOTAL,
    D.FORNECEDOR,
    A.CDFORNECEDOR
FROM ENTRPRODUTO A
    JOIN ENTRESTOQUE  B ON (A.IDENTRADA    = B.IDENTRADA)
                       AND (A.IDEMPRESA    = B.IDEMPRESA)
    JOIN CONFIGURACAO C ON (B.IDEMPRESA    = C.IDEMPRESA)
    JOIN FORNECEDOR   D ON (A.CDFORNECEDOR = D.CDFORNECEDOR)
WHERE B.STATUS = 1;


/* Confirmacao */
SELECT 'Views criadas: GABARITO_EMPRESAS, GABARITO_FATURAMENTO_MENSAL, GABARITO_CTAPAGAR_GERAL, GABARITO_CTARCEBER_GERAL, GABARITO_CURVA_ABC, GABARITO_ENTRADAS' AS RESULTADO
FROM RDB$DATABASE;
