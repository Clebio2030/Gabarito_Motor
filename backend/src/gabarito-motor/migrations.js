const fs = require('fs');
const path = require('path');
const { query } = require('./firebird');
const { logInfo, logError, logWarn } = require('../logger');

/**
 * Aplica o SQL de views diretamente via driver Firebird do Node.
 * Mais seguro que depender do isql.exe da máquina do cliente.
 */
/**
 * Nome do objeto criado por um statement DDL, para o log dizer QUAL view falhou
 * em vez de só despejar a mensagem do Firebird.
 * @param {string} statement
 * @returns {string}
 */
function nomeDoObjeto(statement) {
  const m = statement.match(/CREATE\s+(?:OR\s+ALTER\s+)?(VIEW|PROCEDURE|TRIGGER|TABLE|INDEX)\s+([A-Z0-9_$]+)/i);
  return m ? `${m[1].toUpperCase()} ${m[2].toUpperCase()}` : statement.slice(0, 60).replace(/\s+/g, ' ');
}

async function runDatabaseMigrations() {
  logInfo('[Database] Iniciando verificacao de migracao de banco...');

  const sqlPath = path.join(__dirname, '..', '..', '..', 'sql', 'criar_views_gabarito.sql');
  // Se o arquivo dummy estiver la (v1.7.1+), usamos o views_real.sql que vamos criar
  let finalSqlPath = sqlPath;
  const realSqlPath = path.join(__dirname, '..', '..', '..', 'sql', 'views_real.sql');
  
  if (fs.existsSync(realSqlPath)) {
    finalSqlPath = realSqlPath;
  }

  if (!fs.existsSync(finalSqlPath)) {
    logWarn(`[Database] Script SQL nao encontrado em ${finalSqlPath}. Pulando.`);
    return;
  }

  try {
    const rawSql = fs.readFileSync(finalSqlPath, 'utf8');
    
    // Split por ponto e virgula, mas ignorando o que estiver dentro de comentarios
    // (Simplificacao robusta para o formato das nossas views)
    // Limpa comentários de bloco (/* ... */) e de linha (-- ...)
    const cleanedSql = rawSql
      .replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$|--.*$/gm, '')
      .trim();
    
    const statements = cleanedSql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.toLowerCase().startsWith('select'));

    logInfo(`[Database] Aplicando ${statements.length} comandos SQL...`);

    const falhas = [];

    for (const statement of statements) {
      const objeto = nomeDoObjeto(statement);
      try {
        await query(statement);
      } catch (err) {
        // Se o erro for "View already exists", ignoramos se for CREATE OR ALTER (padrão)
        if (err.message.includes('already exists')) continue;

        // Uma view que não compila some da base e o recurso dela morre calado: o
        // extractor recebe "-204 Table unknown" e não tem como dizer o porquê.
        // Por isso o erro é ERROR (não WARN) e nomeia o objeto — é esta linha
        // que responde "por que a view não existe neste cliente".
        falhas.push(objeto);
        logError(`[Database] FALHA ao criar/alterar ${objeto}: ${err.message}`);
      }
    }

    if (falhas.length) {
      logError(`[Database] Migracao concluida com ${falhas.length} de ${statements.length} objeto(s) COM FALHA: ${falhas.join(', ')}. Os recursos que dependem deles não serão extraídos.`);
    } else {
      logInfo('[Database] Migracao concluida com sucesso.');
    }
  } catch (error) {
    logError('[Database] Falha fatal na migracao:', error);
  }
}

module.exports = { runDatabaseMigrations };
