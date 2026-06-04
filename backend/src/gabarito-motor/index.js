// gabarito-motor/index.js
// Orquestrador principal do motor Gabarito.
//
// Fluxo executado a cada ciclo:
//   1. Busca CNPJs ativos via GET /companies
//   2. Cruza com Firebird -> obtem IDEMPRESA de cada CNPJ
//   3. Extrai dados do ERP (faturamento, contas, curva ABC, entradas)
//      - Primeira execução por CNPJ: janela de 3 anos (carga inicial)
//      - Execuções seguintes: janela de 2 meses (início do mês retrasado)
//        para capturar novos registros e retroativos recentes
//   4. Envia via POST /sync se houver mudança (hash-based dedup)
//
// Cron: minuto 0 de cada hora, das 08h as 22h.
// Roda imediatamente se GABARITO_RUN_ON_START=true.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const cron = require('node-cron');
const { logInfo, logWarn, logError } = require('../logger');
const { buscarCnpjsAtivos, enviarSync } = require('./sender');
const { mapearCnpjsParaIdEmpresa, extrairFaturamentoMensal, extrairContasPagar, extrairContasReceber, extrairCurvaAbc, extrairEntradas } = require('./extractor');
const { checkStateChanged, getLastSyncedAt, updateState } = require('./syncState');

let isMotorRunning = false;

async function runMotor() {
  if (isMotorRunning) {
    logWarn('[Gabarito] Ciclo anterior ainda em andamento. Ignorando este disparo.');
    return;
  }
  isMotorRunning = true;

  const inicio = Date.now();
  const dataReferencia = hojeFormatado();
  const anoCorrente    = new Date().getFullYear();

  logInfo(`[Gabarito] Iniciando ciclo — data: ${dataReferencia}, ano: ${anoCorrente}`);

  let processados = 0;
  let ignorados   = 0;
  let semDados    = 0;

  try {
    const cnpjsAtivos = await buscarCnpjsAtivos();

    if (!cnpjsAtivos.length) {
      logWarn('[Gabarito] Nenhum CNPJ ativo retornado pela API. Ciclo encerrado.');
      agendarProximoCiclo();
      return;
    }

    const mapaCnpjId = await mapearCnpjsParaIdEmpresa(cnpjsAtivos);
    ignorados = cnpjsAtivos.length - Object.keys(mapaCnpjId).length;

    for (const [cnpj, idEmpresa] of Object.entries(mapaCnpjId)) {
      // Determina a janela de extração para Curva ABC e Entradas
      const lastSyncedAt     = getLastSyncedAt(cnpj);
      const isIncrementalSync = lastSyncedAt !== null;
      const desde            = computarDesde(lastSyncedAt);
      const modoSync         = isIncrementalSync ? 'incremental' : 'full';

      logInfo(`[Gabarito] Processando CNPJ ${cnpj} (IDEMPRESA=${idEmpresa}) — modo: ${modoSync}, desde: ${desde}`);

      logInfo(`[Gabarito] [${cnpj}] Extraindo faturamento mensal...`);
      const faturamentoMensal  = await extrairFaturamentoMensal(idEmpresa, anoCorrente);
      logInfo(`[Gabarito] [${cnpj}] Extraindo contas a pagar...`);
      const contasPagarTotal   = await extrairContasPagar(idEmpresa);
      logInfo(`[Gabarito] [${cnpj}] Extraindo contas a receber...`);
      const contasReceberTotal = await extrairContasReceber(idEmpresa);
      logInfo(`[Gabarito] [${cnpj}] Extraindo curva ABC (desde ${desde})...`);
      const curvaAbcTotal      = await extrairCurvaAbc(idEmpresa, desde);
      logInfo(`[Gabarito] [${cnpj}] Extraindo entradas de estoque (desde ${desde})...`);
      const entradasTotal      = await extrairEntradas(idEmpresa, desde);
      logInfo(`[Gabarito] [${cnpj}] Extração concluída: fat=${faturamentoMensal.length}, pagar=${contasPagarTotal.length}, receber=${contasReceberTotal.length}, curvaAbc=${curvaAbcTotal.length}, entradas=${entradasTotal.length}`);

      const temDados = faturamentoMensal.length > 0 || contasPagarTotal.length > 0
        || contasReceberTotal.length > 0 || curvaAbcTotal.length > 0 || entradasTotal.length > 0;

      if (!temDados) {
        logWarn(`[Gabarito] CNPJ ${cnpj} (IDEMPRESA=${idEmpresa}) sem dados em ${anoCorrente}.`);
        semDados++;
        await enviarSync({
          dataReferencia,
          sourceVersion: process.env.GABARITO_VERSION || '1.0.0',
          syncMode: modoSync,
          registros: [{ cnpj, faturamentoMensal: [], contasPagar: [], contasReceber: [], curvaAbc: [], entradas: [] }]
        });
        processados++;
        continue;
      }

      const dadosCompletos = { faturamentoMensal, contasPagar: contasPagarTotal, contasReceber: contasReceberTotal, curvaAbc: curvaAbcTotal, entradas: entradasTotal };
      const { changed, hash } = checkStateChanged(cnpj, dadosCompletos);

      if (!changed) {
        logInfo(`[Gabarito] CNPJ ${cnpj}: Dados inalterados. Pulando envio (hash: ${hash}).`);
        processados++;
        continue;
      }

      logInfo(`[Gabarito] CNPJ ${cnpj}: faturamento=${faturamentoMensal.length}, ctaPagar=${contasPagarTotal.length}, ctaReceber=${contasReceberTotal.length}, curvaAbc=${curvaAbcTotal.length}, entradas=${entradasTotal.length}`);

      const CHUNK_SIZE = 5000;
      const maxChunks = Math.max(
        1,
        Math.ceil(contasPagarTotal.length   / CHUNK_SIZE),
        Math.ceil(contasReceberTotal.length / CHUNK_SIZE),
        Math.ceil(curvaAbcTotal.length      / CHUNK_SIZE),
        Math.ceil(entradasTotal.length      / CHUNK_SIZE)
      );

      let todosSucesso = true;

      for (let i = 0; i < maxChunks; i++) {
        const cpChunk = contasPagarTotal.slice(i * CHUNK_SIZE,   (i + 1) * CHUNK_SIZE);
        const crChunk = contasReceberTotal.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        const caChunk = curvaAbcTotal.slice(i * CHUNK_SIZE,      (i + 1) * CHUNK_SIZE);
        const enChunk = entradasTotal.slice(i * CHUNK_SIZE,      (i + 1) * CHUNK_SIZE);
        const fmChunk = (i === 0) ? faturamentoMensal : [];

        const registro = { cnpj };
        if (fmChunk.length > 0)  registro.faturamentoMensal = fmChunk;
        if (cpChunk.length > 0)  registro.contasPagar       = cpChunk;
        if (crChunk.length > 0)  registro.contasReceber     = crChunk;
        if (caChunk.length > 0)  registro.curvaAbc          = caChunk;
        if (enChunk.length > 0)  registro.entradas          = enChunk;

        const payload = {
          dataReferencia,
          sourceVersion: process.env.GABARITO_VERSION || '1.0.0',
          syncMode: modoSync,
          desde: isIncrementalSync ? desde : undefined,
          chunkInfo: { atual: i + 1, total: maxChunks },
          registros: [registro]
        };

        if (maxChunks > 1) {
          logInfo(`[Gabarito] Enviando lote ${i + 1}/${maxChunks} do CNPJ ${cnpj}...`);
        }

        const ok = await enviarSync(payload);
        if (!ok) todosSucesso = false;
      }

      if (todosSucesso) {
        updateState(cnpj, hash);
        logInfo(`[Gabarito] CNPJ ${cnpj}: hash salvo — próximo ciclo detectará apenas mudanças.`);
      } else {
        logWarn(`[Gabarito] CNPJ ${cnpj}: um ou mais lotes falharam — hash NÃO salvo. Próximo ciclo reenviará tudo.`);
      }

      processados++;
    }

  } catch (err) {
    logError('[Gabarito] Erro inesperado no ciclo do motor:', err);
  } finally {
    isMotorRunning = false;
  }

  const duracao = Date.now() - inicio;
  logInfo(`[Gabarito] Sync concluido: processados=${processados}, semDados=${semDados}, ignorados=${ignorados}, duracao=${duracao}ms`);

  agendarProximoCiclo();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Calcula a data de início da janela de extração.
 * - Sem sync anterior (null): 3 anos atrás (carga inicial completa)
 * - Com sync anterior: 1º dia do mês retrasado (captura retroativos recentes)
 */
function computarDesde(lastSyncedAt) {
  if (!lastSyncedAt) {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 3);
    d.setHours(0, 0, 0, 0);
    return d.toISOString().slice(0, 10);
  }
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 2);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function hojeFormatado() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function agendarProximoCiclo() {
  logInfo('[Gabarito] Proximo ciclo em 60 minutos (se dentro da janela 08h-22h).');
}

// ── Cron ──────────────────────────────────────────────────────────────────────

const CRON_EXPR = process.env.GABARITO_CRON_MODE === 'test'
  ? '* * * * *'
  : '0 8-22 * * *';

cron.schedule(CRON_EXPR, () => {
  logInfo(`[Gabarito] Cron disparado (${CRON_EXPR}).`);
  runMotor();
});

logInfo(`[Gabarito] Motor registrado — cron: ${CRON_EXPR} (modo: ${process.env.GABARITO_CRON_MODE === 'test' ? 'TESTE - todo minuto' : 'PRODUCAO - 08h-22h a cada hora'}).`);

if (process.env.GABARITO_RUN_ON_START === 'true') {
  logInfo('[Gabarito] GABARITO_RUN_ON_START=true — executando agora...');
  runMotor();
}
