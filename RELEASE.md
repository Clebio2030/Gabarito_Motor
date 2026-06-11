# Como publicar um release do Gabarito Motor

## Como funciona (visão geral)

O cliente roda um **updater** (tarefa agendada do Windows, diária às 19:00) que:

1. Consulta a **última release** no GitHub (`Clebio2030/Gabarito_Motor`)
2. Compara a versão da release com a versão local (`updater/version.json`)
3. Se houver versão nova: baixa o código, faz backup, para o serviço, **substitui os arquivos**, **reaplica as views** (`sql/criar_views_gabarito.sql`), sobe o serviço e valida o health check
4. Se o health check falhar → **rollback automático** (restaura o backup)

> A **versão** vem da **tag da release no GitHub** — NÃO do `version.json` (esse é só estado local do cliente, atualizado após cada update).

---

## Passo a passo para subir uma versão nova

### 1. Código no `master`
- Commit e push das mudanças para `master`.
- **Não commitar** arquivos de runtime: `Gabarito.zip`, `updater/version.json`, `backend/sync_state.json`, `backend/logs/`.

### 2. Criar e enviar a tag (semver, maior que a atual)
Veja a última versão em https://github.com/Clebio2030/Gabarito_Motor/releases e incremente:

```bash
git tag -a v1.5.6 -m "v1.5.6"
git push origin v1.5.6
```

Formato: `vMAJOR.MINOR.PATCH` (ex.: `v1.5.6`).

### 3. Publicar a Release (é isso que o updater enxerga — tag sozinha NÃO basta)

**Opção A — navegador (mais simples):**
1. Abra `https://github.com/Clebio2030/Gabarito_Motor/releases/new?tag=v1.5.6`
2. Title: `v1.5.6`
3. Cole as notas da versão
4. Clique **Publish release**

**Opção B — por API/script:**
```bash
node updater/temp/mkrelease.js   # ajuste a versao dentro do script antes
```

> **Não precisa anexar um `.zip`.** O updater usa o *zipball* (código do tag) quando não há asset. Se quiser, pode anexar um `Gabarito.zip` — ele tem prioridade sobre o zipball.

### 4. Aplicar no cliente
- Espere a tarefa diária (19:00), ou force agora:
  ```bat
  schtasks /run /tn "GabaritoUpdater"
  ```
- Acompanhe em `updater/updater.log` e confira `updater/version.json` (`lastStatus` deve virar `ok`).

---

## Referência rápida

| Item | Detalhe |
|---|---|
| Repositório | `Clebio2030/Gabarito_Motor` |
| Origem da versão | tag da release no GitHub |
| Arquivos sincronizados (managedPaths) | `backend`, `sql`, `*.bat` |
| Preservados no cliente (preservePaths) | `.env`, `config.json`, `sync_state.json`, `logs`, `node_modules`, `updater`, `.git` |
| Views reaplicadas no update | `sql/criar_views_gabarito.sql` (Firebird do cliente) |
| `sql/criar_tabelas_servidor.sql` | Só referência — o servidor usa Prisma; não é executado |
| Token para publicar via API | `updater/secrets.json` (`githubToken`, gitignored) |

## Ambiente sem acesso à API do GitHub
Se a rede bloquear `api.github.com` (git/push funcionam, mas a API não), faça o **push e a tag** normalmente e **publique a Release pelo navegador** (Opção A). Só a criação do objeto Release precisa da API.
