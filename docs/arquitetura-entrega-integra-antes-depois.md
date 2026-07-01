# Entrega íntegra do fluxo de caixa — explicação antes/depois (para leigos)

> Companion da spec técnica [`spec-entrega-integra-fluxo-caixa.md`](./spec-entrega-integra-fluxo-caixa.md).
> Aqui é a versão "parede de recados" — o porquê, sem jargão.

## As peças (em 1 frase cada)

- **Motor** = programa que roda **na loja do cliente**, lê as contas no sistema dele
  (Firebird) e manda pela internet.
- **API / Servidor** = recebe esses dados e guarda num banco que alimenta o Painel.
- **Painel** = a tela que o cliente olha (fluxo de caixa, contas a pagar/receber).

Analogia: é como atualizar um **mural de recados** numa parede pública. O Motor é o
entregador; a API é o funcionário que cola os recados; o Painel é o cliente olhando.

---

## ANTES

```
  LOJA (Motor)                  INTERNET            SERVIDOR (API)              PAINEL
 ┌────────────┐                                   ┌──────────────────┐
 │ lê 36.322  │  lote 1 (5000) ─POST─► 200 OK ──► │ APAGA a parede   │
 │ contas a   │  lote 2 (5000) ─POST─► 200 OK ──► │ e vai colando os │ ──►  cliente
 │ pagar      │      ...                          │ recados DIRETO   │      vê a
 │            │  lote 8 (1322) ─POST─► 200 OK ──► │ na parede pública│      parede
 └────────────┘                                   └──────────────────┘
```

**O que dava errado:**
- O `200 OK` só dizia *"recebi o lote"* — **não** *"guardei tudo certo"*. Sem conferência.
- Como colava **direto na parede pública**, durante a troca (~11 min) o cliente via a
  **parede pela metade**.
- Se um lote sumisse no caminho, a parede ficava **incompleta e ninguém percebia** —
  foi o caso do FAROL (10.000 em vez de 36.322).

---

## DEPOIS

```
  LOJA (Motor)                                 SERVIDOR (API)
 ┌────────────┐   cada lote vai com etiqueta:  ┌─────────────────────────────┐
 │ lê 36.322  │   • entrega nº abc-123          │ 1) empilha tudo numa        │
 │ contas a   │   • "são 36.322 no total"       │    MESA LATERAL (rascunho)  │
 │ pagar      │   • "lote X de Y"               │                             │
 └─────┬──────┘                                 │ 2) no ÚLTIMO lote, CONFERE: │
       │ lotes 1..8 ─────────POST──────────────►│      a mesa tem 36.322?     │
       │                                        │                             │
       │                                        │   ┌─ SIM ──────────────────┐│
       │                                        │   │ TROCA num instante:    ││──► cliente vê
       │                                        │   │ rascunho → parede      ││    SEMPRE a
       │                                        │   │ (tudo de uma vez)      ││    última versão
       │   ◄── "gravei 36.322" (recibo) ────────│   └────────────────────────┘│    COMPLETA
       │                                        │   ┌─ NÃO ──────────────────┐│
       │  se recibo ≠ 36.322 → reenvia depois   │   │ joga o rascunho fora,  ││
       │                                        │   │ mantém a parede ANTIGA ││
       │                                        │   └────────────────────────┘│
       └────                                    └─────────────────────────────┘
```

**Por que agora é seguro:**
- Os recados nunca vão direto na parede: vão primeiro pra uma **mesa lateral** (*staging*).
- A API **conta** a mesa e compara com o número declarado pelo Motor (`expectedTotal`).
  Só troca se bater.
- A troca é **instantânea e atômica** (*swap*): a parede pula de "completa antiga" para
  "completa nova" — **nunca fica pela metade**.
- Se a conta não bate, **a parede antiga fica intacta** e o Motor reenvia. Truncamento
  silencioso vira **impossível**.

---

## As 3 garantias, em português claro

| Garantia | Como | Antes |
|---|---|---|
| **Tudo-ou-nada** | só troca se contar certo | escrevia direto, podia ficar parcial |
| **Nunca mostra pela metade** | troca instantânea | painel via dados meio-trocados por minutos |
| **Truncamento é detectado** | recibo com a contagem real | `200 OK` não provava nada |

Os três apoios, sem jargão:
- **Etiqueta de entrega (`snapshotId`):** número de protocolo do envio. Se o entregador
  recomeça, o servidor sabe que é entrega nova e descarta o rascunho velho — não mistura.
- **"São N no total" (`expectedTotal`):** a nota fiscal. Sem ela, não dá pra saber se
  chegou tudo.
- **Recibo (`persisted`):** a API responde *"gravei 36.322 (antes eram 35.891)"*. O Motor
  confere e, se divergir, refaz.

## Resumo em uma linha

**Antes:** o entregador reescrevia a parede pública ao vivo e torcia pra dar certo.
**Depois:** monta tudo num rascunho, o servidor confere contra a nota fiscal e só então
troca a parede inteira de uma vez — com recibo.
