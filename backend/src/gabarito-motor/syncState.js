const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { logError } = require('../logger');

// Sobrescrevível por env para testes isolados (não toca no estado de produção).
const STATE_FILE_PATH = process.env.GABARITO_STATE_FILE || path.join(__dirname, '..', '..', 'sync_state.json');

// Formato do estado por CNPJ:
// { hash: string, lastSyncedAt: string|null, fullSyncedResources?: string[] }
//
// `fullSyncedResources` é o watermark POR RECURSO: lista dos recursos com janela
// que já receberam a carga histórica completa (3 anos). Um recurso ausente dessa
// lista dispara uma carga histórica única no próximo ciclo; presente → segue no
// incremental de 3 meses. Isso torna a adição de novos relatórios auto-corretiva:
// qualquer recurso novo nasce sem carimbo e carrega o histórico sozinho.
//
// Formato antigo (string pura) é migrado automaticamente na leitura.

// Recursos extraídos por janela de data (têm parâmetro `desde`). Só esses
// participam do watermark por recurso — os demais (contasPagar/receber,
// faturamentoMensal) são snapshots completos e não têm "carga histórica".
const WINDOWED_RESOURCES = ['curvaAbc', 'entradas', 'vendedores', 'pedidosHorario'];

// Recursos com janela que JÁ existiam antes do watermark por recurso. Para CNPJs
// já sincronizados (estado legado, sem `fullSyncedResources`), assumimos que a
// carga histórica desses já ocorreu no full sync original — só os recursos mais
// novos (vendedores, pedidosHorario) precisarão carregar o histórico.
const LEGACY_BACKFILLED_RESOURCES = ['curvaAbc', 'entradas'];

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
 * Persiste o hash e o timestamp do sync concluído, preservando o watermark por
 * recurso (`fullSyncedResources`) já acumulado para o CNPJ.
 * @param {string} cnpj
 * @param {string} newHash
 */
function updateState(cnpj, newHash) {
  const state = loadState();
  const anterior = state[cnpj] || {};
  state[cnpj] = {
    hash: newHash,
    lastSyncedAt: new Date().toISOString(),
    fullSyncedResources: anterior.fullSyncedResources
  };
  saveState(state);
}

/**
 * Retorna os recursos com janela que já tiveram carga histórica completa para o
 * CNPJ. Migra estado legado: CNPJ já sincronizado (com `lastSyncedAt`) mas sem o
 * campo → assume os recursos que existiam no full sync original já carregados.
 * @param {string} cnpj
 * @returns {string[]}
 */
function getFullSyncedResources(cnpj) {
  const state = loadState();
  const entry = state[cnpj];
  if (!entry) return [];
  if (Array.isArray(entry.fullSyncedResources)) return entry.fullSyncedResources;
  return entry.lastSyncedAt ? [...LEGACY_BACKFILLED_RESOURCES] : [];
}

/**
 * Marca recursos como historicamente carregados para o CNPJ (união com os já
 * existentes). Idempotente. Materializa o watermark legado na primeira gravação.
 * @param {string}   cnpj
 * @param {string[]} recursos
 */
function markResourcesFullSynced(cnpj, recursos) {
  if (!recursos || recursos.length === 0) return;
  const state = loadState();
  const entry = state[cnpj] || { hash: null, lastSyncedAt: null };
  const atuais = Array.isArray(entry.fullSyncedResources)
    ? entry.fullSyncedResources
    : (entry.lastSyncedAt ? [...LEGACY_BACKFILLED_RESOURCES] : []);
  entry.fullSyncedResources = [...new Set([...atuais, ...recursos])];
  state[cnpj] = entry;
  saveState(state);
}

module.exports = {
  checkStateChanged,
  getLastSyncedAt,
  updateState,
  getFullSyncedResources,
  markResourcesFullSynced,
  WINDOWED_RESOURCES
};
