const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { logError } = require('../logger');

const STATE_FILE_PATH = path.join(__dirname, '..', '..', 'sync_state.json');

/**
 * Loads the current sync state from JSON file.
 * @returns {Record<string, string>}
 */
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE_PATH)) {
      const data = fs.readFileSync(STATE_FILE_PATH, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    logError('[Gabarito] Erro ao ler sync_state.json:', err);
  }
  return {};
}

/**
 * Saves the sync state to JSON file.
 * @param {Record<string, string>} state
 */
function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    logError('[Gabarito] Erro ao salvar sync_state.json:', err);
  }
}

/**
 * Generates an MD5 hash of the given data object.
 * @param {any} data
 * @returns {string}
 */
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
 * Checks if the hash of the new data is different from the saved hash for the given CNPJ.
 * @param {string} cnpj
 * @param {any} data
 * @returns {{ changed: boolean, hash: string }}
 */
function checkStateChanged(cnpj, data) {
  const state = loadState();
  const currentHash = generateHash(data);
  const previousHash = state[cnpj];

  return {
    changed: currentHash !== previousHash,
    hash: currentHash
  };
}

/**
 * Updates the saved hash for the given CNPJ.
 * @param {string} cnpj
 * @param {string} newHash
 */
function updateState(cnpj, newHash) {
  const state = loadState();
  state[cnpj] = newHash;
  saveState(state);
}

module.exports = {
  checkStateChanged,
  updateState
};
