// gabarito-motor/index.js
// Orquestrador principal do motor Gabarito.
//
// Fluxo executado a cada ciclo:
//   1. Busca CNPJs ativos via GET /companies
//   2. Cruza com Firebird -> obtem IDEMPRESA de cada CNPJ
//   3. Extrai dados do ERP (faturamento, contas, curva ABC, entradas)
//      - Primeira execução por CNPJ: janela de 3 anos (carga inicial)
//      - Execuções seguintes: janela de 3 meses (início de 3 meses atrás)
//        para capturar novos registros e retroativos recentes
//   4. Envia via POST /sync se houver mudança (hash-based dedup)
//
// Cron: minuto 0 de cada hora, das 08h as 22h.
// Roda imediatamente se GABARITO_RUN_ON_START=true.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const cron = require('node-cron');
const crypto = require('crypto');
const { logInfo, logWarn, logError } = require('../logger');
const { buscarCnpjsAtivos, enviarSync } = require('./sender');
const { mapearCnpjsParaIdEmpresa, extrairFaturamentoMensal, extrairContasPagar, extrairContasReceber, extrairCurvaAbc, extrairCurvaAbcStreaming, extrairEntradas, extrairVendedores, extrairPedidosPorHorario } = require('./extractor');
const { checkStateChanged, getLastSyncedAt, updateState, getFullSyncedResources, markResourcesFullSynced, WINDOWED_RESOURCES } = require('./syncState');
const { runDatabaseMigrations } = require('./migrations');

const CHUNK_SIZE = 5000;

// Fase 1 (entrega íntegra): cada recurso STAGINGÁVEL leva `expectedTotal`+
// `snapshotId` no payload; o Motor faz fail-fast + valida a contagem `persisted`
// devolvida pela API (staging + swap verificado).
// DEFAULT ON: o Motor sempre manda as etiquetas; quem governa a ativação real é
// a allowlist da API (STAGING_SWAP_CNPJS) — CNPJ fora da lista → a API ignora e
// roda o legado (NoOp, sem 400). Escape hatch: GABARITO_EXPECTED_TOTAL=false
// desliga o envio num cliente específico. Ver docs/spec-entrega-integra-fluxo-caixa.md
const SEND_EXPECTED_TOTAL = process.env.GABARITO_EXPECTED_TOTAL !== 'false';

// Recursos que a API materializa via staging+swap (têm tabela em sync_staging.*).
// faturamentoMensal fica DE FORA — a API não faz staging dele e rejeitaria o
// payload com 400 multi_resource_payload; ele segue sempre pelo caminho legado.
const RECURSOS_STAGING = new Set([
  'contasPagar', 'contasReceber', 'curvaAbc', 'entradas', 'vendedores', 'pedidosHorario'
]);

let isMotorRunning = false;

/**
 * Envia UM recurso (ex.: contasPagar) como seu próprio stream de lotes, com
 * chunkInfo honesto: { atual, total } onde `total` é o nº de lotes DESSE recurso.
 *
 * Cada recurso vai num POST isolado (só o seu campo no registro). A guarda
 * `chunkInfo.atual === 1` da API apaga o snapshot apenas daquela tabela e os
 * lotes seguintes fazem append — então todo recurso fecha em `atual === total`,
 * independente de qual tabela é a maior do CNPJ.
 *
 * Isso substitui o antigo chunkInfo global (derivado do max entre as tabelas),
 * que era desonesto para qualquer tabela menor que a maior: o stream dela
 * terminava em ex. 8/79 e nunca sinalizava conclusão, truncando o snapshot.
 *
 * Recursos vazios são pulados (mantém o comportamento anterior, que omitia o
 * campo quando não havia linhas).
 *
 * Fase 1 (SEND_EXPECTED_TOTAL=true): gera um `snapshotId` (uuid v4) único por
 * entrega de (cnpj, recurso) e o repete em todos os lotes; inclui `expectedTotal`
 * (congelado no início — não muda no meio do stream); envia em ordem estrita
 * (lote N+1 só após 200 em N); faz fail-fast ao primeiro lote que falhar; e, no
 * último lote, valida a contagem `persisted` devolvida pela API. Cada POST carrega
 * exatamente UM recurso × UM cnpj (constraint do contrato de staging). Com a flag
 * off, comportamento legado intacto.
 *
 * @param {string}  cnpj
 * @param {object}  baseMeta  metadados comuns (dataReferencia, sourceVersion, syncMode, desde?)
 * @param {string}  nomeCampo nome do campo no registro (ex.: 'contasPagar')
 * @param {Array}   registros array completo do recurso
 * @param {Function} sendFn   injeção do enviador (default: enviarSync) — facilita teste
 * @returns {Promise<boolean>} true se todos os lotes do recurso enviaram OK
 */
async function enviarRecurso(cnpj, baseMeta, nomeCampo, registros, sendFn = enviarSync) {
  const lista = registros || [];
  if (lista.length === 0) return true;

  const usaStaging = SEND_EXPECTED_TOTAL && RECURSOS_STAGING.has(nomeCampo);
  const expectedTotal = lista.length;            // congelado para toda a entrega
  const total = Math.ceil(expectedTotal / CHUNK_SIZE);
  const snapshotId = usaStaging ? crypto.randomUUID() : null;
  let ok = true;

  for (let i = 0; i < total; i++) {
    const chunk = lista.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);

    if (total > 1) {
      logInfo(`[Gabarito] [${cnpj}] Enviando ${nomeCampo} lote ${i + 1}/${total}...`);
    }

    const payload = {
      ...baseMeta,
      chunkInfo: { atual: i + 1, total },
      registros: [{ cnpj, [nomeCampo]: chunk }]
    };
    if (usaStaging) {
      payload.expectedTotal = expectedTotal;
      payload.snapshotId    = snapshotId;
    }

    const resp = await sendFn(payload);

    if (!resp.ok) {
      ok = false;
      if (usaStaging) {
        // Fail-fast: não adianta empurrar mais lotes para um stream que não vai
        // dar swap. Aborta o recurso; o hash não será salvo e tudo é reenviado
        // (com um snapshotId novo no próximo ciclo, resetando o staging na API).
        logWarn(`[Gabarito] [${cnpj}] ${nomeCampo}: lote ${i + 1}/${total} falhou — abortando recurso (snapshot ${snapshotId}).`);
        return false;
      }
      continue; // legado: segue tentando os demais lotes
    }

    // Verificação de integridade fim-a-fim: no último lote a API devolve quanto
    // gravou de fato após o swap. Divergência = recurso truncou → não salva hash.
    if (usaStaging && i + 1 === total) {
      const p = resp.persisted?.[nomeCampo];
      if (p?.total != null && p.total !== expectedTotal) {
        logError(`[Gabarito] [${cnpj}] ${nomeCampo}: API gravou ${p.total}, esperado ${expectedTotal} — recurso truncado (snapshot ${snapshotId}).`);
        return false;
      }
      if (p) {
        const delta = (p.previousTotal != null) ? ` (antes: ${p.previousTotal})` : '';
        logInfo(`[Gabarito] [${cnpj}] ${nomeCampo}: ${p.total} linhas confirmadas pela API${delta}.`);
      }
    }
  }

  return ok;
}

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
          // O full sync carregou os 3 anos de todos os recursos com janela —
          // carimba o watermark para o incremental não os recarregar.
          markResourcesFullSynced(cnpj, WINDOWED_RESOURCES);
          logInfo(`[Gabarito] CNPJ ${cnpj}: full sync concluído — hash salvo.`);
          processados++;
        } else {
          const motivo = !r.todosSucesso ? 'falha no envio de lotes' : 'erro na extração da Curva ABC (algum ano falhou)';
          logWarn(`[Gabarito] CNPJ ${cnpj}: hash NÃO salvo (${motivo}). Próximo ciclo reenviará tudo.`);
        }
        continue;
      }

      // ── INCREMENTAL: janela de 3 meses (cabe em memória) ─────────────────────
      // Watermark por recurso: recurso com janela ainda sem carga histórica é
      // extraído com a janela completa (3 anos) UMA vez; depois cai no incremental
      // de 3 meses. Torna a adição de relatórios novos auto-corretiva.
      const backfilled     = new Set(getFullSyncedResources(cnpj));
      const pendentes      = WINDOWED_RESOURCES.filter(r => !backfilled.has(r));
      const desdeHistorico = computarDesde(null); // 3 anos — carga histórica única
      const desdeDe = (recurso) =>
        (WINDOWED_RESOURCES.includes(recurso) && !backfilled.has(recurso)) ? desdeHistorico : desde;
      if (pendentes.length) {
        logInfo(`[Gabarito] [${cnpj}] Recursos sem histórico → carga única (desde ${desdeHistorico}): ${pendentes.join(', ')}`);
      }

      logInfo(`[Gabarito] [${cnpj}] Extraindo faturamento mensal...`);
      const faturamentoMensal  = await extrairFaturamentoMensal(idEmpresa, anoCorrente);
      logInfo(`[Gabarito] [${cnpj}] Extraindo contas a pagar...`);
      const contasPagarTotal   = await extrairContasPagar(idEmpresa);
      logInfo(`[Gabarito] [${cnpj}] Extraindo contas a receber...`);
      const contasReceberTotal = await extrairContasReceber(idEmpresa);
      logInfo(`[Gabarito] [${cnpj}] Extraindo curva ABC (desde ${desdeDe('curvaAbc')})...`);
      const { rows: curvaAbcTotal, completo: curvaAbcCompleta } = await extrairCurvaAbc(idEmpresa, desdeDe('curvaAbc'));
      logInfo(`[Gabarito] [${cnpj}] Extraindo entradas de estoque (desde ${desdeDe('entradas')})...`);
      const entradasTotal      = await extrairEntradas(idEmpresa, desdeDe('entradas'));
      logInfo(`[Gabarito] [${cnpj}] Extraindo desempenho de vendedores (desde ${desdeDe('vendedores')})...`);
      const vendedoresTotal    = await extrairVendedores(idEmpresa, desdeDe('vendedores'));
      logInfo(`[Gabarito] [${cnpj}] Extraindo pedidos por horário (desde ${desdeDe('pedidosHorario')})...`);
      const pedidosHorarioTotal = await extrairPedidosPorHorario(idEmpresa, desdeDe('pedidosHorario'));
      logInfo(`[Gabarito] [${cnpj}] Extração concluída: fat=${faturamentoMensal.length}, pagar=${contasPagarTotal.length}, receber=${contasReceberTotal.length}, curvaAbc=${curvaAbcTotal.length}, entradas=${entradasTotal.length}, vendedores=${vendedoresTotal.length}, pedidosHorario=${pedidosHorarioTotal.length}`);

      const temDados = faturamentoMensal.length > 0 || contasPagarTotal.length > 0
        || contasReceberTotal.length > 0 || curvaAbcTotal.length > 0 || entradasTotal.length > 0
        || vendedoresTotal.length > 0 || pedidosHorarioTotal.length > 0;

      if (!temDados) {
        logWarn(`[Gabarito] CNPJ ${cnpj} (IDEMPRESA=${idEmpresa}) sem dados em ${anoCorrente}.`);
        semDados++;
        await enviarSync({
          dataReferencia,
          sourceVersion: process.env.GABARITO_VERSION || '1.0.0',
          syncMode: modoSync,
          desde,
          chunkInfo: { atual: 1, total: 1 },
          registros: [{ cnpj, faturamentoMensal: [], contasPagar: [], contasReceber: [], curvaAbc: [], entradas: [], vendedores: [], pedidosHorario: [] }]
        });
        // Sem histórico a carregar (janela de 3 anos veio vazia) — marca os
        // pendentes para não reconsultar 3 anos todo ciclo neste CNPJ.
        if (pendentes.length) markResourcesFullSynced(cnpj, pendentes);
        processados++;
        continue;
      }

      const dadosCompletos = { faturamentoMensal, contasPagar: contasPagarTotal, contasReceber: contasReceberTotal, curvaAbc: curvaAbcTotal, entradas: entradasTotal, vendedores: vendedoresTotal, pedidosHorario: pedidosHorarioTotal };
      const { changed, hash } = checkStateChanged(cnpj, dadosCompletos);

      // Backfill pendente força o envio mesmo com hash inalterado: a carga
      // histórica precisa chegar à API ainda que os últimos 3 meses não tenham
      // mudado desde o último ciclo.
      if (!changed && pendentes.length === 0) {
        logInfo(`[Gabarito] CNPJ ${cnpj}: Dados inalterados. Pulando envio (hash: ${hash}).`);
        processados++;
        continue;
      }

      logInfo(`[Gabarito] CNPJ ${cnpj}: faturamento=${faturamentoMensal.length}, ctaPagar=${contasPagarTotal.length}, ctaReceber=${contasReceberTotal.length}, curvaAbc=${curvaAbcTotal.length}, entradas=${entradasTotal.length}, vendedores=${vendedoresTotal.length}, pedidosHorario=${pedidosHorarioTotal.length}`);

      // Cada recurso é enviado como seu próprio stream de lotes (chunkInfo
      // honesto por tabela). Ver enviarRecurso() — substitui o antigo chunkInfo
      // global que truncava qualquer tabela que não fosse a maior do CNPJ.
      // O `desde` é POR RECURSO: a API deleta apenas a janela informada no swap,
      // então recurso em carga histórica leva `desde` de 3 anos.
      const baseMeta = {
        dataReferencia,
        sourceVersion: process.env.GABARITO_VERSION || '1.0.0',
        syncMode: modoSync
      };

      const recursos = [
        ['faturamentoMensal', faturamentoMensal],
        ['contasPagar',       contasPagarTotal],
        ['contasReceber',     contasReceberTotal],
        ['curvaAbc',          curvaAbcTotal],
        ['entradas',          entradasTotal],
        ['vendedores',        vendedoresTotal],
        ['pedidosHorario',    pedidosHorarioTotal]
      ];

      let todosSucesso = true;
      const backfilledAgora = [];
      for (const [campo, lista] of recursos) {
        const metaRecurso = { ...baseMeta, desde: desdeDe(campo) };
        const ok = await enviarRecurso(cnpj, metaRecurso, campo, lista);
        if (!ok) { todosSucesso = false; continue; }
        if (pendentes.includes(campo)) backfilledAgora.push(campo);
      }

      if (todosSucesso && curvaAbcCompleta) {
        updateState(cnpj, hash);
        if (backfilledAgora.length) {
          markResourcesFullSynced(cnpj, backfilledAgora);
          logInfo(`[Gabarito] [${cnpj}] Carga histórica concluída: ${backfilledAgora.join(', ')}.`);
        }
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
  let   pedidosHorarioTotal = await extrairPedidosPorHorario(idEmpresa, desde);

  logInfo(`[Gabarito] [${cnpj}] (full) base: fat=${faturamentoMensal.length}, pagar=${contasPagarTotal.length}, receber=${contasReceberTotal.length}, entradas=${entradasTotal.length}, vendedores=${vendedoresTotal.length}, pedidosHorario=${pedidosHorarioTotal.length}`);

  // Cada recurso como seu próprio stream (chunkInfo honesto por tabela), igual ao
  // ciclo incremental. Ver enviarRecurso().
  const baseMeta = { dataReferencia, sourceVersion, syncMode: 'full' };
  const recursosBase = [
    ['faturamentoMensal', faturamentoMensal],
    ['contasPagar',       contasPagarTotal],
    ['contasReceber',     contasReceberTotal],
    ['entradas',          entradasTotal],
    ['vendedores',        vendedoresTotal],
    ['pedidosHorario',    pedidosHorarioTotal]
  ];

  for (const [campo, lista] of recursosBase) {
    const ok = await enviarRecurso(cnpj, baseMeta, campo, lista);
    if (!ok) todosSucesso = false;
  }

  // Libera os arrays base antes do streaming da curva (reduz pico de memória)
  contasPagarTotal = contasReceberTotal = entradasTotal = vendedoresTotal = pedidosHorarioTotal = null;

  // 2) Curva ABC em streaming, um ano por vez
  await extrairCurvaAbcStreaming(idEmpresa, desde, async ({ ano, anoDesde, rows, completo: anoCompleto }) => {
    if (!anoCompleto) completo = false;

    const yearChunks = Math.max(1, Math.ceil(rows.length / CHUNK_SIZE));
    for (let i = 0; i < yearChunks; i++) {
      const caChunk = rows.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      if (caChunk.length === 0) continue;

      logInfo(`[Gabarito] [${cnpj}] (full) Enviando curva ${ano} lote ${i + 1}/${yearChunks}...`);
      const { ok } = await enviarSync({
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
 * - Com sync anterior: 1º dia de 3 meses atrás (captura retroativos recentes)
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
  d.setMonth(d.getMonth() - 3);
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

// ── Bootstrap ───────────────────────────────────────────────────────────────────
// Pulável com GABARITO_DISABLE_BOOTSTRAP=true para que testes possam requerer este
// módulo (e usar enviarRecurso) sem subir o cron nem conectar no Firebird.
if (process.env.GABARITO_DISABLE_BOOTSTRAP !== 'true') {
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
    runDatabaseMigrations().then(() => runMotor());
  }

  // Para o cron também, garantimos que rodou uma vez no boot
  runDatabaseMigrations();
}

module.exports = { enviarRecurso };
