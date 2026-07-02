# O Motor Gabarito — arquitetura e inventário

> O que é, do que é feito, como é configurado, como atualiza e como roda. Fonte da
> verdade pra qualquer um que precise operar ou evoluir o Motor.
>
> Objetivo de design: **rodar em escala (meta: 100+ clientes) com zero trabalho
> manual por cliente.** Ver [motor-boas-praticas.md](./motor-boas-praticas.md).

## O que é

O **Motor** é um serviço Node.js que roda **na máquina de cada cliente**, lê os KPIs
do ERP (Firebird local) e envia pra API central (`gabarito.csdigitalz.com.br`) via
`POST /sync`. Um Motor por cliente; cada Motor atende os CNPJs do grupo daquele
cliente (resolvidos via `GET /companies` pelo `GABARITO_TOKEN`).

```
  Cliente (Windows)                                   Nuvem
 ┌─────────────────────────────┐                 ┌──────────────────────┐
 │ Serviço "Gabarito" (NSSM)   │  GET /companies │                      │
 │  └ backend (Express+cron)   │ ───────────────>│   API csdigitalz     │
 │     └ Motor (gabarito-motor)│  POST /sync     │   (Postgres +        │
 │        └ lê Firebird local  │ ───────────────>│    dashboard/painel) │
 │ Task "GabaritoUpdater"      │                 │                      │
 │  └ auto-update do GitHub    │                 └──────────────────────┘
 └─────────────────────────────┘
```

## Componentes (código)

Tudo em `backend/src/`:

| Arquivo | Papel |
|---|---|
| `gabarito-motor/index.js` | Orquestrador. Cron (08h–22h/hora), ciclo por CNPJ, hash-dedup, envio por recurso, bootstrap. |
| `gabarito-motor/extractor.js` | Extração das views Firebird (`GABARITO_*`) + decode WIN1252 dos textos. |
| `gabarito-motor/sender.js` | HTTP client: `GET /companies`, `POST /sync` com retry (5×, respeita `retry_after`). |
| `gabarito-motor/firebird.js` | Pool de conexões Firebird (`FB_POOL_SIZE`), timeout por query. |
| `gabarito-motor/syncState.js` | Estado por CNPJ em `sync_state.json`: hash (dedup) + watermark de carga histórica (`fullSyncedResources`). |
| `gabarito-motor/migrations.js` | `runDatabaseMigrations()` — aplica/atualiza as views (`CREATE OR ALTER VIEW`). |
| `gabarito-motor/*.test.js` | Testes (`node --test`). |
| `server.js` | Express: `/health`, autentica `/companies` interno, e `require('./gabarito-motor')` sobe o Motor. |
| `logger.js` | `logInfo/logWarn/logError`. |
| `setup-env.js` | Gera/atualiza o `.env` **na instalação** (só um conjunto fixo de chaves). |

## Configuração — variáveis de ambiente (`backend/.env`)

> ⚠️ O `.env` é **preservado** pelo updater (nunca sobrescrito). `setup-env.js` só
> mexe nele **na instalação** e só num conjunto fixo de chaves. **Config nova NÃO
> chega à frota via update** — ver a boa prática de escala.

**Firebird (por máquina):**

| Var | Default | Uso |
|---|---|---|
| `FB_HOST` / `FB_PORT` | `127.0.0.1` / `3050` | conexão |
| `FB_DATABASE` | — (obrigatório) | caminho do `.FDB` |
| `FB_USER` / `FB_PASSWORD` | `SYSDBA` / `masterkey` | credenciais |
| `FB_CHARSET` | `WIN1252` | charset da base |
| `FB_POOL_SIZE` | `3` | conexões no pool |
| `FB_QUERY_TIMEOUT` | `300000` | timeout por query (ms) |

**Gabarito:**

| Var | Default | Uso |
|---|---|---|
| `GABARITO_TOKEN` | — (obrigatório) | token de integração (identifica o cliente/grupo) |
| `GABARITO_API_URL` | `…/api/v1/sync` | endpoint do sync |
| `GABARITO_COMPANIES_URL` | `…/api/v1/companies` | lista de CNPJs ativos |
| `GABARITO_VERSION` | `1.0.0` | `sourceVersion` no payload (rótulo). **Hoje fica estagnado — ver boas práticas.** |
| `GABARITO_RUN_ON_START` | `true` | roda um ciclo no boot |
| `GABARITO_CRON_MODE` | `prod` | `prod` = 08h–22h/hora; `test` = todo minuto |
| `GABARITO_HTTP_TIMEOUT` | `120000` | timeout do POST /sync (ms) |
| `GABARITO_EXPECTED_TOTAL` | **on** (`!== 'false'`) | Fase 1 entrega íntegra: manda `expectedTotal`+`snapshotId`. Escape hatch: `=false`. |
| `GABARITO_DISABLE_BOOTSTRAP` | — | `true` pula cron/migrations (só testes) |
| `GABARITO_STATE_FILE` | `../../sync_state.json` | caminho do estado (testável) |
| `PORT` | `3001` | porta do Express |

## Estado (arquivos preservados no update)

| Arquivo | Conteúdo |
|---|---|
| `backend/sync_state.json` | Por CNPJ: `{ hash, lastSyncedAt, fullSyncedResources[] }`. Dedup + watermark de backfill. |
| `backend/.env` | Config da máquina (acima). |
| `backend/config.json` | Config auxiliar (preservada). |
| `backend/logs/` | Logs. |

## Atualização (updater)

- Config em `updater/updater-config.json`; código em `updater/updater.js`.
- **Fonte:** `releases/latest` de `github.com/Clebio2030/Gabarito_Motor` (zip asset ou zipball da tag).
- **Sincroniza** (`managedPaths`): `backend`, `sql`, e os `.bat` de instalação.
- **Preserva** (`preservePaths`): `backend/.env`, `backend/config.json`,
  `backend/sync_state.json`, `backend/logs`, `backend/node_modules`, `.git`.
- **Agenda:** task `GabaritoUpdater` roda **08:00 e 19:00**.
- **Segurança:** backup antes, health-check (`http://127.0.0.1:3001/health`),
  rollback automático se o serviço não sobe saudável.
- **`updater/version.json`** = estado local do updater (`currentVersion`,
  `lastReleaseTag`). **Não é distribuído** aos clientes; cada máquina tem o seu, e o
  updater o reescreve após atualizar. A versão real do código = essa `currentVersion`
  (NÃO o `GABARITO_VERSION` do `.env`).
- **`updater/secrets.json`** (`githubToken`) só existe na **máquina de release/dev** —
  serve pra publicar releases, não roda no cliente.

## Ciclo de sync (por disparo do cron)

1. `GET /companies` → CNPJs ativos do token.
2. Mapeia CNPJ → `IDEMPRESA` (query no Firebird).
3. Por CNPJ: extrai as views (`faturamento, contasPagar, contasReceber, curvaAbc,
   entradas, vendedores, pedidosHorario`).
   - 1ª vez (sem `lastSyncedAt`) → **full sync** (janela 3 anos, curva em streaming/ano).
   - Depois → **incremental** (janela 3 meses; recurso novo sem histórico faz backfill
     de 3 anos 1× via watermark `fullSyncedResources`).
4. **Hash-dedup:** se o dataset completo não mudou, pula o envio (a menos que haja
   backfill pendente).
5. **Envio por recurso** (`enviarRecurso`): cada recurso é seu próprio stream de
   lotes (`CHUNK_SIZE=5000`) com `chunkInfo` honesto. Com a entrega íntegra ligada,
   leva `expectedTotal`+`snapshotId` (ver [spec-entrega-integra-fluxo-caixa.md](./spec-entrega-integra-fluxo-caixa.md)).
6. Sucesso em tudo → salva o hash (próximo ciclo detecta só mudanças).

## Contrato com a API

- **Recursos stagingáveis** (entrega íntegra): `contasPagar, contasReceber, curvaAbc,
  entradas, vendedores, pedidosHorario`. `faturamentoMensal` **não** (segue legado).
- Ativação da entrega íntegra é **por-CNPJ, controlada pela API** (toggle
  `Company.stagingSwapEnabled`) + kill switch global `STAGING_SWAP_ENABLED`.
- Docs do contrato: [spec-entrega-integra-fluxo-caixa.md](./spec-entrega-integra-fluxo-caixa.md),
  [arquitetura-entrega-integra-antes-depois.md](./arquitetura-entrega-integra-antes-depois.md).

## Serviços no Windows

| Nome | O quê |
|---|---|
| `Gabarito` (NSSM) | Roda `node backend/src/server.js` — Express + Motor. |
| `GabaritoUpdater` (Task Scheduler) | Roda o updater às 08:00 e 19:00. |
