# Motor Gabarito — boas práticas (escala para 100+ clientes)

> Toda decisão do Motor assume **um parque de 100+ clientes, cada um numa máquina que
> ninguém acessa no dia a dia.** A pergunta que valida qualquer mudança é:
> **"como isso se comporta e se controla em 100 clientes, sem trabalho manual por
> máquina?"** Se a resposta envolve "entrar em cada cliente e editar/rodar algo", está
> errado.

Inventário do Motor: [motor-arquitetura.md](./motor-arquitetura.md).

---

## 1. Config de frota NUNCA depende de editar o `.env` por cliente

**Por quê:** o `.env` é **preservado** pelo updater — ele nunca é sobrescrito num
update. `setup-env.js` só o toca **na instalação** e só num conjunto fixo de chaves.
Logo, **uma variável nova não chega à frota via update.** Depender do `.env` pra
mudar comportamento = visitar 100 máquinas. Não escala.

**Hierarquia de como controlar comportamento (preferência de cima pra baixo):**

1. **Default no código** — o comportamento novo já vem certo no release; zero `.env`.
   *Exemplo real:* `GABARITO_EXPECTED_TOTAL` é **default-on** (`!== 'false'`). Ninguém
   precisou editar `.env`; o release ligou pra todos. O `.env` vira só **escape hatch**
   (`=false`) pra desligar um cliente específico em emergência.
2. **Server-driven (a API decide)** — quando a ativação precisa ser por-cliente/por-CNPJ
   e mudar sem novo release. *Exemplo real:* o toggle `Company.stagingSwapEnabled` — a
   API liga a entrega íntegra por CNPJ, com 1 clique no admin, sem tocar em nenhum Motor.
   Candidato natural pra isso: qualquer flag que você queira ligar/desligar por cliente
   em tempo real (ex.: incluir isso no payload de `GET /companies`).
3. **Gerenciado pelo updater** — só se realmente precisar viver no cliente. Aí a chave
   entra via migração de config no updater/`setup-env.js` (adiciona/atualiza a chave no
   `.env` de forma idempotente no update), **nunca** manualmente.

**Reserve o `.env` só pra o que é genuinamente local e imutável:** credenciais e caminho
do Firebird, token do cliente, porta. Nada que você queira mudar "pra todos" depois.

## 2. Zero trabalho manual por cliente

Rollout e operação se fazem por **release (código)** e **toggles server-side**, não por
RDP/SSH em máquina. Se um procedimento diz "vá na máquina X e faça Y", ele não sobrevive
a 100 clientes. Automatize (updater, admin, API) ou repense.

*Anti-exemplo a evitar:* pedir pra adicionar `GABARITO_EXPECTED_TOTAL=true` cliente a
cliente — foi por isso que fizemos default-on no código.

## 3. `sourceVersion` (e afins) devem ser DERIVADOS, não digitados

**Por quê:** `GABARITO_VERSION` vive no `.env` preservado e por isso está **estagnado em
`1.0.0`** na frota — o payload mente sobre a versão do Motor, e a API não consegue saber
quem roda o quê. É o sintoma clássico do item 1.

**Recomendação:** derivar a versão em runtime do que o updater controla (ex.:
`updater/version.json.currentVersion` ou o `package.json`), não de uma env digitada. Aí
o `sourceVersion` no payload é sempre verdadeiro, sem manutenção manual.

## 4. Nunca confie só no `200` — verifique a entrega fim-a-fim

**Por quê:** um `200 OK` prova "recebi", não "gravei inteiro". O bug do FAROL (contas a
pagar truncadas) passou despercebido justamente por confiar no `200`.

**Como:** o Motor declara `expectedTotal`; a API confere a contagem e devolve `persisted`;
o Motor valida. Divergência vira erro explícito, não perda silenciosa. Ver
[spec-entrega-integra-fluxo-caixa.md](./spec-entrega-integra-fluxo-caixa.md).

## 5. Sem perda de dado — falha tem que ser fail-safe

**Regra inegociável:** "a qualidade é o dado". Nenhuma otimização pode descartar linha nem
deixar o estado pela metade.

**Como:** o swap da entrega íntegra só troca a tabela viva **se a contagem bater**; senão,
mantém a versão completa anterior intacta e o Motor reenvia. Estado nunca fica parcial
visível. Full-replace por ciclo é **auto-curante** (idempotente): reenviar conserta drift.

## 6. Idempotência e auto-cura em tudo

- Envio de snapshot = **replace idempotente** (delete-região + insert), não append cego.
- Retries seguros: o mesmo lote reenviado não duplica (watermark de chunk / `snapshotId`
  na API).
- **Migrations idempotentes E não-concorrentes.** *Contra-exemplo atual:* `runDatabaseMigrations()`
  é chamado 2× no boot (RUN_ON_START + incondicional) → deadlock de metadata do Firebird
  nas views a cada restart. Benigno (view é `CREATE OR ALTER`), mas é ruído e precisa
  rodar **uma vez só**. Migração nunca deve correr contra si mesma.

## 7. Compatibilidade retroativa + rollout em duas pontas

**Por quê:** Motor e API atualizam em ritmos diferentes (updater 08h/19h vs deploy da API).
Um payload novo tem que ser inofensivo pra API antiga e vice-versa.

**Como:** a API entende os **dois formatos** (com/sem `expectedTotal`) durante a transição;
campo novo ausente → caminho legado, sem erro. Suba a API primeiro, o Motor depois.

## 8. Canário antes da frota — e controlado do servidor

**Por quê:** a primeira vez que um caminho novo roda de verdade não pode ser em 100
clientes ao mesmo tempo.

**Como:** ative por **um CNPJ** (toggle server-side), valide 1–2 ciclos, expanda. O
default-on no Motor é seguro porque a **ativação real** é o toggle por-CNPJ da API — o
código pode estar em todos, ligado em um só.

## 9. Observabilidade sem entrar na máquina

**Por quê:** com 100 clientes, você não vai ler log por RDP. O diagnóstico tem que chegar
até você.

**Como:** logs estruturados; a API **ecoa a contagem gravada** (`persisted`) na resposta,
então o próprio log do Motor mostra "gravei N (esperado N)"; endpoint read-only
`GET /sync/snapshot-state?cnpj=` pra inspecionar estado sem tocar no cliente. Se um recurso
truncar, tem que **aparecer**, não sumir.

## 10. Limites de recurso são de primeira classe

Uma máquina de cliente é modesta e o volume varia muito (receber já passou de 390k linhas).

- **Chunking** (`CHUNK_SIZE=5000`) em todo envio.
- **Streaming** no full-sync (curva ano a ano) pra não estourar memória.
- **Pool** de conexões Firebird (`FB_POOL_SIZE`) + timeout por query.
- **Janela** (3 meses incremental / 3 anos backfill 1×) pra não reprocessar o mundo todo
  ciclo.
- Cuidado com o custo **na API também**: full-replace por hora × 100 clientes é carga real
  — a entrega íntegra (staging+swap) e, no futuro, a normalização do fan-out de receber
  (~78×) endereçam isso. Ver Fase 2 da spec.

---

## Checklist rápido pra qualquer mudança no Motor

- [ ] Se muda comportamento na frota: chega via **release (default no código)** ou
      **toggle server-side** — **não** via `.env` manual?
- [ ] O procedimento de rollout/rollback é **sem entrar em máquina de cliente**?
- [ ] Falha é **fail-safe** (não perde dado, não deixa estado parcial visível)?
- [ ] É **idempotente** (reexecutar/reenviar não duplica nem corrompe)?
- [ ] É **retrocompatível** com a API/Motor da versão anterior durante o rollout?
- [ ] Dá pra **validar num canário** (1 CNPJ) antes da frota?
- [ ] O resultado é **observável de fora** (log/echo/endpoint), sem RDP?
- [ ] Respeita **limites de recurso** (memória/tempo/carga na API) em volume alto?
