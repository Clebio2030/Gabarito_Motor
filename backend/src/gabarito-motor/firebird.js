// gabarito-motor/firebird.js
// Conexão dedicada ao motor do Gabarito.
// Usa as mesmas variáveis de ambiente do projeto (FB_*),
// com suporte a FB_CHARSET para bases WIN1252.

const firebird = require('node-firebird');

function getOptions() {
  return {
    host:          process.env.FB_HOST     || '127.0.0.1',
    port:          Number(process.env.FB_PORT || 3050),
    database:      process.env.FB_DATABASE || '',
    user:          process.env.FB_USER     || 'SYSDBA',
    password:      process.env.FB_PASSWORD || 'masterkey',
    lowercase_keys: true,
    role:          null,
    pageSize:      4096,
    charset:       process.env.FB_CHARSET  || 'WIN1252'
  };
}

const QUERY_TIMEOUT_MS = parseInt(process.env.FB_QUERY_TIMEOUT || '90000', 10);

/**
 * Executa uma query SQL parametrizada no Firebird e resolve com o array de linhas.
 * Rejeita automaticamente após FB_QUERY_TIMEOUT ms (padrão: 90 s) para evitar
 * que queries travadas bloqueiem o ciclo indefinidamente.
 * @param {string} sql
 * @param {Array}  params
 * @returns {Promise<Array>}
 */
function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`Firebird query timeout (${QUERY_TIMEOUT_MS}ms): ${sql.substring(0, 120)}`));
      }
    }, QUERY_TIMEOUT_MS);

    firebird.attach(getOptions(), (err, db) => {
      if (err) {
        clearTimeout(timer);
        if (!settled) { settled = true; reject(err); }
        return;
      }

      db.query(sql, params, (errQ, rows) => {
        clearTimeout(timer);
        db.detach();
        if (!settled) {
          settled = true;
          if (errQ) return reject(errQ);
          resolve(rows || []);
        }
      });
    });
  });
}

module.exports = { query };
