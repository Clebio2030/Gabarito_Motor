// gabarito-motor/index.js
// Orquestrador principal do motor Gabarito.
//
// Fluxo executado a cada ciclo:
//   1. Busca CNPJs ativos via GET /companies
//   2. Cruza com Firebird -> obtem IDEMPRESA de cada CNPJ
//   3. Extrai faturamento mensal via GABARITO_FATURAMENTO_MENSAL
//   4. Extrai contas a pagar via GABARITO_CTAPAGAR_GERAL
//   5. Extrai contas a receber via GABARITO_CTARCEBER_GERAL
//   6. Envia um unico POST /sync com todos os registros
//   5. Loga resultado e duracao
//
// Cron: minuto 0 de cada hora, das 08h as 22h.
// Roda imediatamente se GABARITO_RUN_ON_START=true.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const cron = require('node-cron');
const { logInfo, logWarn, logError } = require('../logger');
const { buscarCnpjsAtivos, enviarSync } = require('./sender');
const { mapearCnpjsParaIdEmpresa, extrairFaturamentoMensal, extrairContasPagar, extrairContasReceber } = require('./extractor');
const { checkStateChanged, updateState } = require('./syncState');

// Funcao principal
let isMotorRunning = false;

async function runMotor() {
  if (isMotorRunning) {
    logWarn('[Gabarito] Ciclo anterior ainda em andamento. Ignorando este disparo.');
    return;
  }
  isMotorRunning = true;

  const inicio = Date.now();
  const dataReferencia = hojeFormatado(); // YYYY-MM-DD
  const anoCorrente = new Date().getFullYear();

  logInfo(`[Gabarito] Iniciando ciclo — data: ${dataReferencia}, ano: ${anoCorrente}`);

  let processados = 0;
  let ignorados   = 0;
  let semDados    = 0;

  try {
    // Passo 1: CNPJs ativos
    const cnpjsAtivos = await buscarCnpjsAtivos();

    if (!cnpjsAtivos.length) {
      logWarn('[Gabarito] Nenhum CNPJ ativo retornado pela API. Ciclo encerrado.');
      agendarProximoCiclo();
      return;
    }

    // Passo 2: Mapear CNPJ -> IDEMPRESA
    const mapaCnpjId = await mapearCnpjsParaIdEmpresa(cnpjsAtivos);

    // CNPJs sem mapeamento sao "ignorados"
    ignorados = cnpjsAtivos.length - Object.keys(mapaCnpjId).length;

    // Passo 3: Extrair faturamento e contas
    for (const [cnpj, idEmpresa] of Object.entries(mapaCnpjId)) {
      const faturamentoMensal = await extrairFaturamentoMensal(idEmpresa, anoCorrente);
      const contasPagarTotal  = await extrairContasPagar(idEmpresa);
      const contasReceberTotal = await extrairContasReceber(idEmpresa);

      const temDados = faturamentoMensal.length > 0 || contasPagarTotal.length > 0 || contasReceberTotal.length > 0;

      if (!temDados) {
        logWarn(`[Gabarito] CNPJ ${cnpj} (IDEMPRESA=${idEmpresa}) sem dados em ${anoCorrente}.`);
        semDados++;
        // Envia payload vazio para o CNPJ só para atualizar o dataReferencia
        await enviarSync({
          dataReferencia,
          sourceVersion: process.env.GABARITO_VERSION || '1.0.0',
          registros: [{ cnpj, faturamentoMensal: [], contasPagar: [], contasReceber: [] }]
        });
        processados++;
        continue;
      }

      // Verificar se houve mudança nos dados
      const dadosCompletos = { faturamentoMensal, contasPagar: contasPagarTotal, contasReceber: contasReceberTotal };
      const { changed, hash } = checkStateChanged(cnpj, dadosCompletos);

      if (!changed) {
        logInfo(`[Gabarito] CNPJ ${cnpj}: Dados inalterados. Pulando envio (hash: ${hash}).`);
        processados++;
        continue;
      }

      logInfo(`[Gabarito] CNPJ ${cnpj}: faturamento=${faturamentoMensal.length}, ctaPagar=${contasPagarTotal.length}, ctaReceber=${contasReceberTotal.length}`);

      // Fatiar (chunk) os arrays grandes para nao derrubar a API (Erro 502)
      const CHUNK_SIZE = 5000;
      const totalPagar = contasPagarTotal.length;
      const totalReceber = contasReceberTotal.length;
      const maxChunks = Math.max(1, Math.ceil(totalPagar / CHUNK_SIZE), Math.ceil(totalReceber / CHUNK_SIZE));

      for (let i = 0; i < maxChunks; i++) {
        const cpChunk = contasPagarTotal.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        const crChunk = contasReceberTotal.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        // Envia o faturamento apenas no primeiro chunk para não duplicar
        const fmChunk = (i === 0) ? faturamentoMensal : [];

        const payload = {
          dataReferencia,
          sourceVersion: process.env.GABARITO_VERSION || '1.0.0',
          chunkInfo: { atual: i + 1, total: maxChunks }, // Informa a API que é um envio paginado
          registros: [{
            cnpj,
            faturamentoMensal: fmChunk,
            contasPagar: cpChunk,
            contasReceber: crChunk
          }]
        };

        if (maxChunks > 1) {
          logInfo(`[Gabarito] Enviando lote ${i + 1}/${maxChunks} do CNPJ ${cnpj}...`);
        }
        await enviarSync(payload);
      }

      updateState(cnpj, hash); // Atualiza cache de estado pois enviou com sucesso

      processados++;
    }

  } catch (err) {
    logError('[Gabarito] Erro inesperado no ciclo do motor:', err);
  } finally {
    isMotorRunning = false;
  }

  const duracao = Date.now() - inicio;
  logInfo(
    `[Gabarito] Sync concluido: processados=${processados}, semDados=${semDados}, ignorados=${ignorados}, duracao=${duracao}ms`
  );

  agendarProximoCiclo();
}

// Helpers

function hojeFormatado() {
  const d = new Date();
  const ano  = d.getFullYear();
  const mes  = String(d.getMonth() + 1).padStart(2, '0');
  const dia  = String(d.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

function agendarProximoCiclo() {
  logInfo('[Gabarito] Proximo ciclo em 60 minutos (se dentro da janela 08h-22h).');
}

// Cron: modo teste (todo minuto) ou producao (hora em hora, 08h-22h)
const CRON_EXPR = process.env.GABARITO_CRON_MODE === 'test'
  ? '* * * * *'        // todo minuto
  : '0 8-22 * * *';    // producao: hora em hora, 08h-22h

cron.schedule(CRON_EXPR, () => {
  logInfo(`[Gabarito] Cron disparado (${CRON_EXPR}).`);
  runMotor();
});

logInfo(`[Gabarito] Motor registrado — cron: ${CRON_EXPR} (modo: ${process.env.GABARITO_CRON_MODE === 'test' ? 'TESTE - todo minuto' : 'PRODUCAO - 08h-22h a cada hora'}).`);

// Execucao imediata opcional

if (process.env.GABARITO_RUN_ON_START === 'true') {
  logInfo('[Gabarito] GABARITO_RUN_ON_START=true — executando agora...');
  runMotor();
}
