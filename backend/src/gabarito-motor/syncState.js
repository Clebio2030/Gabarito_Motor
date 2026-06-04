const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { logError } = require('../logger');

const STATE_FILE_PATH = path.join(__dirname, '..', '..', 'sync_state.json');

// Formato do estado por CNPJ:
// { hash: string, lastSyncedAt: string|null }
//
// Formato antigo (string pura) é migrado automaticamente na leitura.

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf8'));
      const state = {};
      for (const [cnpj, value] of Object.entries(raw)) {
        state[cnpj] = typeof value === 'string'
          ? { hash: value, lastSyncedAt: null }  // migração do formato antigo
          : value;
      }
      return state;
    }
  } catch (err) {
    logError('[Gabarito] Erro ao ler sync_state.json:', err);
  }
  return {};
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    logError('[Gabarito] Erro ao salvar sync_state.json:', err);
  }
}

function generateHash(data) {
  const hash = crypto.createHash('md5');
  function feed(v) {
    if (Array.isArray(v)) {
      for (const item of v) hash.update(JSON.stringify(item));
    } else if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) { hash.update(k); feed(val); }
    } else {
      hash.update(String(v ?? ''));
    }
  }
  feed(data);
  return hash.digest('hex');
}

/**
 * Verifica se os dados mudaram em relação ao último sync.
 * @param {string} cnpj
 * @param {any}    data
 * @returns {{ changed: boolean, hash: string }}
 */
function checkStateChanged(cnpj, data) {
  const state = loadState();
  const currentHash  = generateHash(data);
  const previousHash = state[cnpj]?.hash ?? null;
  return { changed: currentHash !== previousHash, hash: currentHash };
}

/**
 * Retorna a data/hora do último sync bem-sucedido para o CNPJ,
 * ou null se nunca sincronizou.
 * @param {string} cnpj
 * @returns {string|null}
 */
function getLastSyncedAt(cnpj) {
  const state = loadState();
  return state[cnpj]?.lastSyncedAt ?? null;
}

/**
 * Persiste o hash e o timestamp do sync concluído.
 * @param {string} cnpj
 * @param {string} newHash
 */
function updateState(cnpj, newHash) {
  const state = loadState();
  state[cnpj] = { hash: newHash, lastSyncedAt: new Date().toISOString() };
  saveState(state);
}

module.exports = { checkStateChanged, getLastSyncedAt, updateState };
