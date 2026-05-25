/* =============================================================
   GABARITO - Tabelas do Servidor (PostgreSQL)
   Arquivo : sql/criar_tabelas_servidor.sql
   
   Tabelas para armazenar os dados vindos do motor via POST /sync.
   Espelham as views GABARITO_CTAPAGAR_GERAL e GABARITO_CTARCEBER_GERAL.
   ============================================================= */


-- ─────────────────────────────────────────────────────────────────
-- GABARITO_CTAPAGAR_GERAL
-- Contas a pagar consolidadas
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS relat_ctapagar_geral (
    id              BIGSERIAL       PRIMARY KEY,
    cnpj            VARCHAR(20)     NOT NULL,
    id_empresa      INTEGER         NOT NULL,
    nr_pedido_vale  INTEGER,
    nr_doc          VARCHAR(50),
    dt_alter        TIMESTAMP,
    dt_log          TIMESTAMP,
    dt_venc         DATE,
    dt_pagto        DATE,
    valor           NUMERIC(15,2)   DEFAULT 0,
    total           NUMERIC(15,2)   DEFAULT 0,
    forma_recebida  VARCHAR(100),
    forma_paga      VARCHAR(100),
    status          SMALLINT        DEFAULT 1,
    nome_empresa    VARCHAR(200),
    parcela         INTEGER,
    c_custo         VARCHAR(100),
    historico       VARCHAR(500),
    cd_fornecedor   INTEGER,
    fornecedor      VARCHAR(200),
    nota_fiscal     VARCHAR(50),
    acordo          VARCHAR(100),
    vl_pago         NUMERIC(15,2)   DEFAULT 0,
    hora_log        VARCHAR(20),
    cd_conta1       INTEGER,
    conta1          VARCHAR(200),
    cd_documento    INTEGER,
    documento       VARCHAR(200),
    conta2          VARCHAR(200),
    conta3          VARCHAR(200),
    conta4          VARCHAR(200),
    data_referencia DATE,
    created_at      TIMESTAMP       DEFAULT NOW(),
    updated_at      TIMESTAMP       DEFAULT NOW()
);

-- Indices para consultas frequentes
CREATE INDEX IF NOT EXISTS idx_ctapagar_cnpj        ON relat_ctapagar_geral (cnpj);
CREATE INDEX IF NOT EXISTS idx_ctapagar_id_empresa   ON relat_ctapagar_geral (id_empresa);
CREATE INDEX IF NOT EXISTS idx_ctapagar_dt_venc      ON relat_ctapagar_geral (dt_venc);
CREATE INDEX IF NOT EXISTS idx_ctapagar_status       ON relat_ctapagar_geral (status);
CREATE INDEX IF NOT EXISTS idx_ctapagar_fornecedor   ON relat_ctapagar_geral (cd_fornecedor);


-- ─────────────────────────────────────────────────────────────────
-- GABARITO_CTARCEBER_GERAL
-- Contas a receber consolidadas
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS relat_ctarceber_geral (
    id              BIGSERIAL       PRIMARY KEY,
    cnpj            VARCHAR(20)     NOT NULL,
    id_empresa      INTEGER         NOT NULL,
    nr_pedido       INTEGER,
    nr_doc          VARCHAR(50),
    dt_saida        DATE,
    dt_mov          TIMESTAMP,
    dt_venc         DATE,
    dt_cob          DATE,
    valor           NUMERIC(15,2)   DEFAULT 0,
    divida          NUMERIC(15,2)   DEFAULT 0,
    total_pg        NUMERIC(15,2)   DEFAULT 0,
    forma_recebida  VARCHAR(100),
    forma_paga      VARCHAR(100),
    status          SMALLINT        DEFAULT 1,
    nome_empresa    VARCHAR(200),
    vendedor        VARCHAR(200),
    cd_cliente      INTEGER,
    cliente         VARCHAR(200),
    cd_caixa        INTEGER,
    parcela         INTEGER,
    origem          VARCHAR(100),
    caixa           VARCHAR(200),
    data_referencia DATE,
    created_at      TIMESTAMP       DEFAULT NOW(),
    updated_at      TIMESTAMP       DEFAULT NOW()
);

-- Indices para consultas frequentes
CREATE INDEX IF NOT EXISTS idx_ctarceber_cnpj        ON relat_ctarceber_geral (cnpj);
CREATE INDEX IF NOT EXISTS idx_ctarceber_id_empresa   ON relat_ctarceber_geral (id_empresa);
CREATE INDEX IF NOT EXISTS idx_ctarceber_dt_venc      ON relat_ctarceber_geral (dt_venc);
CREATE INDEX IF NOT EXISTS idx_ctarceber_status       ON relat_ctarceber_geral (status);
CREATE INDEX IF NOT EXISTS idx_ctarceber_cliente      ON relat_ctarceber_geral (cd_cliente);
CREATE INDEX IF NOT EXISTS idx_ctarceber_vendedor     ON relat_ctarceber_geral (vendedor);
