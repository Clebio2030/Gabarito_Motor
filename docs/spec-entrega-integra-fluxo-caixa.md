# Spec — Entrega íntegra do fluxo de caixa (staging + swap verificado) e normalização

> Objetivo: garantir que o snapshot de contas a pagar/receber (e demais recursos)
> seja entregue **tudo-ou-nada** por CNPJ — a tabela viva nunca fica parcial e o
> truncamento silencioso vira impossível por construção.
>
> Contexto: contasPagar chegava truncado em múltiplos de 5000 em alguns CNPJs
> (FAROL 10.000) enquanto o Motor provadamente enviava o snapshot inteiro
> (`pagar=36322`, 8 lotes, todos 200 OK). Nem a query do Motor (sem LIMIT) nem o
> handler `/sync` (delete-`atual===1` + append, commit por chunk) explicam o corte
> na leitura do código — faltava **verificação de integridade fim-a-fim**.
>
> **Status:** contrato da Fase 1 acordado entre Motor e API (csdigitalz) em 2026-06-26.
> Esta versão incorpora os ajustes da API (snapshot_id, `sync_snapshot_state`, TTL de
> órfão, catálogo de erros, observabilidade).

Entrega em fases, deliberadamente desacopladas:

- **Fase 1 — Garantia de integridade.** Staging + swap atômico verificado por
  contagem, sobre o dado atual (gordo). Não toca na view nem no painel.
- **Fase 2 — Normalização do receber (proposta D).** Tira o fan-out (~78×).
- **Fase 3 — Atomicidade cross-recurso por CNPJ** (release commit). Só se virar
  necessidade real (ver fim do doc).

---

## FASE 1 — Garantia de integridade (staging + swap verificado)

### Princípio

O Motor para de escrever direto na tabela viva. Cada recurso é carregado numa
**tabela de staging** e só é promovido para a viva via **swap atômico**, e somente
se a contagem recebida bater com `expectedTotal`. Se não bater (ou se qualquer lote
falhar), o staging é descartado e a **tabela viva permanece intacta**.

Ganhos: viva nunca fica parcial; truncamento detectado por construção
(`count ≠ expectedTotal` → aborta com erro explícito); fim da leitura parcial
durante o ciclo; auto-cura mantido (reenvia no próximo ciclo).

### Contrato do payload (Motor → API)

Cada POST `/sync` carrega **exatamente um recurso × um CNPJ**, com `chunkInfo`
honesto daquele recurso, `expectedTotal` (total do recurso inteiro) e `snapshotId`:

```jsonc
{
  "syncMode": "incremental",
  "desde": "2026-04-01",
  "snapshotId": "8c5a5f54-3a18-4e7d-b8a7-2c3a1f5e6d9b", // uuid v4, igual em todos os chunks da entrega
  "chunkInfo": { "atual": 3, "total": 8 },              // lotes DESTE recurso (honesto)
  "expectedTotal": 36322,                               // congelado no chunk 1; idêntico em todos
  "registros": [
    { "cnpj": "30.602.288/0001-35", "contasPagar": [ /* até CHUNK_SIZE=5000 linhas */ ] }
  ]
}
```

**Constraints (a API rejeita com 400 se violadas):**
- `expectedTotal != null` exige `snapshotId` → senão `400 missing_snapshot_id`.
- Mais de um CNPJ em `registros[]`, ou mais de um campo de recurso no mesmo
  `registros[i]` → `400 multi_resource_payload`.
- `expectedTotal` diferente entre chunks da mesma entrega → `expected_total_changed_mid_stream`.

### Schema (lado API)

Tabelas de staging em schema segregado (DDL idêntica à viva + `snapshot_id uuid NOT NULL`):

```
sync_staging.relat_ctapagar_geral
sync_staging.relat_ctareceber_geral
sync_staging.relat_curva_abc
sync_staging.relat_entradas
sync_staging.relat_vendedores
sync_staging.relat_pedidos_horario
```

Controle/watermark (uma linha por `(cnpj, recurso)`, sem histórico):

```sql
CREATE TABLE sync_snapshot_state (
  cnpj            text        NOT NULL,
  recurso         text        NOT NULL,   -- 'contasPagar' | 'contasReceber' | ...
  snapshot_id     uuid        NOT NULL,
  expected_total  integer     NOT NULL,
  last_chunk      integer     NOT NULL,   -- maior atual já aplicado
  total_chunks    integer     NOT NULL,
  status          text        NOT NULL,   -- 'streaming' | 'awaiting_swap' | 'swapped' | 'failed'
  started_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  swapped_at      timestamptz,
  rows_in_staging integer,
  PRIMARY KEY (cnpj, recurso)
);
CREATE INDEX ON sync_snapshot_state (updated_at) WHERE status = 'streaming';
```

### Ciclo de vida por `(cnpj, recurso)`

**No `atual === 1`:**
- Existe estado com **outro** `snapshot_id` em `streaming`/`awaiting_swap` → trunca o
  staging antigo e **começa nova entrega** (substituição explícita).
- Mesmo `snapshot_id` em `streaming` → **idempotente, ignora** (retry).
- Caso novo → cria estado, `last_chunk = 1`, insere o chunk no staging.

**No `1 < atual < total`:**
- `snapshot_id` diferente do registrado → `snapshot_mismatch` (Motor reseta a entrega).
- mesmo `snapshot_id`, `atual === last_chunk` → idempotente, ignora (retry).
- mesmo `snapshot_id`, `atual > last_chunk + 1` → `chunk_gap` (lote perdido; reseta).
- mesmo `snapshot_id`, `atual === last_chunk + 1` → **append** no staging, `last_chunk = atual`.

**No `atual === total` (swap, uma transação por recurso, com advisory lock):**

```sql
BEGIN;
  SELECT pg_advisory_xact_lock(hashtext(cnpj || ':' || recurso));

  -- verificação
  SELECT COUNT(*) INTO actual FROM sync_staging.relat_ctapagar_geral
    WHERE cnpj = $1 AND snapshot_id = $2;
  IF actual <> expected_total THEN
    DELETE FROM sync_staging.relat_ctapagar_geral WHERE cnpj=$1 AND snapshot_id=$2;
    UPDATE sync_snapshot_state SET status='failed' WHERE cnpj=$1 AND recurso=$2;
    ROLLBACK;            -- retorna count_mismatch; viva intacta
  END IF;

  -- swap
  DELETE FROM relat_ctapagar_geral WHERE cnpj = $1;
  INSERT INTO relat_ctapagar_geral
    SELECT ... FROM sync_staging.relat_ctapagar_geral WHERE cnpj=$1 AND snapshot_id=$2;
  DELETE FROM sync_staging.relat_ctapagar_geral WHERE cnpj=$1 AND snapshot_id=$2;
  UPDATE sync_snapshot_state SET status='swapped', swapped_at=now()
    WHERE cnpj=$1 AND recurso=$2;
COMMIT;
```

Advisory lock por `(cnpj, recurso)` serializa entregas concorrentes do mesmo par;
CNPJs e recursos distintos seguem em paralelo. Swap de ~390k linhas estimado em
1–2s em SSD. Recurso de um lote só (`total === 1`): `atual===1 && atual===total`.

### Resposta (último lote)

Sucesso:
```jsonc
{
  "ok": true,
  "snapshotId": "8c5a5f54-...",                 // ecoado p/ o Motor casar com o stream
  "persisted": {
    "contasPagar": { "total": 36322, "previousTotal": 35891, "swappedAt": "2026-06-26T19:42:11.034Z" }
  }
}
```

Erro:
```jsonc
{ "ok": false, "snapshotId": "8c5a5f54-...", "motivo": "count_mismatch", "recebido": 35000, "esperado": 36322 }
```

Catálogo de `motivo`: `count_mismatch`, `snapshot_mismatch`, `chunk_gap`,
`multi_resource_payload`, `expected_total_changed_mid_stream`, `missing_snapshot_id`.

### Bordas operacionais (obrigatórias antes do ship)

1. **TTL de staging órfão.** Se o Motor cair entre chunks, o staging fica vivo.
   - API: cron horário apaga `status='streaming' AND updated_at < now() - interval '6 hours'` (configurável).
   - Motor: descarta entregas inacabadas e reabre com `snapshotId` novo no ciclo
     seguinte (na prática, **cada ciclo gera um snapshotId novo** por recurso, então
     o `atual===1` já reseta o staging anterior — não há entrega "pendurada" do lado
     do Motor).
2. **`expectedTotal` congelado.** Carimbado no chunk 1; mudou nos seguintes →
   `expected_total_changed_mid_stream`. O Motor trava o número no início da entrega.
3. **Ordem dos chunks.** O Motor garante ordem estrita (envia `N+1` só após `200` em
   `N`) por `(cnpj, recurso, snapshotId)`. A API pode assumir ordem.
4. **Feature flag de rollback (API).** `STAGING_SWAP_ENABLED`. Desligada, o handler
   trata payloads **com** `expectedTotal` pelo caminho legado (delete+append,
   ignorando `expectedTotal`/`snapshotId`). Permite reverter sem hotfix.
5. **Observabilidade (API).** Log estruturado por swap
   `{ snapshot_id, cnpj, recurso, expected_total, actual_total, previous_total, swap_duration_ms, status }`
   e endpoint read-only `GET /api/v1/sync/snapshot-state?cnpj=...` (atrás do token)
   para o Motor diagnosticar estado.
6. **Constraint um-recurso-um-cnpj.** Ver "Constraints" acima — é o que mantém o
   `snapshotId` não-ambíguo no staging.
7. **Idempotência do retry do chunk de swap.** O `enviarSync` reenvia o **mesmo**
   chunk em timeout, e o lote `atual===total` é justamente o mais lento (faz o swap).
   Se o swap concluir mas a resposta se perder, o Motor reenvia o último chunk com o
   mesmo `(cnpj, recurso, snapshotId)`, agora em `status='swapped'` e staging vazio.
   A API **não** pode reprocessar ingenuamente (apenderia o chunk num staging vazio →
   `count` parcial → `count_mismatch` falso, disparando reenvio inteiro
   desnecessário). **Regra:** ao receber qualquer chunk de um `(cnpj, recurso,
   snapshotId)` já em `status='swapped'`, devolver **idempotente** o mesmo
   `{ ok:true, persisted }` do swap original (sem tocar viva nem staging). O mesmo
   vale para `status='failed'` por `count_mismatch`: retorno idempotente do erro.

### Mudanças no Motor (lado nosso) — implementadas, atrás de flag

Flag `GABARITO_EXPECTED_TOTAL` (`SEND_EXPECTED_TOTAL`). **Off = comportamento legado
byte-a-byte.** O protocolo só se aplica aos **6 recursos stagingáveis**
(`RECURSOS_STAGING`: contasPagar, contasReceber, curvaAbc, entradas, vendedores,
pedidosHorario). **`faturamentoMensal` fica de fora** (a API não tem staging dele e
rejeitaria com `400 multi_resource_payload`) — segue sempre legado. On, em
`enviarRecurso(...)`:
- Gera `snapshotId = crypto.randomUUID()` por entrega de `(cnpj, recurso)`; repete em
  todos os lotes.
- `expectedTotal = registros.length` congelado no início.
- Envia em ordem estrita (await por lote) — `N+1` só após resposta de `N`.
- **Fail-fast** ao primeiro lote que falhar (aborta o recurso; hash não é salvo).
- No último lote, valida `persisted[recurso].total === expectedTotal`; divergência →
  falha o recurso (não salva hash) e loga. Loga também o delta vs `previousTotal`.
- `enviarSync` agora devolve `{ ok, persisted }` (lê `response.data.persisted`).

`backend/src/gabarito-motor/index.js` (helper `enviarRecurso`, loop incremental e
loop base do full) e `backend/src/gabarito-motor/sender.js` (retorno do `enviarSync`).

### Recurso vazio (Fase 1.1, não bloqueante)

Hoje o Motor omite o campo quando vazio e a API não apaga (recurso que encolhe p/ 0
deixa dado velho preso). Plano: pagar/receber enviam 1 lote com `expectedTotal:0` e
array vazio → API trunca staging, `count=0===0`, swap → viva esvaziada. Deixado fora
da Fase 1 para não acoplar; o caso "CNPJ sem dados nenhum" continua no caminho legado
(payload multi-recurso vazio, sem `expectedTotal`).

### Rollout

Deploy **API primeiro, Motor depois**:
- API entende os dois formatos: **com** `expectedTotal`(+`snapshotId`) → staging+swap;
  **sem** `expectedTotal` → legado. Convive com o Motor antigo.
- Depois liga-se `GABARITO_EXPECTED_TOTAL=true` no Motor.
- Reversível dos dois lados: flag no Motor (para de enviar `expectedTotal`) e
  `STAGING_SWAP_ENABLED` na API.

---

## FASE 2 — Normalização do receber (proposta D)

> Só depois da Fase 1 estável. **Reabre duas decisões antes firmes** ("não mexer no
> JOIN da view" e "não enviar menos"): a redução de volume só é segura **se o painel
> for retrabalhado para reconstruir o por-item**. D **não é** o dedup vetado — a
> granularidade por item é preservada numa tabela lateral e reconstruída na leitura.

### Problema
A view de receber faz `LEFT JOIN SAIDAESTOQUE` e explode cada recebível em ~78 linhas
(1 por item), diferindo só em `dtSaida`/`vendedor`. ~5k recebíveis → ~390k linhas.

### Modelo normalizado
- `ctareceber` (uma linha por `cnpj + nrdoc + parcela`): campos que não dependem do item.
- `ctareceber_itens` (N por recebível): FK para o recebível + `dtSaida`, `cdVendedor`, …
  (a chave exata precisa ser confirmada contra o schema do ERP).

### Envio / leitura / migração
- Motor: dois streams (recebíveis + itens), cada um com staging+swap da Fase 1. O
  **swap das duas tabelas deve ser atômico em conjunto** (recebível e seus itens numa
  transação) — maior ponto de cuidado da fase.
- Painel: troca `DISTINCT ON` por `JOIN` simples onde mostra por-item; totais somam
  direto sobre `ctareceber`.
- Migração: o próximo full-replace popula o modelo novo (é snapshot completo).

Ganho: receber ~390k → ~5k; staging/contagem/swap triviais; full-replace horário
volta a ser barato sem perder auto-cura.

---

## FASE 3 — Atomicidade cross-recurso por CNPJ (futuro, sob demanda)

Hoje os relatórios leem `latest(data_referencia)` por recurso independentemente —
durante a janela entre o swap de pagar e o de receber, um relatório pode ver
"contasPagar nova × contasReceber velha". Aceitável para a maioria. Se virar
problema: um "release commit" que só promove o snapshot de um CNPJ quando **todos**
os seus recursos swaparam. Fora do escopo agora.

---

## Decisões em aberto / próximos passos

1. **API:** implementar Fase 1 (staging, `sync_snapshot_state`, swap com lock, TTL
   cron, `persisted` enriquecido, `STAGING_SWAP_ENABLED`, log estruturado, endpoint
   `snapshot-state`). Estimativa da API: 3–4 dias impl + 1–2 dias teste em staging.
2. **Motor:** já implementado atrás de flag; falta ligar `GABARITO_EXPECTED_TOTAL`
   após o deploy da API, e teste com payload real em staging.
3. **Fase 1.1:** recurso vazio que limpa a viva (`expectedTotal:0`).
4. **Fase 2:** confirmar reabertura da view/painel e a chave do recebível.
