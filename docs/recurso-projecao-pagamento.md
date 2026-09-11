# Recurso `projecaoPagamento` — o que o Motor entrega

> Resposta ao prompt da Gabarito (API csdigitalz). **Status: implementado no Motor,
> release NÃO publicada** — aguardando o deploy da aplicação da API (a migration da
> `relat_projecao_pagamento` já está aplicada em produção, mas o PM2 ainda roda o código
> antigo). Ver "Sequenciamento" no fim.

Lado Motor: view `GABARITO_PROJECAO_PAGAMENTO` (`sql/views_real.sql`) +
`extrairProjecaoPagamento`/`mapProjecaoPagamentoRow` (`backend/src/gabarito-motor/extractor.js`).
Não encosta em `contasPagar`: são recursos independentes, cada um no seu POST.

## O que foi verificado no ERP (não é suposição)

Consultado direto num ERP real (Firebird ODS 13, `CTAPAGAR` com 87 colunas). A view foi
aplicada numa cópia e conferida linha a linha:

| Conferência | Resultado |
|---|---|
| `COUNT(*)` × `COUNT(DISTINCT SRC_KEY)` | **562 / 562** (IDEMPRESA=1) e **60 / 60** (IDEMPRESA=3) |
| Fan-out dos `LEFT JOIN` de conta | nenhum: contagem idêntica com e sem os joins |
| Janela devolvida | `min(DTVENC) = 2026-09-01`, `max = 2026-11-30` (mês corrente + 2) |
| `srcKey` nulo / `dtVenc` nulo | 0 / 0 |
| `INNER JOIN FORNECEDOR` perderia | 0 linhas nesta base (mesmo assim ficou `LEFT`) |

Volume: **~620 linhas por CNPJ por janela** → sempre 1 chunk.

## Cinco divergências em relação à spec (todas verificadas)

1. **`srcKey` = PK do `CTAPAGAR`.** A tabela tem PK própria: **`CONTROLE`** (INTEGER,
   `PK_CTAPAGAR`). É ela que vai em `srcKey`, como string — não a chave composta. Único por
   linha da tabela inteira, logo único por CNPJ.

2. **`cdConta1..4` são STRING, não inteiro.** No ERP, `CDCONTA`/`CDSUBCONTA`/
   `CDSUBSUBCONTA`/`CDSUBSUBSUBCONTA` são `VARCHAR(3/5/5/7)` — existem códigos como `'007'`
   e `'7.2'`. Mandar como inteiro perderia o zero à esquerda e quebraria o agrupamento da
   tela. **A coluna do destino precisa ser texto.** Quando o nível não é usado, o ERP grava
   `''` — o Motor converte para `null`.

3. **`tpPagto` não é letra.** É `INTEGER`, FK para `RECEBTO.CDRECEBTO` (o exemplo `"B"` da
   spec não existe); `0` significa "não informado". Vai serializado como string, respeitando
   o tipo que vocês declararam. Se quiserem o rótulo legível dele (como `recebto` é o rótulo
   de `CODPAGTO`), peçam: é um `LEFT JOIN RECEBTO` a mais na view.

4. **`multa` não existe** em `CTAPAGAR` neste ERP. `valor`, `juros` e `desconto` existem e
   vão no payload. (Existem também `RETENCAO`, `PIS` e `COFINS` — peçam se servirem.)

5. **Janela semiaberta, não `BETWEEN`.** `DTVENC`/`DTPAGTO`/`DTINCLUSAO` são **TIMESTAMP**,
   não `DATE`. O `BETWEEN ... AND <último dia às 00:00>` da spec descartaria silenciosamente
   qualquer título com hora. A view usa `>= 1º dia do mês AND < 1º dia do mês + 3 meses`.

Um ajuste a mais, de robustez: o filtro de provisão é **`NOT CONTAINING 'Provis'`** (ASCII).
`CONTAINING` do Firebird ignora caixa mas **não** ignora acento, e um literal acentuado
dentro do `views_real.sql` depende de sobreviver ao utf8→WIN1252 na aplicação da view. O
prefixo ASCII pega `Provisao` **e** `Provisão` sem esse risco. Efeito colateral a saber:
também exclui `Provisório`/`Provisionado`.

## Contrato entregue

Envelope idêntico ao dos outros recursos stagingáveis, com uma diferença deliberada:
`syncMode` é **sempre `"full"`** (cada envio é o snapshot completo da janela) e `desde` é o
**1º dia do mês corrente** — o `desde` do ciclo (3 meses atrás) descreveria uma janela que
não é a deste recurso, que olha para frente.

```jsonc
{
  "syncMode": "full",
  "desde": "2026-09-01",
  "dataReferencia": "2026-09-10",
  "snapshotId": "<uuid v4, novo a cada ciclo, igual em todos os chunks>",
  "chunkInfo": { "atual": 1, "total": 1 },
  "expectedTotal": 622,
  "registros": [ { "cnpj": "...", "projecaoPagamento": [ /* ... */ ] } ]
}
```

Uma linha:

```jsonc
{
  "srcKey": "8524",            // CTAPAGAR.CONTROLE
  "idEmpresa": 1,
  "notaFiscal": "2085422", "parcela": 8, "nrDoc": "2085422-8",
  "status": 1,                 // 1 = em aberto, 2 = pago (domínio do ERP, não normalizado)
  "dtVenc": "2026-09-03", "dtPagto": null, "dtInclusao": "2026-03-03",
  "historico": "Manutenção prédio",
  "codPagto": 6, "tpPagto": "0", "recebto": "Depósito em Conta",
  "valor": 1200, "total": 1234.56, "juros": 0, "desconto": 0, "vlPago": 0,
  "fornecedor": "DISTRIBUIDORA EXEMPLO LTDA", "cdFornecedor": 4471,
  "cdConta1": "007", "conta1": "Movimentações Não Operacionais",   // STRING
  "cdConta2": "2",   "conta2": "7.2 SAIDA NAO OPERACIONAL",
  "cdConta3": "1",   "conta3": "DETALHE",
  "cdConta4": null,  "conta4": null,
  "statusVale": null, "cdClienteVale": null
}
```

`statusVale` chega **sempre `null`**: o filtro da view é `STATUSVALE IS NULL` (é `INTEGER`,
não texto), então vale nenhum entra. O campo vai junto porque a spec pediu.

Garantias de formatação, cobertas por teste unitário
(`backend/src/gabarito-motor/projecaoPagamento.test.js`): data sempre `"YYYY-MM-DD"` puro,
montada dos componentes **locais** (nunca `toISOString()`, que joga o vencimento para o mês
anterior); ano < 2000 ou > 2100 vira `null` **sem descartar a linha**; texto decodificado de
WIN1252 (sem `U+FFFD`); vazio é `null`, nunca `""`; número é `number`, com ponto decimal.

## Mês sem títulos

Implementado: extração bem-sucedida com 0 linhas → **1 POST** com `"projecaoPagamento": []`,
`expectedTotal: 0` e `chunkInfo {1,1}`, e o Motor valida `persisted.total === 0`.

O que **não** manda vazio: extração que **falhou** (view ausente, timeout do Firebird). Aí o
recurso é pulado, o hash do ciclo não é salvo e o próximo ciclo reenvia. Sem essa distinção,
um erro de leitura no cliente viraria "apague tudo" no CNPJ.

## Sequenciamento e validação

O release fica pronto e **não publicado** até vocês avisarem o deploy. Quando subir:

1. `COUNT(*)` do SELECT no ERP do CNPJ canário.
2. Enviar **1 CNPJ no caminho staging+swap** (Farol da Primavera, Multi Utilidades, Multi
   Comércio ou as Nova Frankel). O último chunk tem de voltar com
   `persisted.projecaoPagamento.total` **igual** ao `COUNT(*)` — o Motor já falha o recurso
   sozinho se não bater, e loga `projecaoPagamento: N linhas confirmadas pela API`.
3. `GET /api/v1/sync/snapshot-state?cnpj=<cnpj>&recurso=projecaoPagamento` → `"swapped"`.
4. Só então a frota (a ativação por CNPJ segue sendo o toggle de vocês).

---

# Respostas ao retorno de 11/09 (1ª carga, Fibrolar)

Medições feitas num ERP real (634 títulos na janela, mesmas colunas do Fibrolar).

## 1. A view não existe nas outras bases — não é passo manual

O Motor **cria as views sozinho**: `runDatabaseMigrations()` aplica `sql/views_real.sql`
inteiro (`CREATE OR ALTER`, idempotente) a cada boot do serviço, e o updater sincroniza a
pasta `sql/`. Não há DDL manual em cliente nenhum — nunca houve, para nenhuma das 9 views.

Se a view não existe no Ambiente Teste, é porque **o `CREATE OR ALTER` dela falhou naquele
banco** — quase sempre uma coluna do `CTAPAGAR` que existe numa versão do ERP e não na
outra. As candidatas (as que não aparecem em nenhuma view anterior, logo nunca foram
provadas na frota): `CONTROLE`, `DTINCLUSAO`, `STATUSVALE`, `CDCLIENTEVALE`, `JUROS`,
`DESCONTO`.

**A causa exata já está no log do Motor daquela máquina**, na linha de boot:

```
grep "Erro ao executar statement" backend\logs\*.log     (v1.10.0 e anteriores)
grep "FALHA ao criar/alterar"     backend\logs\*.log     (v1.10.1+)
```

Até a v1.10.0 essa linha era um `WARN` anônimo — trazia a mensagem do Firebird mas não dizia
qual view. **Corrigido na v1.10.1:** virou `ERROR`, nomeia o objeto e fecha com um resumo
`N de M objeto(s) COM FALHA: VIEW X, VIEW Y`. É o que transforma "Table unknown" em
"Column unknown: DTINCLUSAO".

Atalho para não esperar o próximo ciclo: rodar o DDL à mão na base do Ambiente Teste
(`isql` → colar o `CREATE OR ALTER VIEW GABARITO_PROJECAO_PAGAMENTO` de `sql/views_real.sql`)
— o erro aparece na hora e diz qual coluna falta.

Sobre embutir o SELECT no Motor em vez de usar view: **não resolve este caso.** Se a coluna
não existe, o SELECT inline falha igual — só muda o momento (execução em vez de DDL). O que
faltava era o erro ser legível, e é isso que a v1.10.1 entrega.

## 2. Extração que falha já omite o campo — desde a v1.10.0

Isso **já é** o comportamento. `extrairProjecaoPagamento` devolve `{ rows, completo }` e o
envio é condicionado ao `completo`:

```js
const opts = ehProjecao ? { enviarVazio: projecaoCompleta } : {};
// enviarRecurso: lista vazia + enviarVazio=false → return true SEM enviar nada
```

No ciclo do Ambiente Teste em que deu `-204`, **nenhum POST com `projecaoPagamento` saiu** —
o `projecaoPagamento=0` do log é a contagem da extração, não um envio. Dá para confirmar do
lado de vocês: não existe requisição com essa chave vinda daquele CNPJ.

Coberto por teste: `ON: vazio SEM enviarVazio → segue omitindo o campo`
(`backend/src/gabarito-motor/enviarRecurso.test.js`). O `[]` com `expectedTotal: 0` só sai
quando o SELECT **rodou** e a janela está realmente vazia — que é o combinado.

Na v1.10.1 a falha também passou a gritar no log:
`projecaoPagamento: extração falhou — campo OMITIDO no envio`.

## 3. Falha de um recurso invalidando o ciclo — corrigido

Procede, e a culpa é nossa: a projeção entrou no mesmo gate de hash da Curva ABC. **Corrigido
na v1.10.1** — a projeção não reprova mais o ciclo:

- recurso com extração falha fica **fora do hash** (incluí-lo como `[]` faria o hash oscilar
  contra um dado que nem chegou a ser enviado);
- o gate voltou a ser `todosSucesso && curvaAbcCompleta`;
- idem no full sync, onde o efeito era pior: refazia a carga de 3 anos a cada ciclo.

Efeito prático: enquanto a view não existir, o CNPJ volta a pular o envio quando nada mudou.
Quando a view passar a existir, a chave reaparece no hash com as linhas → hash muda → reenvia
sozinho, sem intervenção.

## 4. Níveis de conta vazios — a view tem os 4 JOINs

Os quatro `LEFT JOIN` estão lá (`sql/views_real.sql`), e o `cdConta1` nem depende de join:
vem direto de `cta.CDCONTA`. Se ele veio nulo em 511/511, **a coluna está vazia naquele
banco** — não é a view. No ERP que medimos, `CDCONTA` está preenchido em **634 de 634**.

Dois testes que fecham isso em minutos:

1. **Do lado de vocês, sem depender de nós:** conferir `conta1..conta4` do `contasPagar` dos
   mesmos CNPJs. Saem das mesmas colunas do `CTAPAGAR` (via `GABARITO_CTAPAGAR_GERAL`). Se lá
   também estiver vazio, é o dado do cliente; se lá estiver preenchido, é bug nosso e a gente
   corrige na hora.
2. No ERP do Fibrolar:

```sql
SELECT COUNT(*) AS TOTAL,
       COUNT(NULLIF(TRIM(CDCONTA), '')) AS COM_CDCONTA,
       COUNT(NULLIF(TRIM(CONTA), ''))   AS COM_CONTA
  FROM CTAPAGAR WHERE DTVENC >= '2026-09-01';
```

Existe também uma coluna `CONTA VARCHAR(15)` no `CTAPAGAR` (preenchida em 151/634 na base que
medimos). Se o Fibrolar classificar despesa **ali** em vez dos 4 níveis, a gente acrescenta
esse campo ao payload — é só pedir.

## 5. `srcKey`: a chave composta perde título, a PK não

Medido na mesma janela, 634 títulos:

| Chave | Valores distintos | Títulos perdidos |
|---|---|---|
| `CONTROLE` (PK do CTAPAGAR) | **634** | **0** |
| `IDEMPRESA\|NRDOC\|PARCELA\|CDFORNECEDOR\|DTVENC` | 613 | **21 (3,3%)** |

Como a segunda `srcKey` repetida é descartada em silêncio do lado de vocês, voltar à chave
composta **apaga 21 títulos de 634** — exatamente o tipo de perda silenciosa que o recurso
existe para evitar. A própria spec original dizia "se `CTAPAGAR` tiver PK própria, mandem
**ela**; é o ideal" — e tem: `CONTROLE`, `PK_CTAPAGAR`, INTEGER.

Sobre reciclagem de ID: não há sobrescrita a temer, porque **cada ciclo é um full replace do
CNPJ** (staging + swap apaga tudo e regrava). A `srcKey` precisa ser única *dentro do envio*,
não estável no tempo. Se ainda assim quiserem defesa extra, o caminho sem perda é
`CONTROLE` + sufixo — nunca a composta pura.

## 6. `TOTAL` × `VALOR` — confirmado, com uma ressalva que muda a conta

Sim: **`VALOR` é a parcela, `TOTAL` é o documento.** Medido:

| Conferência | Resultado |
|---|---|
| Documento `0401/001`, parcelas 32/33/34 | `TOTAL` = 174.323,86 nas três; `VALOR` = 5.177,40 / 5.136,74 / 5.118,80 |
| Títulos com `VALOR` nulo ou zero | **0 de 634** |
| Títulos com `TOTAL` nulo ou zero | **252 de 634 (40%)** |

Respondendo às três perguntas:

1. Confirmado.
2. `VALOR` **sempre** veio preenchido (0 de 634 nulos). O problema é o inverso: **40% dos
   títulos têm `TOTAL = 0`** (ex.: `101095-1`, `TOTAL` 0,00 e `VALOR` 394,00). Somar `TOTAL`
   não só infla os parcelados como **zera** dois quintos da projeção.
3. Sim — **somem `valor`**. É o mesmo campo que o Fluxo de Caixa de vocês já soma.

O Motor manda os dois; nada muda aqui.

## 7. Pontos menores

- **`tpPagto`**: é `INTEGER`, FK para `RECEBTO.CDRECEBTO` — mesmo domínio do `codPagto`. Vai
  como string porque foi assim que vocês declararam o campo. `0` é o "não informado" do ERP
  (não existe `CDRECEBTO = 0`) e `null` é ausência. Distribuição medida: `null` 291, `0` 264,
  `13` (Depósito em Conta) 51, `6` (Boleto Bancário) 16, `1` (Dinheiro) 12 — mesmo padrão do
  que chegou aí. Se preferirem o rótulo legível em vez do código, mandamos `formaPaga` (é o
  join que o `contasPagar` já faz); é só pedir.
- **`juros` / `desconto` = 0,00**: as colunas **existem** no `CTAPAGAR` e o valor é zero de
  verdade. `multa` **não existe** nessa tabela — por isso a chave nem vai no payload e chega
  `null` aí. A distinção que vocês querem ("não tem a informação" × "é zero") já é essa.
- **`historico` vazio em 158**: não é corte de `TRIM` (ele só remove espaço). Na base que
  medimos, `HISTORICO` vazio = **0 de 634** — então é dado do Fibrolar. Vazio vira `null` por
  contrato.

## 8. CNPJ `01.928.055/0002-00` fora da `GABARITO_EMPRESAS`

A view filtra empresas de acobertamento (`COALESCE(ACOBERTAMENTO, 0) <> -1`, desde o commit
`58c2efd`). Esta query separa as duas causas possíveis, na base do Ambiente Teste:

```sql
SELECT IDEMPRESA, CGC, ACOBERTAMENTO FROM CONFIGURACAO ORDER BY IDEMPRESA;
```

- Segunda loja aparece com `ACOBERTAMENTO = -1` → é o filtro, e a pergunta vira de negócio:
  ela deve mesmo ser sincronizada?
- Não aparece, ou aparece com CGC diferente do cadastrado na Gabarito → é cadastro no ERP.
