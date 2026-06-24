const fs = require('fs');
const path = require('path');
const { query } = require('./firebird');
const { logInfo, logError, logWarn } = require('../logger');

/**
 * Aplica o SQL de views diretamente via driver Firebird do Node.
 * Mais seguro que depender do isql.exe da máquina do cliente.
 */
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

    for (const statement of statements) {
      try {
        await query(statement);
      } catch (err) {
        // Se o erro for "View already exists", ignoramos se for CREATE OR ALTER (padrão)
        // Mas logamos para depuracao
        if (err.message.includes('already exists')) {
            // ok
        } else {
            logWarn(`[Database] Erro ao executar statement: ${err.message}`);
        }
      }
    }

    logInfo('[Database] Migracao concluida com sucesso.');
  } catch (error) {
    logError('[Database] Falha fatal na migracao:', error);
  }
}

module.exports = { runDatabaseMigrations };
