// src/db.js
const firebird = require('node-firebird');

const options = {
  host: process.env.FB_HOST || '127.0.0.1',
  port: Number(process.env.FB_PORT || 3050),
  database: process.env.FB_DATABASE || 'D:\Bancos\Lojao\LOJAO.FDB',
  user: process.env.FB_USER || 'SYSDBA',
  password: process.env.FB_PASSWORD || 'masterkey',
  lowercase_keys: true,
  role: null,
  pageSize: 4096
};

function executarConsulta(sql, params = []) {
  return new Promise((resolve, reject) => {
    firebird.attach(options, (err, db) => {
      if (err) {
        return reject(err);
      }

      db.query(sql, params, (errQuery, result) => {
        db.detach();
        if (errQuery) {
          return reject(errQuery);
        }
        resolve(result);
      });
    });
  });
}

module.exports = {
  executarConsulta
};
