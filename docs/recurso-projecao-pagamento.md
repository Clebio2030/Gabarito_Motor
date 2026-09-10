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
