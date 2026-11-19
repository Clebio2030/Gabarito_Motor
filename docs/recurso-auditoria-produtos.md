# Recursos `auditoria*`: auditoria do cadastro de produtos

> Quatro relatórios de qualidade de cadastro: código de barras, NCM, custo × preço e
> produto sem imposto de venda. Inventário do Motor: [motor-arquitetura.md](./motor-arquitetura.md).

## Quatro recursos, um toggle

| Recurso (campo do payload) | View do ERP | 1 linha = | `srcKey` |
|---|---|---|---|
| `auditoriaCodigoBarras` | `GABARITO_AUD_CODIGO_BARRAS` | 1 código de barras de 1 unidade de 1 produto (`PRODUTO_CODBARRA`) | `cdProduto-cdUnidade-codigoBarra` |
| `auditoriaNcm` | `GABARITO_AUD_NCM` | 1 produto (`PRODUTO.CLASSFISCAL`) | `cdProduto` |
| `auditoriaCustoPreco` | `GABARITO_AUD_CUSTO_PRECO` | 1 preço de 1 produto (`PRODUTOPRECO`) | `cdProduto-idPreco-cdUnidade` |
| `auditoriaSemImpostoVenda` | `GABARITO_AUD_SEM_IMPOSTO_VENDA` | 1 produto | `cdProduto` |

Um único toggle server-side liga os quatro para o CNPJ: `auditoriaProdutosEnabled: true`
no `GET /companies`. API antiga não manda o campo → desligado, o Motor nem consulta as
views. Só `true` literal liga.

Os nomes `GABARITO_AUD_*` são de propósito: não colidem com as views de análise manual
(`GABARITO_CODIGO_BARRAS`, `GABARITO_NCM` etc.) que podem existir no banco do cliente.

## Snapshot completo, sem janela

- Sem `desde`, sem carga histórica, fora de `WINDOWED_RESOURCES`. Cada envio é o estado
  atual: a API **substitui tudo do CNPJ** naquele recurso (staging + swap, como os demais
  recursos stagingáveis). POST próprio por recurso, com `syncMode: "full"`,
  `expectedTotal` e `snapshotId`.
- **Só as linhas com problema vão no payload.** `situacao` é o código numérico e
  `situacaoNome` o nome, sem acento.
- **Snapshot vazio é enviado** (`expectedTotal: 0`) quando a extração deu certo e não há
  problema: é assim que a API esvazia o que o cliente já corrigiu no ERP.
- **Falha de extração omite o campo** (a API preserva o que tinha) e não carimba nada. Uma
  view ausente não reprova o ciclo principal nem os outros recursos.
- **Hash próprio por CNPJ e recurso** (`snapshotHashes` em `sync_state.json`), independente
  do hash do ciclo principal. O catálogo muda no ritmo dele e não reenvia contas a
  pagar/receber nem curva. O hash só é carimbado depois do envio confirmado (`persisted`
  conferido). `resyncToken` novo ignora o hash.
- Roda **depois** do ciclo principal, isolado por `try/catch`: falha aqui nunca derruba os
  demais recursos.
- **Sem `IDEMPRESA`:** `PRODUTO` é cadastro do banco inteiro. O mesmo catálogo vai para
  todo CNPJ ligado do banco. Se um banco tiver 2 CNPJs, ligue só o que deve receber.
- **Inclui ativos e inativos.** `inativo` (boolean) permite filtrar. `INATIVO` do ERP é
  `0` = ativo, `-1` = inativo, e nulo não conta como ativo.

## Onde a classificação roda

| Recurso | Filtro | Classificação |
|---|---|---|
| `auditoriaCodigoBarras` | nenhum (base completa) | **Motor** (`auditarCodigosBarras`) |
| `auditoriaNcm` | nenhum (base completa) | **Motor** (`auditarNcm`) |
| `auditoriaCustoPreco` | SQL (só campos numéricos) | SQL, `SITUACAO` SMALLINT |
| `auditoriaSemImpostoVenda` | SQL (só campos numéricos) | SQL, `SITUACAO` SMALLINT |

Por que código de barras e NCM não classificam na view:

1. **Texto cru em OCTETS.** Função de texto (`TRIM`, `UPPER`, `COALESCE`, literal) sobre
   coluna `CHARACTER SET NONE` roda no isql mas dá "Malformed string" no driver do Motor.
   A view só faz `CAST(... CHARACTER SET OCTETS)` e o Motor decodifica WIN1252.
2. **`REPETIDO` não escala em SQL.** Exige cruzar todos os códigos entre si, e
   `PRODUTO_CODBARRA` só tem índice por `CDPRODUTO`. O `JOIN` por código é quadrático no
   Firebird 2.5 (sem hash join): a versão anterior passava de 2 minutos num banco de 4 mil
   produtos e não terminava em bancos de 62 mil. No Motor é um `Map` em memória.
3. **Testável sem banco** (funções puras) e sem depender de `SIMILAR TO`/`CONTAINING`
   entre versões do Firebird.

## Situações (a ordem é a prioridade: vale a primeira que se aplica)

**`auditoriaCodigoBarras`.** Código = `PRODUTO_CODBARRA.CODBARRA`, que é a tabela que o PDV
lê. Em branco, nulo e o texto `SEM GTIN` (padrão da NF-e) **não** são problema. Produtos
`FRETE%` ficam de fora.

| Código | Nome | Regra |
|---|---|---|
| 1 | `COM ESPACOS` | espaço no início, no fim ou no meio |
| 2 | `CARACTERE INVALIDO` | tem algo que não é dígito (traço, letra) |
| 3 | `TAMANHO ERRADO` | só dígitos, mas com tamanho diferente de 8, 12, 13 ou 14 |
| 4 | `REPETIDO` | o próprio produto está ativo e o mesmo código (sem espaços nas pontas) está em outro produto **ativo** |

O mesmo código em várias unidades do **mesmo** produto não é repetição.

**`auditoriaNcm`.** NCM = `PRODUTO.CLASSFISCAL` (`PRODUTO.NCM` não é usado). Válido =
exatamente 8 dígitos, sem espaços, diferente de `99999999` e `00000000`.

| Código | Nome |
|---|---|
| 1 | `NCM NULO` |
| 2 | `NCM EM BRANCO` |
| 3 | `NCM COM ESPACOS` |
| 4 | `NCM 99999999` |
| 5 | `NCM ZERADO` |
| 6 | `NCM COM CARACTERE NAO NUMERICO` |
| 7 | `NCM COM MAIS DE 8 DIGITOS` |
| 8 | `NCM COM MENOS DE 8 DIGITOS` |

**`auditoriaCustoPreco`.** Linhas de `PRODUTOPRECO` com custo e preço incoerentes.

| Código | Nome |
|---|---|
| 1 | `CUSTO E PRECO ZERADOS` |
| 2 | `CUSTO ZERADO` |
| 3 | `PRECO ZERADO` |
| 4 | `CUSTO MAIOR QUE PRECO` |
| 5 | `CUSTO IGUAL AO PRECO` |

**`auditoriaSemImpostoVenda`.** Produtos `FRETE%` ficam de fora.

| Código | Nome |
|---|---|
| 1 | `SEM IMPOSTO DE VENDA` (`IDIMPOSTO_VENDA` nulo) |
| 2 | `IMPOSTO DE VENDA INEXISTENTE` (aponta para `IDIMPOSTO` que não existe) |

## Payload (`registros[0].<recurso>[]`)

Campos comuns a todos: `srcKey` (string, único por CNPJ), `cdProduto` (string, **o código
do produto é texto no ERP**), `produto`, `inativo` (boolean), `situacao` (int),
`situacaoNome` (string).

**`auditoriaCodigoBarras`:** `cdUnidade`, `codigoBarra` (cru, com os espaços),
`tamanho` (int), `padrao` (boolean, é o código principal do produto),
`codigoIgualCdProduto` (boolean, é código interno e não GTIN), `qtdMesmoCodigo`
(int|null, produtos ativos com o código).

**`auditoriaNcm`:** `ncm` (string|null, cru), `tamanho` (int|null), `cdUnidVenda`
(string|null), `idImpostoVenda` (int|null), `ncmSugerido` (string(8)|null: o NCM com
ponto, traço e espaço removidos, só quando sobra um NCM válido; é sugestão, conferir antes
de aplicar).

**`auditoriaCustoPreco`:** `idPreco` (int), `tabelaPreco` (string|null), `cdUnidade`,
`vlCusto`, `preco`, `vlCustoMedio` (number|null), `diferenca` (custo − preço),
`percPrejuizo` (number|null, só quando custo e preço > 0), `dtReajuste`, `dtAlter`
(`YYYY-MM-DD`|null).

**`auditoriaSemImpostoVenda`:** `classFiscal` (string|null), `cdUnidVenda` (string|null),
`idImpostoVenda` (int|null).

## Canário e rollout

1. API primeiro: aceita os 4 campos (staging + swap) e expõe `auditoriaProdutosEnabled` por
   CNPJ no `GET /companies`.
2. Liga num CNPJ de teste, confere 1–2 ciclos pelo log do Motor
   (`<recurso>: N linhas confirmadas pela API`) e pelo `snapshot-state`.
3. Expande por CNPJ no admin, sem tocar em nenhuma máquina.

O código pode estar em toda a frota: sem o toggle, nada é consultado nem enviado.
