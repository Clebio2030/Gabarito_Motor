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
      const isServerError = status && status >= 500;

      if (isServerError && tentativa < RETRY_ATTEMPTS) {
        const espera = resolverEspera(err);
        logWarn(`[Gabarito] GET /companies retornou ${status}. Tentativa ${tentativa}/${RETRY_ATTEMPTS}. Aguardando ${espera / 1000}s...`);
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
 * Retorna true se enviou com sucesso, false em falha definitiva.
 * @param {object} payload
 * @returns {Promise<boolean>}
 */
async function enviarSync(payload) {
  const url = process.env.GABARITO_API_URL ||
              'https://gabarito.csdigitalz.com.br/api/v1/sync';

  for (let tentativa = 1; tentativa <= RETRY_ATTEMPTS; tentativa++) {
    try {
      const response = await axios.post(url, payload, {
        headers: getHeaders(),
        timeout: 60_000
      });

      logInfo(`[Gabarito] POST /sync respondeu ${response.status} — OK.`);
      return true;

    } catch (err) {
      const status = err.response?.status;
      const isServerError = !status || status >= 500; // inclui timeout (sem status)

      if (isServerError && tentativa < RETRY_ATTEMPTS) {
        const espera = resolverEspera(err);
        logWarn(`[Gabarito] POST /sync retornou ${status || 'timeout'}. Tentativa ${tentativa}/${RETRY_ATTEMPTS}. Aguardando ${espera / 1000}s...`);
        await sleep(espera);
        continue;
      }

      const detalhe = err.response ? `HTTP ${status}: ${JSON.stringify(err.response.data)}` : err.message;
      logError(`[Gabarito] Falha definitiva no POST /sync (tentativa ${tentativa}/${RETRY_ATTEMPTS}): ${detalhe}`);
      return false;
    }
  }
  return false;
}

module.exports = { buscarCnpjsAtivos, enviarSync };
