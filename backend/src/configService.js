// src/configService.js
const fs = require('fs');
const path = require('path');

const caminhoConfig = path.join(__dirname, '..', 'config.json');

const configuracaoPadrao = {
  whatsappId: null,
  msdelay: 1000,
  queueId: null,
  closeTicket: true,
  noRegister: false,


  // histórico de envios (fica só em memória + config.json)
  // cada item: { id, tipo, numero, cliente, whatsapp, mensagem, status, origem, dataHora }
  historicoEnvios: []
};

function lerArquivoConfigBruto() {
  try {
    if (!fs.existsSync(caminhoConfig)) {
      return null;
    }

    const conteudo = fs.readFileSync(caminhoConfig, 'utf8');
    if (!conteudo.trim()) {
      return null;
    }

    return JSON.parse(conteudo);
  } catch (erro) {
    console.error('Erro ao ler config.json:', erro);
    return null;
  }
}

function escreverArquivoConfigBruto(dados) {
  try {
    fs.writeFileSync(
      caminhoConfig,
      JSON.stringify(dados, null, 2),
      'utf8'
    );
  } catch (erro) {
    console.error('Erro ao gravar config.json:', erro);
    throw erro;
  }
}

/**
 * Retorna a configuração mesclando config.json (se existir)
 * com os valores padrão.
 */
function lerConfiguracao() {
  const dadosArquivo = lerArquivoConfigBruto();

  if (!dadosArquivo) {
    return { ...configuracaoPadrao };
  }

  return {
    ...configuracaoPadrao,
    ...dadosArquivo,
    // garante que historicoEnvios sempre seja array
    historicoEnvios: Array.isArray(dadosArquivo.historicoEnvios)
      ? dadosArquivo.historicoEnvios
      : []
  };
}

/**
 * Atualiza parcialmente a configuração:
 * recebe um objeto com campos a alterar e grava em config.json.
 */
function salvarConfiguracao(novasProps) {
  const atual = lerConfiguracao();

  const atualizado = {
    ...atual,
    ...novasProps
  };

  escreverArquivoConfigBruto(atualizado);

  return atualizado;
}

/**
 * Adiciona um registro no histórico de envios.
 * Campos esperados em "dados":
 *  - tipo   : 'orcamento' | 'pedido' | 'cliente'
 *  - numero : número do documento (ex.: 199172, 82173, etc.)
 *  - cliente: nome do cliente
 *  - whatsapp: número do destino
 *  - mensagem: texto enviado (ou prévia)
 *  - status : 'enviado' | 'erro' | 'previa'
 *  - origem : 'automatico' | 'manual'
 */
function registrarEnvioHistorico(dados) {
  const cfg = lerConfiguracao();

  const agora = new Date();
  const historico = Array.isArray(cfg.historicoEnvios)
    ? cfg.historicoEnvios
    : [];

  const novoId = historico.length > 0
    ? (historico[historico.length - 1].id || 0) + 1
    : 1;

  const registro = {
    id: novoId,
    tipo: dados.tipo || 'desconhecido',
    numero: dados.numero ?? null,
    cliente: dados.cliente || '',
    whatsapp: dados.whatsapp || '',
    mensagem: dados.mensagem || '',
    status: dados.status || 'previa',
    origem: dados.origem || 'automatico',
    dataHora: agora.toISOString()
  };

  historico.push(registro);

  // se quiser limitar o tamanho do histórico, por ex. 500 últimos
  const LIMITE = 500;
  let historicoLimitado = historico;
  if (historico.length > LIMITE) {
    historicoLimitado = historico.slice(historico.length - LIMITE);
  }

  salvarConfiguracao({
    historicoEnvios: historicoLimitado
  });

  return registro;
}

module.exports = {
  lerConfiguracao,
  salvarConfiguracao,
  registrarEnvioHistorico,
  caminhoConfig
};
