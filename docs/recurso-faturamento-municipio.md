# Recurso `faturamentoMunicipio`: faturamento mensal por município e bairro

> Relatório: **mapa de faturamento** com a opção de ver por cidade e por bairro.
> Inventário do Motor: [motor-arquitetura.md](./motor-arquitetura.md).

## Por que um recurso novo (e não alterar `faturamentoMensal`)

`GABARITO_FATURAMENTO_MENSAL` tem 1 linha por `IDEMPRESA × ANO × MES`, e a API e o painel
dependem dessa granularidade. Abrir por município e bairro gera N linhas por mês. Uma API
que ainda não foi atualizada somaria ou sobrescreveria errado. Como recurso separado:

- a API antiga nunca recebe o recurso, porque o toggle dela não existe;
- o canário é feito por CNPJ;
- o recurso faz a própria carga histórica pelo watermark por recurso.

## View `GABARITO_FATURAMENTO_MUNICIPIO` (`sql/views_real.sql`)

- Mesmas regras da `GABARITO_FATURAMENTO_MENSAL`: `STATUS` 1/3 é venda, 40/43 é troca.
  **A soma das linhas de um mês bate com ela.** Conferido na ARRUDA (13/10/2026) pelo
  caminho real do Motor (migração + extractor): 3 empresas × 37 meses, total, subtotal,
  desconto, troca e contagens idênticos.
- Agrupa por `IDEMPRESA, ANO, MES, CDMUNICIPIO, MUNICIPIO, CDMUNICIPIOIBGE, UF do
  município, UF do pedido, BAIRRO`. O município vem de `MUNICIPIO` (PK `CDMUNICIPIO`),
  que tem o código IBGE.
- O nome tem 30 caracteres, porque o Firebird 2.5/3 limita identificadores a 31.
- **O texto sai cru em OCTETS, sem `TRIM`/`UPPER`/`COALESCE` nem literal.** Função de
  texto sobre coluna `NONE` dá "Malformed string" pelo driver do Motor: o isql aceitou,
  o Motor não. É o mesmo caso do fix da `GABARITO_PROJECAO_PAGAMENTO`.
- `SAIDAESTOQUE` tem 1 linha por pedido (PK `NRPEDIDO+IDEMPRESA`). Cada pedido cai numa
  única linha, então `qtdVendas`/`qtdTrocas` **somam** entre bairros e municípios.

### Normalização no Motor (`mapFaturamentoMunicipioRow` + `agregarFaturamentoMunicipio`)

| Campo | Regra |
|---|---|
| `uf` | UF do cadastro do município (coerente com o IBGE). Se ela estiver vazia, vale a UF digitada no pedido. Sem nenhuma, `SEM UF`. Na ARRUDA, 357 pedidos têm UF do pedido diferente da do município. |
| `bairro` | WIN1252 decodificado, espaços colapsados, `TRIM`, caixa alta pt-BR (com acento). Vazio vira `SEM BAIRRO`. |
| `cdMunicipioIbge` | Só se tiver exatamente 7 dígitos; senão `null` (descarta o valor, nunca a linha). O cadastro tem lixo, como `FLORIANO Errado / AL / '1'`. |

As linhas que colidem depois da normalização ("Centro" × "CENTRO ") são **somadas**,
então `srcKey` é único no envio.

## Janela, toggle e falha

- **Toggle server-side:** o Motor só extrai e envia o recurso se o `GET /companies`
  trouxer `faturamentoMunicipioEnabled: true` para aquele CNPJ. Na API antiga o campo não
  vem, o recurso fica desligado e a view nem é consultada.
  - Isso também protege o histórico. Se a API antiga respondesse 200 ignorando o
    recurso, o Motor carimbaria a carga histórica como feita e ela nunca seria reenviada.
- **Recurso com janela** (`WINDOWED_RESOURCES`): incremental de 3 meses e carga
  histórica única de 3 anos. O `desde` é **sempre o 1º dia do mês** (`inicioDoMes`),
  porque o recurso é mensal e um mês de borda pela metade apagaria o mês inteiro na API.
- Volume medido na ARRUDA (maior empresa): 3 anos = 5.026 linhas em ~3 s.
- Se a extração falhar, o campo é omitido, fica fora do hash e não reprova o ciclo nem o
  full sync. O recurso fica sem carimbo, e o incremental faz a carga dele depois.

## Payload (`registros[0].faturamentoMunicipio[]`)

O recurso vai num POST próprio (1 recurso × 1 CNPJ) e é stagingável (`expectedTotal` +
`snapshotId`). Leva o `syncMode` do ciclo e **`desde` sempre presente** (`YYYY-MM-01`,
inclusive no full). A API deve substituir, para aquele CNPJ, as linhas com
`(ano, mes) >= (ano, mes) do desde`.

| Campo | Tipo | Notas |
|---|---|---|
| `srcKey` | string | `IDEMPRESA-ANO-MES-UF-CDMUNICIPIO-BAIRRO-CDVENDEDOR-CDCLIENTE` (`CDMUNICIPIO`, `CDVENDEDOR`, `CDCLIENTE` 0 se nulo). Único por CNPJ. |
| `idEmpresa`, `ano`, `mes` | int | |
| `uf` | string | 2 letras ou `SEM UF` |
| `cdMunicipio` | int \| null | código interno do ERP |
| `municipio` | string \| null | nome do cadastro do ERP |
| `cdMunicipioIbge` | string(7) \| null | **chave do mapa**; `null` = sem coordenada |
| `bairro` | string | normalizado; `SEM BAIRRO` quando vazio |
| `subtotal`, `desconto`, `total` | number | vendas (STATUS 1/3) |
| `subtotalTroca`, `descontoTroca`, `totalTroca` | number | trocas (STATUS 40/43) |
| `qtdVendas`, `qtdTrocas` | int | pedidos distintos; somáveis |
