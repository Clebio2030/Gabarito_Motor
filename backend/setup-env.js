const fs = require('fs');
const path = require('path');
const os = require('os');

// Caminho do arquivo .env (na raiz do backend)
const envPath = path.join(__dirname, '.env');

// Template padrão com valores que devem existir se o arquivo for novo
const DEFAULT_ENV = `# Firebird
FB_HOST=127.0.0.1
FB_PORT=3050
FB_DATABASE=
FB_USER=SYSDBA
FB_PASSWORD=masterkey
FB_CHARSET=WIN1252

# Gabarito
GABARITO_TOKEN=
GABARITO_API_URL=https://gabarito.csdigitalz.com.br/api/v1/sync
GABARITO_COMPANIES_URL=https://gabarito.csdigitalz.com.br/api/v1/companies
GABARITO_VERSION=1.0.0
GABARITO_RUN_ON_START=true
# CRON_MODE: test = roda todo minuto | prod = roda 1x/hora das 08h-22h
GABARITO_CRON_MODE=prod
`;

// Argumentos passados pelo script: host, port, database, token
const args = process.argv.slice(2);
const updates = {
  FB_HOST: args[0] === 'EMPTY_VAL' ? '' : args[0],
  FB_PORT: args[1] === 'EMPTY_VAL' ? '' : args[1],
  FB_DATABASE: args[2] === 'EMPTY_VAL' ? '' : args[2],
  GABARITO_TOKEN: args[3] === 'EMPTY_VAL' ? '' : args[3]
};

console.log('Iniciando configuração do ambiente...');

let content = '';

if (fs.existsSync(envPath)) {
  content = fs.readFileSync(envPath, 'utf8');
} else {
  console.log('Arquivo .env não encontrado. Usando template padrão.');
  content = DEFAULT_ENV;
}

let lines = content.split(/\r?\n/);
const processedKeys = new Set();
const newLines = [];

// 1. Processa linhas existentes (ou do template)
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=(.*)/i);

  if (match) {
    const key = match[1].trim();
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      if (processedKeys.has(key)) continue;
      processedKeys.add(key);

      if (updates[key] !== '') {
        console.log(`Atualizando ${key}...`);
        newLines.push(`${key}=${updates[key]}`);
      } else {
        newLines.push(line);
      }
    } else {
      newLines.push(line);
    }
  } else {
    newLines.push(line);
  }
}

// 2. Adiciona chaves que não existiam (caso o template mude no futuro)
Object.keys(updates).forEach(key => {
  if (!processedKeys.has(key) && updates[key] !== '') {
    console.log(`Adicionando nova chave ${key}...`);
    newLines.push(`${key}=${updates[key]}`);
  }
});

// Grava o arquivo
try {
  const newContent = newLines.join(os.EOL);
  fs.writeFileSync(envPath, newContent, 'utf8');
  console.log('Arquivo .env salvo com sucesso em:', envPath);
} catch (err) {
  console.error('Erro ao salvar arquivo .env:', err.message);
  process.exit(1);
}
