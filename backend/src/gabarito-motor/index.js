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
const { mapearCnpjsParaIdEmpresa, extrairFaturamentoMensal, extrairContasPagar, extrairContasReceber, extrairCurvaAbc, extrairCurvaAbcStreaming, extrairEntradas, extrairVendedores } = require('./extractor');
const { checkStateChanged, getLastSyncedAt, updateState } = require('./syncState');

const CHUNK_SIZE = 5000;

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
      const lastSyncedAt      = getLastSyncedAt(cnpj);
      const isIncrementalSync = lastSyncedAt !== null;
      const desde             = computarDesde(lastSyncedAt);
      const modoSync          = isIncrementalSync ? 'incremental' : 'full';

      logInfo(`[Gabarito] Processando CNPJ ${cnpj} (IDEMPRESA=${idEmpresa}) — modo: ${modoSync}, desde: ${desde}`);

      // ── FULL SYNC: streaming por ano (memória limitada) ──────────────────────
      if (!isIncrementalSync) {
        const r = await runFullSync(cnpj, idEmpresa, desde, dataReferencia, anoCorrente);
        if (r.todosSucesso && r.completo) {
          // Hash sentinela: marca lastSyncedAt para os próximos ciclos serem
          // incrementais. O 1º incremental sempre reenviará (hash de 2 meses
          // difere do sentinela) e gravará o hash incremental real.
          updateState(cnpj, `full-${hojeFormatado()}`);
          logInfo(`[Gabarito] CNPJ ${cnpj}: full sync concluído — hash salvo.`);
          processados++;
        } else {
          const motivo = !r.todosSucesso ? 'falha no envio de lotes' : 'erro na extração da Curva ABC (algum ano falhou)';
          logWarn(`[Gabarito] CNPJ ${cnpj}: hash NÃO salvo (${motivo}). Próximo ciclo reenviará tudo.`);
        }
        continue;
      }

      // ── INCREMENTAL: janela de 2 meses (cabe em memória) ─────────────────────
      logInfo(`[Gabarito] [${cnpj}] Extraindo faturamento mensal...`);
      const faturamentoMensal  = await extrairFaturamentoMensal(idEmpresa, anoCorrente);
      logInfo(`[Gabarito] [${cnpj}] Extraindo contas a pagar...`);
      const contasPagarTotal   = await extrairContasPagar(idEmpresa);
      logInfo(`[Gabarito] [${cnpj}] Extraindo contas a receber...`);
      const contasReceberTotal = await extrairContasReceber(idEmpresa);
      logInfo(`[Gabarito] [${cnpj}] Extraindo curva ABC (desde ${desde})...`);
      const { rows: curvaAbcTotal, completo: curvaAbcCompleta } = await extrairCurvaAbc(idEmpresa, desde);
      logInfo(`[Gabarito] [${cnpj}] Extraindo entradas de estoque (desde ${desde})...`);
      const entradasTotal      = await extrairEntradas(idEmpresa, desde);
      logInfo(`[Gabarito] [${cnpj}] Extraindo desempenho de vendedores (desde ${desde})...`);
      const vendedoresTotal    = await extrairVendedores(idEmpresa, desde);
      logInfo(`[Gabarito] [${cnpj}] Extração concluída: fat=${faturamentoMensal.length}, pagar=${contasPagarTotal.length}, receber=${contasReceberTotal.length}, curvaAbc=${curvaAbcTotal.length}, entradas=${entradasTotal.length}, vendedores=${vendedoresTotal.length}`);

      const temDados = faturamentoMensal.length > 0 || contasPagarTotal.length > 0
        || contasReceberTotal.length > 0 || curvaAbcTotal.length > 0 || entradasTotal.length > 0
        || vendedoresTotal.length > 0;

      if (!temDados) {
        logWarn(`[Gabarito] CNPJ ${cnpj} (IDEMPRESA=${idEmpresa}) sem dados em ${anoCorrente}.`);
        semDados++;
        await enviarSync({
          dataReferencia,
          sourceVersion: process.env.GABARITO_VERSION || '1.0.0',
          syncMode: modoSync,
          desde,
          registros: [{ cnpj, faturamentoMensal: [], contasPagar: [], contasReceber: [], curvaAbc: [], entradas: [], vendedores: [] }]
        });
        processados++;
        continue;
      }

      const dadosCompletos = { faturamentoMensal, contasPagar: contasPagarTotal, contasReceber: contasReceberTotal, curvaAbc: curvaAbcTotal, entradas: entradasTotal, vendedores: vendedoresTotal };
      const { changed, hash } = checkStateChanged(cnpj, dadosCompletos);

      if (!changed) {
        logInfo(`[Gabarito] CNPJ ${cnpj}: Dados inalterados. Pulando envio (hash: ${hash}).`);
        processados++;
        continue;
      }

      logInfo(`[Gabarito] CNPJ ${cnpj}: faturamento=${faturamentoMensal.length}, ctaPagar=${contasPagarTotal.length}, ctaReceber=${contasReceberTotal.length}, curvaAbc=${curvaAbcTotal.length}, entradas=${entradasTotal.length}, vendedores=${vendedoresTotal.length}`);

      const maxChunks = Math.max(
        1,
        Math.ceil(contasPagarTotal.length   / CHUNK_SIZE),
        Math.ceil(contasReceberTotal.length / CHUNK_SIZE),
        Math.ceil(curvaAbcTotal.length      / CHUNK_SIZE),
        Math.ceil(entradasTotal.length      / CHUNK_SIZE),
        Math.ceil(vendedoresTotal.length    / CHUNK_SIZE)
      );

      let todosSucesso = true;

      for (let i = 0; i < maxChunks; i++) {
        const cpChunk = contasPagarTotal.slice(i * CHUNK_SIZE,   (i + 1) * CHUNK_SIZE);
        const crChunk = contasReceberTotal.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        const caChunk = curvaAbcTotal.slice(i * CHUNK_SIZE,      (i + 1) * CHUNK_SIZE);
        const enChunk = entradasTotal.slice(i * CHUNK_SIZE,      (i + 1) * CHUNK_SIZE);
        const veChunk = vendedoresTotal.slice(i * CHUNK_SIZE,    (i + 1) * CHUNK_SIZE);
        const fmChunk = (i === 0) ? faturamentoMensal : [];

        const registro = { cnpj };
        if (fmChunk.length > 0)  registro.faturamentoMensal = fmChunk;
        if (cpChunk.length > 0)  registro.contasPagar       = cpChunk;
        if (crChunk.length > 0)  registro.contasReceber     = crChunk;
        if (caChunk.length > 0)  registro.curvaAbc          = caChunk;
        if (enChunk.length > 0)  registro.entradas          = enChunk;
        if (veChunk.length > 0)  registro.vendedores        = veChunk;

        const payload = {
          dataReferencia,
          sourceVersion: process.env.GABARITO_VERSION || '1.0.0',
          syncMode: modoSync,
          desde,
          chunkInfo: { atual: i + 1, total: maxChunks },
          registros: [registro]
        };

        if (maxChunks > 1) {
          logInfo(`[Gabarito] Enviando lote ${i + 1}/${maxChunks} do CNPJ ${cnpj}...`);
        }

        const ok = await enviarSync(payload);
        if (!ok) todosSucesso = false;
      }

      if (todosSucesso && curvaAbcCompleta) {
        updateState(cnpj, hash);
        logInfo(`[Gabarito] CNPJ ${cnpj}: hash salvo — próximo ciclo detectará apenas mudanças.`);
      } else {
        const motivo = !todosSucesso ? 'falha no envio de lotes' : 'erro na extração da Curva ABC (algum ano falhou)';
        logWarn(`[Gabarito] CNPJ ${cnpj}: hash NÃO salvo (${motivo}). Próximo ciclo reenviará tudo.`);
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

// ── Full Sync (streaming) ──────────────────────────────────────────────────────

/**
 * Carga inicial de um CNPJ sem estourar memória.
 *
 * Estratégia (usa apenas contratos já comprovados em produção):
 *   1. Dados base (faturamento, contas a pagar/receber, entradas) — volume
 *      limitado — enviados como uma operação `full` em lotes.
 *   2. Curva ABC enviada ano a ano: cada ano é uma operação `incremental`
 *      com `desde` = início daquele ano. Como os anos vão em ordem crescente
 *      e não se sobrepõem, cada ano apaga apenas o seu período e preserva os
 *      anteriores. O primeiro ano remove qualquer dado parcial antigo.
 *      Apenas um ano fica em memória por vez.
 *
 * @returns {Promise<{todosSucesso: boolean, completo: boolean}>}
 */
async function runFullSync(cnpj, idEmpresa, desde, dataReferencia, anoCorrente) {
  const sourceVersion = process.env.GABARITO_VERSION || '1.0.0';
  let todosSucesso = true;
  let completo     = true;

  // 1) Dados base (cabem em memória)
  logInfo(`[Gabarito] [${cnpj}] (full) Extraindo dados base...`);
  const faturamentoMensal  = await extrairFaturamentoMensal(idEmpresa, anoCorrente);
  let   contasPagarTotal   = await extrairContasPagar(idEmpresa);
  let   contasReceberTotal = await extrairContasReceber(idEmpresa);
  let   entradasTotal      = await extrairEntradas(idEmpresa, desde);
  let   vendedoresTotal    = await extrairVendedores(idEmpresa, desde);

  const baseChunks = Math.max(
    1,
    Math.ceil(contasPagarTotal.length   / CHUNK_SIZE),
    Math.ceil(contasReceberTotal.length / CHUNK_SIZE),
    Math.ceil(entradasTotal.length      / CHUNK_SIZE),
    Math.ceil(vendedoresTotal.length    / CHUNK_SIZE)
  );

  logInfo(`[Gabarito] [${cnpj}] (full) base: fat=${faturamentoMensal.length}, pagar=${contasPagarTotal.length}, receber=${contasReceberTotal.length}, entradas=${entradasTotal.length}, vendedores=${vendedoresTotal.length} (${baseChunks} lote(s))`);

  for (let i = 0; i < baseChunks; i++) {
    const cpChunk = contasPagarTotal.slice(i * CHUNK_SIZE,   (i + 1) * CHUNK_SIZE);
    const crChunk = contasReceberTotal.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    const enChunk = entradasTotal.slice(i * CHUNK_SIZE,      (i + 1) * CHUNK_SIZE);
    const veChunk = vendedoresTotal.slice(i * CHUNK_SIZE,    (i + 1) * CHUNK_SIZE);
    const fmChunk = (i === 0) ? faturamentoMensal : [];

    const registro = { cnpj };
    if (fmChunk.length > 0) registro.faturamentoMensal = fmChunk;
    if (cpChunk.length > 0) registro.contasPagar       = cpChunk;
    if (crChunk.length > 0) registro.contasReceber     = crChunk;
    if (enChunk.length > 0) registro.entradas          = enChunk;
    if (veChunk.length > 0) registro.vendedores        = veChunk;

    logInfo(`[Gabarito] [${cnpj}] (full) Enviando base ${i + 1}/${baseChunks}...`);
    const ok = await enviarSync({
      dataReferencia,
      sourceVersion,
      syncMode: 'full',
      chunkInfo: { atual: i + 1, total: baseChunks },
      registros: [registro]
    });
    if (!ok) todosSucesso = false;
  }

  // Libera os arrays base antes do streaming da curva (reduz pico de memória)
  contasPagarTotal = contasReceberTotal = entradasTotal = vendedoresTotal = null;

  // 2) Curva ABC em streaming, um ano por vez
  await extrairCurvaAbcStreaming(idEmpresa, desde, async ({ ano, anoDesde, rows, completo: anoCompleto }) => {
    if (!anoCompleto) completo = false;

    const yearChunks = Math.max(1, Math.ceil(rows.length / CHUNK_SIZE));
    for (let i = 0; i < yearChunks; i++) {
      const caChunk = rows.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      if (caChunk.length === 0) continue;

      logInfo(`[Gabarito] [${cnpj}] (full) Enviando curva ${ano} lote ${i + 1}/${yearChunks}...`);
      const ok = await enviarSync({
        dataReferencia,
        sourceVersion,
        syncMode: 'incremental',
        desde: anoDesde,
        chunkInfo: { atual: i + 1, total: yearChunks },
        registros: [{ cnpj, curvaAbc: caChunk }]
      });
      if (!ok) todosSucesso = false;
    }
  });

  return { todosSucesso, completo };
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
