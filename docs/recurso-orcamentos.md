# Recurso `orcamentos` — orçamentos e conversão em pedido

> Relatório: **orçamentos reais abertos e fechados com conversão**, separando o
> orçamento de verdade da venda que o vendedor fechou direto pela tela de orçamento.
> Inventário do Motor: [motor-arquitetura.md](./motor-arquitetura.md).

## O problema (medido no ERP ARRUDA, 29–30/09/2026)

1. **Toda venda de balcão passa pela tela de orçamento.** 87% dos orçamentos estão
   `STATUS=1` (finalizado). O status não separa "orçamento que virou venda" de "venda
   digitada como orçamento".
2. **Nenhum campo marca "fechou direto".** Simulação do usuário (empresa 2, vendedor
   105): os orçamentos 18503/18504 (fechados direto) e 18505 (salvo e convertido
   depois) têm registros idênticos em `ORCAMENTO`, `ORCPROD` e `SAIDAESTOQUE`.
   `ORCAMENTO.DTALTER` é sobrescrito a cada gravação, então o estado "aberto" se perde.
   **O único sinal que sobra é o tempo** entre `DTORC+HORAORC` e o pedido
   (`SAIDAESTOQUE.DTSAIDA+HORAPED`): 27 s, 25 s e 6 min na simulação.
3. **`ORCAMENTO.STATUS` é corrompido pelo próprio ERP.** O trigger
   `TG_INSERT_SAIDAESTOQUE` faz `UPDATE ORCAMENTO SET STATUS = 1 WHERE NRORCAMENTO =
   NEW.NRORCAMENTO`, **sem IDEMPRESA**. Ao converter o 18505 da empresa 2, o 18505 da
   empresa 1 (de 2023) também mudou no mesmo instante. Na ARRUDA, 1.969 orçamentos
   estão "finalizados" sem nenhum pedido válido.
4. **Pedido cancelado não é venda.** ~34 mil pedidos `STATUS=2` apontam para orçamento,
   e o orçamento continua "finalizado".
5. **Um orçamento pode ter vários pedidos** (27 mil com 2, até 21).

Por isso a **conversão vem do pedido** (`SAIDAESTOQUE.NRORCAMENTO` + `IDEMPRESA`,
`STATUS` 0/1/3), não do `ORCAMENTO.STATUS`, que vai só como `statusErp`, para auditoria.

## Distribuição do tempo até o pedido (ARRUDA, 2025→, 40.522 conversões)

| Faixa | Qtd | % |
|---|---|---|
| < 2 min | 3.932 | 9,7% |
| 2–5 min | 14.455 | 35,7% |
| 5–10 min | 8.410 | 20,8% |
| 10–20 min | 5.676 | 14,0% |
| 20–30 min | 2.271 | 5,6% |
| 30–60 min | 2.365 | 5,8% |
| 1–4 h | 1.891 | 4,7% |
| 4–24 h | 910 | 2,2% |
| 1–7 dias | 498 | 1,2% |
| > 7 dias | 112 | 0,3% |

Não existe vale natural na curva: o corte é decisão de negócio. **Padrão: 30 min**
(< 30 = venda direta; ≥ 30 = orçamento real). **O corte vive na API**, não no
Motor. O Motor manda `minutosAtePedido`; mudar o corte não exige release e reclassifica o
histórico sem re-sync.

## Views (`sql/views_real.sql`)

- **`GABARITO_ORCAMENTOS`**: 1 linha por item (`ORCPROD`), com o cabeçalho repetido.
  Orçamento sem item sai em 1 linha com `ITEM_POSIC = 0`.
  - `CLIENTE` é juntado **só por `CDCLIENTE`** (PK do cadastro, compartilhado entre
    empresas). Juntar também por `IDEMPRESA` perdia o cliente de 16.786 dos 18.505
    orçamentos da empresa 2.
- **`GABARITO_ORCAMENTO_PEDIDOS`**: pedidos com `NRORCAMENTO > 0` e `STATUS IN (0,1,2,3)`.

Ficam separadas porque `SAIDAESTOQUE` **não tem índice utilizável por
`NRORCAMENTO`**: o JOIN dentro da view passou de 10 min. O Motor lê as duas filtrando
por `IDEMPRESA` e data (colunas indexadas) e cruza em memória (`extrairOrcamentos`).

Verificado na ARRUDA: `COUNT(*) = COUNT(DISTINCT SRC_KEY)` (sem fan-out) e total de
itens batendo com o cabeçalho.

## Janela, memória e toggle

- **Toggle server-side:** o Motor só extrai e envia com `orcamentosEnabled: true` no
  `GET /companies` daquele CNPJ. Com a API antiga, o campo não vem, o recurso fica
  desligado e o Motor nem consulta as views.
- **Recurso com janela** (`WINDOWED_RESOURCES`): incremental de 3 meses; a carga
  histórica única tem **teto de 12 meses** (`ORCAMENTOS_HISTORICO_MESES`), não 3 anos.
  Medido na ARRUDA:

  | Janela | Linhas | Pico de heap | Tempo |
  |---|---|---|---|
  | 3 anos | 179.127 | ~807 MB | 22 s |
  | 12 meses (lido mês a mês) | 76.112 | 213 MB | 9,6 s |
  | 3 meses (incremental) | 19.793 | 116 MB | 2,2 s |

- Toggle desligado: `orcamentos` não conta como backfill pendente nem é carimbado. Quando
  o toggle ligar, o CNPJ faz a carga histórica sozinho.
- Extração falha (por exemplo, view ausente): o campo é omitido, fica fora do hash e
  **não reprova o ciclo** dos outros recursos. Uma extração parcial nunca é enviada: sem
  os pedidos, tudo sairia `ABERTO`.
- Um orçamento convertido depois de sair da janela de 3 meses (raro: 0,3% leva mais de
  7 dias) mantém na API o último estado enviado.

## Payload (`registros[0].orcamentos[]`)

POST próprio (1 recurso × 1 CNPJ), stagingável (`expectedTotal` + `snapshotId`),
`syncMode` do ciclo e **`desde` sempre presente** (início da janela lida, inclusive no
full). A API deve substituir `dt_orc >= desde` daquele CNPJ.

| Campo | Tipo | Notas |
|---|---|---|
| `srcKey` | string | `IDEMPRESA-NRORCAMENTO-POSIC`, único por CNPJ |
| `idEmpresa`, `nrOrcamento` | int | chave do orçamento (agrupar por ela) |
| `dtOrc` | `YYYY-MM-DD` | data de emissão (base da janela) |
| `dtOrcTs` | ISO c/ fuso \| null | emissão com hora; null se o ERP não tem hora |
| `statusErp` | int | 0 aberto, 1 finalizado, 2 cancelado, 4 — **só auditoria** |
| `dtCancelamento` | `YYYY-MM-DD` \| null | |
| `situacao` | string | `CONVERTIDO` · `CANCELADO` · `PEDIDO_CANCELADO` · `ABERTO` |
| `cdCliente`, `cliente`, `clienteDoc`, `clienteFone`, `clienteEmail`, `contato` | | fone: orçamento → WhatsApp → celular → telefone |
| `cdVendedor`, `vendedor`, `vendedorFone` | | |
| `vlTotal`, `desconto`, `subtotal` | number | **do orçamento — repetidos em cada item** |
| `observacao` | string \| null | |
| `qtdPedidos`, `qtdPedidosCancelados` | int | pedidos válidos (0/1/3) e cancelados (2) |
| `nrPedido`, `pedidoTs` | int, ISO \| null | pedido válido mais antigo |
| `vlPedidos` | number | soma dos pedidos válidos (valor que virou venda) |
| `minutosAtePedido` | int \| null | `pedidoTs − dtOrcTs`; null sem conversão ou sem hora |
| `itemPosic`, `itemCodigo`, `itemDescricao`, `itemUnidade`, `itemQtd`, `itemVlUnit`, `itemDesconto`, `itemVlTotal` | | item; `itemPosic = 0` = orçamento sem item |

Precedência de `situacao`: tem pedido válido → `CONVERTIDO` (mesmo que cancelado no ERP
depois); senão cancelado no ERP → `CANCELADO`; senão só pedidos cancelados →
`PEDIDO_CANCELADO`; senão `ABERTO`.
