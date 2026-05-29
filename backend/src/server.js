// src/server.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const firebird = require('node-firebird');

const {
  lerConfiguracao,
  salvarConfiguracao,
  registrarEnvioHistorico
} = require('./configService');
const { executarConsulta, getDBOptions } = require('./db');
const { logInfo, logError } = require('./logger');

// ── Gabarito Motor ─────────────────────────────────────────────────────────────
require('./gabarito-motor');
// ──────────────────────────────────────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3001;

// ──────────────────────────────────────
// Middlewares
// ──────────────────────────────────────
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());


// ──────────────────────────────────────
// Helpers Firebird
// ──────────────────────────────────────
async function testarConexaoFirebird() {
  try {
    const dbOptions = getDBOptions();
    if (!dbOptions.host) return false;

    return new Promise((resolve) => {
      firebird.attach(dbOptions, (err, db) => {
        if (err) {
          logError('Erro ao testar Firebird', err);
          return resolve(false);
        }
        db.query('SELECT 1 FROM RDB$DATABASE', [], (errQ) => {
          db.detach();
          if (errQ) {
            logError('Erro na query de teste Firebird', errQ);
            return resolve(false);
          }
          resolve(true);
        });
      });
    });
  } catch (err) {
    logError('Exceção no testarConexaoFirebird', err);
    return false;
  }
}


// ──────────────────────────────────────
// Health check
// ──────────────────────────────────────
app.get('/health', async (req, res) => {
  let firebirdStatus = await testarConexaoFirebird() ? 'ok' : 'error';
  res.json({
    status: 'ok',
    firebird: firebirdStatus,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// ──────────────────────────────────────
// Dashboard
// ──────────────────────────────────────
app.get('/dashboard/resumo', async (req, res) => {
  try {
    const cfg = lerConfiguracao();
    const historico = cfg.historicoEnvios || [];

    const total = historico.length;
    const enviados = historico.filter(h => h.status === 'enviado').length;
    const erros = historico.filter(h => h.status === 'erro').length;
    const previas = historico.filter(h => h.status === 'previa').length;

    const ultimos = historico.slice(-10).reverse();

    const token = cfg.gabaritoToken || process.env.GABARITO_TOKEN || '';
    const gabaritoAtivo = token.trim().length > 0;

    let firebirdOk = await testarConexaoFirebird();

    res.json({
      total,
      enviados,
      erros,
      previas,
      ultimos,
      gabaritoAtivo,
      firebirdOk
    });
  } catch (err) {
    logError('Erro no /dashboard/resumo:', err);
    res.status(500).json({ error: 'Erro ao carregar resumo' });
  }
});


// ──────────────────────────────────────
// Histórico de envios
// ──────────────────────────────────────
app.get('/historico/envios', (req, res) => {
  try {
    const cfg = lerConfiguracao();
    const historico = (cfg.historicoEnvios || []).slice().reverse();
    res.json({ historico });
  } catch (err) {
    logError('Erro no /historico/envios:', err);
    res.status(500).json({ error: 'Erro ao carregar histórico' });
  }
});

// ──────────────────────────────────────
// Configuração geral
// ──────────────────────────────────────
app.get('/config', (req, res) => {
  try {
    const cfg = lerConfiguracao();
    const { historicoEnvios, ...rest } = cfg;
    
    rest.gabaritoToken = rest.gabaritoToken || process.env.GABARITO_TOKEN || '';
    
    res.json(rest);
  } catch (err) {
    console.error('Erro no GET /config:', err);
    res.status(500).json({ error: 'Erro ao carregar configuração' });
  }
});

app.post('/config', (req, res) => {
  try {
    const atualizado = salvarConfiguracao(req.body);
    const { historicoEnvios, ...rest } = atualizado;
    res.json(rest);
  } catch (err) {
    console.error('Erro no POST /config:', err);
    res.status(500).json({ error: 'Erro ao salvar configuração' });
  }
});





// ──────────────────────────────────────

// ──────────────────────────────────────
// Iniciar servidor
// ──────────────────────────────────────
app.listen(PORT, () => {
  logInfo('================================================');
  logInfo(`  Gabarito Backend rodando em http://localhost:${PORT}`);
  logInfo('================================================');
});
