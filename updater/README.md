# updater

Pasta reservada para o atualizador separado do projeto Gabarito.

## Objetivo
- verificar nova versão publicada
- baixar pacote da release
- parar o serviço principal
- atualizar arquivos
- executar SQL das views/migrations
- subir o serviço novamente
- validar health check

## Fluxograma

```text
[Início - tarefa agendada 1x por dia]
                |
                v
[Verifica versão local atual]
                |
                v
[Consulta última release no GitHub]
                |
                v
{Existe nova versão?}
        |                |
       Não              Sim
        |                |
        v                v
   [Encerra]      [Baixa pacote .zip]
                           |
                           v
                  [Valida pacote / versão]
                           |
                           v
                     [Faz backup]
                           |
                           v
                [Para serviço Gabarito]
                           |
                           v
                  [Atualiza arquivos]
                           |
                           v
              [Executa SQL das views]
                           |
                           v
               [Inicia serviço Gabarito]
                           |
                           v
                 [Testa endpoint health]
                           |
                           v
                  {Health check OK?}
                      |           |
                     Sim         Não
                      |           |
                      v           v
            [Grava nova versão] [Rollback]
                      |           |
                      v           v
                 [Fim OK]   [Restaura backup]
                                  |
                                  v
                        [Sobe serviço novamente]
                                  |
                                  v
                           [Fim com erro]
```

## Arquivos da pasta
- `updater.js`: script principal do atualizador
- `updater-config.json`: configuração do GitHub, serviço e caminhos
- `version.json`: versão local instalada e status do último update

## Como testar agora
1. Ajuste `updater-config.json` se o repositório mudar ou se usar token GitHub.
2. Rode no prompt, na raiz do projeto:
   - `node updater\updater.js --check-only`
3. Para forçar uma atualização manual:
   - `node updater\updater.js --force`

## Observações importantes
- Nesta primeira versão, o updater **não atualiza a própria pasta `updater`**.
- Ele preserva arquivos locais do cliente, como `.env`, `config.json`, `sync_state.json`, `logs` e `node_modules`.
- As views são reaplicadas automaticamente usando `sql/criar_views_gabarito.sql`.

## Como instalar no Windows

Para este projeto, o ideal é **não rodar o updater como serviço residente**.
Como ele verifica atualização só 1 vez por dia, o melhor é usar **Tarefa Agendada do Windows**.

Essa tarefa é instalada automaticamente pelo instalador completo ou pelo instalador do serviço:\n\n```bat\ninstalador.bat\n```\n\nou:\n\n```bat\ninstalar_servico.bat\n```

Isso instala:
- Serviço do Windows: `Gabarito`
- Tarefa diária: `GabaritoUpdater`
- Horário do atualizador: `19:00`
- Conta da tarefa: `SYSTEM`

### Rodar o atualizador manualmente agora
```bat
schtasks /run /tn "GabaritoUpdater"
```

### Remover serviço e atualizador
```bat
deletar_servico.bat
```

## Resumo prático
- **Gabarito**: roda como serviço do Windows
- **Updater**: é instalado pelo `instalador.bat`/`instalar_servico.bat` e roda como tarefa agendada 1x por dia


