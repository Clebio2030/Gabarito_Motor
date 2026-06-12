# Guia de Instalação do Gabarito

Este documento é destinado ao **Implantador** responsável por instalar o sistema Gabarito em um novo servidor ou máquina cliente.

## 📋 Pré-requisitos (O que você precisa ter em mãos)

Antes de iniciar a instalação, certifique-se de ter as seguintes informações:

1. **IP do Servidor Firebird** (Ex: `127.0.0.1` ou `192.168.0.100`)
2. **Porta do Firebird** (Geralmente `3050`)
3. **Caminho exato do Banco de Dados** (O mesmo que você copiaria para o `Start.in`, ex: `C:\Sistemas\Banco\DADOS.FDB`)
4. **Token de Integração** (O `GABARITO_TOKEN` fornecido para este cliente)
5. **Caminho de instalação do Firebird** (Ex: `C:\Program Files\Firebird\Firebird_5_0`)

---

## 🚀 Passo a Passo da Instalação

A instalação foi projetada para ser o mais automatizada possível através do script **`EXECUTE_INSTALADOR.bat`**.

### Passo 1: Preparação
1. Copie o arquivo `Gabarito.zip` para a máquina de destino.
2. Extraia o conteúdo do `.zip` para uma pasta definitiva (ex: `C:\Administracao\Gabarito`).
3. Clique com o botão direito no arquivo **`EXECUTE_INSTALADOR.bat`** e escolha **"Executar como Administrador"**. *(Se não fizer isso, o script vai avisar e fechar)*.

### Passo 2: Execução do Instalador
O script de instalação possui 7 etapas automatizadas:

- **[PASSO 1/7] Instalação do Node.js:** 
  O instalador do Node.js (`node.msi`) abrirá automaticamente. Siga o assistente de instalação clicando em "Next" até o fim. *Se a máquina já tiver o Node atualizado, você pode fechar/cancelar o assistente.*

- **[PASSO 2/7] Instalando Dependências:**
  O script abrirá uma tela preta e começará a baixar as dependências (`npm install`). Isso pode demorar alguns minutos dependendo da internet.

- **[PASSO 3/7] Configuração do Ambiente (.env):**
  O terminal solicitará os dados de conexão que você separou nos pré-requisitos (IP, Porta, Caminho do Banco e Token). Digite cada um e aperte `Enter`.

- **[PASSO 4/7] Configuração do Firebird:**
  O sistema pedirá o **Caminho Completo da pasta do Firebird** (onde fica o `firebird.conf`). O script vai fazer um backup automático do arquivo e aplicar as configurações necessárias de rede e segurança (`AuthServer`, `WireCrypt`). Depois, perguntará se você deseja que o script reinicie o serviço do Firebird automaticamente (responda `S` para sim).

- **[PASSO 5/7] Scripts de Banco de Dados:**
  Uma nova tela de comando abrirá automaticamente (`criar_views_gabarito.bat`) para rodar os scripts SQL no banco de dados. Siga as instruções daquela tela e, quando ela fechar, volte para o instalador e aperte qualquer tecla para continuar.

- **[PASSO 6/7] Instalação do Serviço Windows:**
  O sistema registrará o Gabarito (nssm) como um serviço do Windows em segundo plano, para que ele inicie automaticamente com a máquina.

- **[PASSO 7/7] Abrindo Sistema Web:**
  O navegador abrirá automaticamente no endereço local (`http://localhost:3000`) confirmando que o sistema está no ar!

---

## 🛑 Resolução de Problemas Comuns

- **"O comando NPM não é reconhecido":** Se o Node.js acabou de ser instalado no Passo 1, o Windows pode ainda não ter atualizado as variáveis de ambiente. Feche o instalador e abra-o novamente como Administrador.
- **Firebird.conf não encontrado:** O caminho digitado no Passo 4 está incorreto. Vá no Disco `C:`, procure onde o Firebird foi instalado, copie o caminho da barra de endereços do Windows e cole no terminal clicando com o botão direito.
- **Serviço não instala:** Verifique se você executou o `EXECUTE_INSTALADOR.bat` como Administrador no Passo 1.
