// check-extractor.js — READ-ONLY. Valida o FIX de encoding pelo caminho REAL do
// extractor (não por query crua). Chama as funções de extração e varre a saída
// mapeada procurando U+FFFD. Sem POST, sem tocar sync_state.
process.env.GABARITO_DISABLE_BOOTSTRAP = 'true';
require('dotenv').config();

const {
  mapearCnpjsParaIdEmpresa, extrairContasPagar, extrairContasReceber,
  extrairCurvaAbc, extrairEntradas, extrairVendedores, extrairPedidosPorHorario,
} = require('./src/gabarito-motor/extractor');
const { buscarCnpjsAtivos } = require('./src/gabarito-motor/sender');

const RC = '�';
const hasAccent = (s) => /[À-ÿ]/.test(s);

function scan(label, rows, campos) {
  let bad = 0, chec3d = 0; const ex = [];
  for (const r of rows) {
    for (const c of campos) {
      const v = r[c];
      if (typeof v !== 'string' || !v.length) continue;
      chec3d++;
      if (v.includes(RC)) { bad++; if (ex.length < 3) ex.push(`❌ ${c}="${v}"`); }
      else if (ex.length < 3 && hasAccent(v)) ex.push(`✅ ${c}="${v}"`);
    }
  }
  const flag = bad === 0 ? 'OK' : `⚠️ ${bad} U+FFFD`;
  console.log(`  ${label.padEnd(14)} linhas=${String(rows.length).padStart(6)}  campos-texto=${String(chec3d).padStart(6)}  ${flag}`);
  if (ex.length) console.log(`       ${ex.join('  |  ')}`);
  return bad;
}

(async () => {
  const desde = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10); // 90 dias (teste leve)
  const mapa = await mapearCnpjsParaIdEmpresa(await buscarCnpjsAtivos());
  let total = 0;
  for (const [cnpj, id] of Object.entries(mapa)) {
    console.log(`\n── CNPJ ${cnpj} (IDEMPRESA=${id}) — desde ${desde} ──`);
    total += scan('contasReceber', await extrairContasReceber(id), ['cliente', 'vendedor', 'formaRecebida', 'nomeEmpresa', 'caixa', 'origem']);
    total += scan('contasPagar',   await extrairContasPagar(id),   ['fornecedor', 'historico', 'nomeEmpresa', 'conta1', 'documento', 'conta2']);
    total += scan('curvaAbc',      (await extrairCurvaAbc(id, desde)).rows, ['produto', 'fabricante', 'grupo', 'tipo', 'linha', 'familia', 'deposito', 'unidade']);
    total += scan('entradas',      await extrairEntradas(id, desde),        ['descricao', 'fornecedor', 'empresa']);
    total += scan('vendedores',    await extrairVendedores(id, desde),      ['nomeVend']);
    total += scan('pedidosHorario', await extrairPedidosPorHorario(id, desde), ['nomeEmpresa']);
  }
  console.log(total === 0
    ? '\n✅ FIX OK: extractor não produziu nenhum U+FFFD. Acentos recuperados na leitura.'
    : `\n❌ Ainda há ${total} U+FFFD na saída do extractor — investigar.`);
  process.exit(total === 0 ? 0 : 2);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
