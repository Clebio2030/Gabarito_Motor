const fs = require('fs');
const path = require('path');
const os = require('os');

// Caminho do arquivo .env (na raiz do backend)
const envPath = path.join(__dirname, '.env');

// Argumentos passados pelo script: host, port, database, token
// Se o argumento for "EMPTY_VAL", significa que o usuário não digitou nada (manter valor atual)
const args = process.argv.slice(2);
const updates = {
  FB_HOST: args[0] === 'EMPTY_VAL' ? '' : args[0],
  FB_PORT: args[1] === 'EMPTY_VAL' ? '' : args[1],
  FB_DATABASE: args[2] === 'EMPTY_VAL' ? '' : args[2],
  GABARITO_TOKEN: args[3] === 'EMPTY_VAL' ? '' : args[3]
};

console.log('Iniciando configuração do ambiente...');
console.log('Valores recebidos:', updates);

let lines = [];

// Lê o arquivo existente se houver
if (fs.existsSync(envPath)) {
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    // Divide por quebra de linha (suporta Windows \r\n e Linux \n)
    lines = content.split(/\r?\n/);
  } catch (err) {
    console.error('Erro ao ler arquivo .env:', err.message);
    // Se der erro ao ler, assume vazio
    lines = [];
  }
} else {
  console.log('Arquivo .env não encontrado. Criando novo.');
}

const processedKeys = new Set();
const newLines = [];

// 1. Processa linhas existentes
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  // Regex simples para identificar CHAVE=VALOR
  // Pega chaves que começam com letra/underscore, seguidas de =
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=(.*)/i);

  if (match) {
    const key = match[1].trim();
    // Se é uma das chaves que estamos configurando
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      // Evita duplicatas se a chave aparecer mais de uma vez no arquivo
      if (processedKeys.has(key)) {
        continue; 
      }
      
      processedKeys.add(key);
      
      // Se o usuário passou um valor novo (não vazio), atualiza
      // Se passou vazio (EMPTY_VAL tratado antes), mantém o valor original da linha
      if (updates[key] !== '') {
        console.log(`Atualizando ${key}...`);
        newLines.push(`${key}=${updates[key]}`);
      } else {
        console.log(`Mantendo ${key} atual.`);
        newLines.push(line);
      }
    } else {
      // Outras chaves (ex: PORT, configs extras) mantém como está
      newLines.push(line);
    }
  } else {
    // Comentários ou linhas em branco
    newLines.push(line);
  }
}

// 2. Adiciona chaves que não existiam no arquivo
Object.keys(updates).forEach(key => {
  // Se ainda não processamos essa chave E temos um valor para ela
  if (!processedKeys.has(key) && updates[key] !== '') {
    console.log(`Adicionando nova chave ${key}...`);
    newLines.push(`${key}=${updates[key]}`);
  }
});

// 3. Remove linhas em branco excessivas no final
while (newLines.length > 0 && newLines[newLines.length - 1].trim() === '') {
  newLines.pop();
}

// 4. Grava o arquivo
try {
  const newContent = newLines.join(os.EOL);
  fs.writeFileSync(envPath, newContent, 'utf8');
  console.log('Arquivo .env salvo com sucesso em:', envPath);
} catch (err) {
  console.error('Erro ao salvar arquivo .env:', err.message);
  process.exit(1);
}

