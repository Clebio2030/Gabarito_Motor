// gabarito-motor/sender.js
// Responsável por:
//   - GET /companies para buscar CNPJs ativos
//   - POST /sync com retry (3 tentativas, 10s entre elas) para enviar os KPIs

const axios = require('axios');
const { logInfo, logWarn, logError } = require('../logger');

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 10_000;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getHeaders() {
  return {
    'Content-Type':       'application/json',
    'X-Integration-Token': process.env.GABARITO_TOKEN || ''
  };
}

// ─── Passo 1: Buscar CNPJs ativos ─────────────────────────────────────────────

/**
 * Chama GET /companies e retorna apenas os CNPJs com status "ACTIVE".
 * @returns {Promise<string[]>}
 */
async function buscarCnpjsAtivos() {
  const url = process.env.GABARITO_COMPANIES_URL ||
              'https://gabarito.csdigitalz.com.br/api/v1/companies';

  for (let tentativa = 1; tentativa <= RETRY_ATTEMPTS; tentativa++) {
    try {
      const response = await axios.get(url, {
        headers: getHeaders(),
        timeout: 30_000
      });

      const lista = Array.isArray(response.data) ? response.data : [];
      const ativos = lista
        .filter((c) => c.status === 'ACTIVE')
        .map((c) => c.cnpj);

      logInfo(`[Gabarito] ${ativos.length} CNPJ(s) ativo(s) recebidos da API.`);
      return ativos;

    } catch (err) {
      const status = err.response?.status;
      const isServerError = status && status >= 500;

      if (isServerError && tentativa < RETRY_ATTEMPTS) {
        logWarn(
          `[Gabarito] GET /companies retornou ${status}. ` +
          `Tentativa ${tentativa}/${RETRY_ATTEMPTS}. Aguardando ${RETRY_DELAY_MS / 1000}s...`
        );
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      const detalhe = err.response
        ? `HTTP ${status}: ${JSON.stringify(err.response.data)}`
        : err.message;

      logError(
        `[Gabarito] Falha definitiva no GET /companies (tentativa ${tentativa}/${RETRY_ATTEMPTS}): ${detalhe}`
      );
      return []; // Retorna lista vazia para evitar quebrar o motor
    }
  }
  return [];
}

// ─── Passo 4: Enviar payload com retry ────────────────────────────────────────

/**
 * Envia o payload de sincronização com até 3 tentativas em erros 5xx.
 *
 * @param {object} payload  Corpo do POST conforme spec da API Gabarito.
 * @returns {Promise<void>}
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
      return; // sucesso — encerra

    } catch (err) {
      const status = err.response?.status;
      const isServerError = status && status >= 500;

      if (isServerError && tentativa < RETRY_ATTEMPTS) {
        logWarn(
          `[Gabarito] POST /sync retornou ${status}. ` +
          `Tentativa ${tentativa}/${RETRY_ATTEMPTS}. Aguardando ${RETRY_DELAY_MS / 1000}s...`
        );
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      // Erro de cliente (4xx) ou esgotou tentativas
      const detalhe = err.response
        ? `HTTP ${status}: ${JSON.stringify(err.response.data)}`
        : err.message;

      logError(
        `[Gabarito] Falha definitiva no POST /sync (tentativa ${tentativa}/${RETRY_ATTEMPTS}): ${detalhe}`
      );
      return; // loga e segue — não rejeita para não derrubar o motor
    }
  }
}

module.exports = { buscarCnpjsAtivos, enviarSync };
