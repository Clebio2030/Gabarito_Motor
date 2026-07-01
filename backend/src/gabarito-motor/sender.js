// gabarito-motor/sender.js
// Responsável por:
//   - GET /companies para buscar CNPJs ativos
//   - POST /sync com retry inteligente para enviar os KPIs
//
// Retry: até RETRY_ATTEMPTS tentativas em erros 5xx.
// Respeita retry_after da resposta (ex: Cloudflare 502) quando presente.

const axios = require('axios');
const { logInfo, logWarn, logError } = require('../logger');

const RETRY_ATTEMPTS  = 5;
const RETRY_DELAY_MS  = 60_000; // padrão: 60s (alinhado com retry_after do Cloudflare)
// Timeout do POST. O 1º lote de cada ano da curva dispara um delete pesado na
// API (apaga o período antes de inserir) que pode passar de 60s; um timeout
// curto provoca retry prematuro enquanto a API ainda processa, gerando 400/502.
const POST_TIMEOUT_MS = parseInt(process.env.GABARITO_HTTP_TIMEOUT || '120000', 10);

// ─── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getHeaders() {
  return {
    'Content-Type':        'application/json',
    'X-Integration-Token': process.env.GABARITO_TOKEN || ''
  };
}

/**
 * Extrai o tempo de espera em ms a partir da resposta de erro.
 * Usa retry_after do body (Cloudflare) ou o padrão RETRY_DELAY_MS.
 */
function resolverEspera(err) {
  const retryAfterSeg = err.response?.data?.retry_after;
  if (retryAfterSeg && typeof retryAfterSeg === 'number') {
    return retryAfterSeg * 1000;
  }
  return RETRY_DELAY_MS;
}

// ─── Passo 1: Buscar CNPJs ativos ─────────────────────────────────────────────

async function buscarCnpjsAtivos() {
  const url = process.env.GABARITO_COMPANIES_URL ||
              'https://gabarito.csdigitalz.com.br/api/v1/companies';

  for (let tentativa = 1; tentativa <= RETRY_ATTEMPTS; tentativa++) {
    try {
      const response = await axios.get(url, {
        headers: getHeaders(),
        timeout: 30_000
      });

      const lista  = Array.isArray(response.data) ? response.data : [];
      const ativos = lista.filter((c) => c.status === 'ACTIVE').map((c) => c.cnpj);

      logInfo(`[Gabarito] ${ativos.length} CNPJ(s) ativo(s) recebidos da API.`);
      return ativos;

    } catch (err) {
      const status = err.response?.status;
      const isServerError = !status || status >= 500; // inclui timeout (sem status)

      if (isServerError && tentativa < RETRY_ATTEMPTS) {
        const espera = resolverEspera(err);
        logWarn(`[Gabarito] GET /companies retornou ${status || 'timeout'}. Tentativa ${tentativa}/${RETRY_ATTEMPTS}. Aguardando ${espera / 1000}s...`);
        await sleep(espera);
        continue;
      }

      const detalhe = err.response ? `HTTP ${status}: ${JSON.stringify(err.response.data)}` : err.message;
      logError(`[Gabarito] Falha definitiva no GET /companies (tentativa ${tentativa}/${RETRY_ATTEMPTS}): ${detalhe}`);
      return [];
    }
  }
  return [];
}

// ─── Enviar payload com retry ─────────────────────────────────────────────────

/**
 * Envia o payload de sincronização com retry inteligente.
 * Respeita retry_after do Cloudflare quando presente.
 * Retorna { ok, persisted } — ok=false em falha definitiva. `persisted` traz a
 * contagem que a API confirmou ter gravado por recurso (quando disponível), usada
 * para a verificação de integridade fim-a-fim da Fase 1.
 * @param {object} payload
 * @returns {Promise<{ ok: boolean, persisted?: object }>}
 */
async function enviarSync(payload) {
  const url = process.env.GABARITO_API_URL ||
              'https://gabarito.csdigitalz.com.br/api/v1/sync';

  for (let tentativa = 1; tentativa <= RETRY_ATTEMPTS; tentativa++) {
    try {
      const response = await axios.post(url, payload, {
        headers: getHeaders(),
        timeout: POST_TIMEOUT_MS
      });

      logInfo(`[Gabarito] POST /sync respondeu ${response.status} — OK.`);
      return { ok: true, persisted: response.data?.persisted };

    } catch (err) {
      const status = err.response?.status;
      // 400 do nginx (HTML, nivel de infra) é transitório — surge quando o retry
      // bate na API ainda processando o delete pesado. Diferente de um 400 do app
      // (JSON, validação), que NÃO deve ser retentado.
      const isNginx400 = status === 400
        && typeof err.response?.data === 'string'
        && err.response.data.includes('nginx');
      const isServerError = !status || status >= 500 || isNginx400; // inclui timeout (sem status)

      if (isServerError && tentativa < RETRY_ATTEMPTS) {
        const espera = resolverEspera(err);
        logWarn(`[Gabarito] POST /sync retornou ${status || 'timeout'}. Tentativa ${tentativa}/${RETRY_ATTEMPTS}. Aguardando ${espera / 1000}s...`);
        await sleep(espera);
        continue;
      }

      const detalhe = err.response ? `HTTP ${status}: ${JSON.stringify(err.response.data)}` : err.message;
      logError(`[Gabarito] Falha definitiva no POST /sync (tentativa ${tentativa}/${RETRY_ATTEMPTS}): ${detalhe}`);
      return { ok: false };
    }
  }
  return { ok: false };
}

module.exports = { buscarCnpjsAtivos, enviarSync };
