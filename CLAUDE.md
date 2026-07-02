# Gabarito — instruções para IA (Claude e demais)

Este repo é o **Motor Gabarito**: serviço Node.js que roda na máquina de cada cliente,
lê o ERP (Firebird local) e envia KPIs pra API central via `POST /sync`.

## ⚠️ LEIA PRIMEIRO — obrigatório antes de mexer no Motor

Antes de propor ou fazer qualquer mudança, leia:

1. **[docs/motor-arquitetura.md](docs/motor-arquitetura.md)** — o que é o Motor,
   componentes, env vars (com defaults), estado, updater, ciclo de sync.
2. **[docs/motor-boas-praticas.md](docs/motor-boas-praticas.md)** — como construir pra
   escala. **Toda mudança tem que passar no checklist do fim desse doc.**

Contexto da entrega íntegra do `/sync` (staging + swap):
[docs/spec-entrega-integra-fluxo-caixa.md](docs/spec-entrega-integra-fluxo-caixa.md) e
[docs/arquitetura-entrega-integra-antes-depois.md](docs/arquitetura-entrega-integra-antes-depois.md).

## Princípios não-negociáveis (resumo — detalhes nos docs)

- **Escala: sempre pense em 100+ clientes, zero trabalho manual por máquina.** Config de
  frota **nunca** via `.env` manual (ele é preservado e não atualiza) — use **default no
  código** ou **toggle server-side** (a API decide por-CNPJ). O `.env` é só pra
  credenciais/token/caminho locais.
- **Sem perda de dado.** "A qualidade é o dado." Falha tem que ser fail-safe: nunca deixar
  estado parcial visível nem descartar linha. Idempotência e auto-cura em tudo.
- **Nunca confie só no `200`.** Verifique a entrega fim-a-fim (`expectedTotal` + `persisted`).
- **Retrocompatibilidade + canário.** Motor e API atualizam em ritmos diferentes; payload
  novo tem que ser inofensivo pra versão antiga. Valide num CNPJ antes da frota.
- **Observável de fora.** Diagnóstico sem RDP: logs estruturados, echo de contagem,
  endpoint `snapshot-state`.

## Fluxo de release (não faça manual em cliente)

- Código muda na frota via **release no GitHub** (`Clebio2030/Gabarito_Motor`,
  `releases/latest`); os clientes puxam pelo updater (08h/19h). Convenção: commit
  `chore(release): vX.Y.Z` bumpa `updater/version.json`.
- Ativação de comportamento por-cliente = **toggle server-side na API**, não `.env`.

## Ao trabalhar aqui

- O `.env` e `sync_state.json` de cada cliente são **preservados** no update — não
  dependa deles pra propagar mudança.
- Rode os testes do Motor: `cd backend && node --test src/gabarito-motor/*.test.js`.
- Trabalho de encoding (WIN1252/OCTETS) e de entrega íntegra são trilhas distintas — não
  misture num mesmo commit/release.
