#!/usr/bin/env node
/**
 * Diagnostico do sistema - roda sem subir o servidor nem o front-end.
 *
 *   npm run diagnostico                          teste completo
 *   npm run diagnostico -- --sem-ia              so banco e regras (nao gasta cota)
 *   npm run diagnostico -- --produto "Budweiser" testa a busca ponta a ponta
 *   npm run diagnostico -- --ncm 2202.10.00      testa a consulta por codigo
 *   npm run diagnostico -- --uf BA --regime simples_nacional
 *   npm run diagnostico -- --chave sk-ant-...    usa uma chave avulsa
 *
 * Cada etapa e independente: se a IA estiver fora do ar, os testes de banco e
 * de regras continuam rodando e mostram o que esta saudavel.
 */

import { config, resolverChaveApi, MODELO_IA } from '../src/config.js';
import { mascarar, CAMINHOS } from '../src/security/cofre.js';
import { abrirBanco, obterEstatisticas, obterMetadados, obterNcm, buscarNcmPorTexto, buscarCestPorNcm } from '../src/db/index.js';
import { montarFichaFiscal, ESTADOS } from '../src/domain/regras-fiscais.js';
import { testarConexao } from '../src/services/cliente-anthropic.js';
import { interpretarProduto } from '../src/services/ia-fiscal.js';
import { consultarPorProduto, consultarPorNcm } from '../src/services/consulta.js';

// --------------------------------------------------------------------------
// Apresentacao
// --------------------------------------------------------------------------

const cor = {
  ok: (t) => `\x1b[32m${t}\x1b[0m`,
  falha: (t) => `\x1b[31m${t}\x1b[0m`,
  aviso: (t) => `\x1b[33m${t}\x1b[0m`,
  fraco: (t) => `\x1b[90m${t}\x1b[0m`,
  forte: (t) => `\x1b[1m${t}\x1b[0m`,
};

const resumo = [];

function titulo(texto) {
  console.log(`\n${cor.forte(texto)}`);
  console.log(cor.fraco('─'.repeat(Math.max(texto.length, 40))));
}

async function etapa(nome, funcao) {
  const inicio = Date.now();
  try {
    const detalhe = await funcao();
    const ms = Date.now() - inicio;
    console.log(`${cor.ok('✓')} ${nome} ${cor.fraco(`(${ms}ms)`)}`);
    if (detalhe) {
      for (const linha of String(detalhe).split('\n')) console.log(`   ${cor.fraco(linha)}`);
    }
    resumo.push({ etapa: nome, situacao: 'ok' });
    return true;
  } catch (erro) {
    console.log(`${cor.falha('✗')} ${nome}`);
    console.log(`   ${cor.falha(erro.message)}`);
    if (erro.detalhe) console.log(`   ${cor.fraco(String(erro.detalhe).slice(0, 300))}`);
    resumo.push({ etapa: nome, situacao: 'falhou', motivo: erro.message });
    return false;
  }
}

function pular(nome, motivo) {
  console.log(`${cor.aviso('–')} ${nome} ${cor.fraco(`(pulado: ${motivo})`)}`);
  resumo.push({ etapa: nome, situacao: 'pulado', motivo });
}

// --------------------------------------------------------------------------
// Argumentos
// --------------------------------------------------------------------------

function lerArgumento(nome, padrao = null) {
  const i = process.argv.indexOf(`--${nome}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  const comIgual = process.argv.find((a) => a.startsWith(`--${nome}=`));
  if (comIgual) return comIgual.slice(nome.length + 3);
  return padrao;
}

const semIa = process.argv.includes('--sem-ia');
const produtoTeste = lerArgumento('produto', 'Coca-Cola lata');
const ncmTeste = lerArgumento('ncm', '2202.10.00');
const ufTeste = (lerArgumento('uf', 'PE') ?? 'PE').toUpperCase();
const regimeTeste = lerArgumento('regime', 'regime_normal');

// --------------------------------------------------------------------------
// Execucao
// --------------------------------------------------------------------------

console.log(cor.forte('\n╭──────────────────────────────────────────────╮'));
console.log(cor.forte('│  Diagnóstico · Consulta Fiscal NCM/CEST      │'));
console.log(cor.forte('╰──────────────────────────────────────────────╯'));

// ---- 1. Ambiente -----------------------------------------------------------
titulo('1. Ambiente');

await etapa('Versão do Node', async () => {
  const versao = Number(process.versions.node.split('.')[0]);
  if (versao < 22) {
    throw new Error(`Node ${process.versions.node}. O better-sqlite3 13.0.3 exige Node 22 ou superior.`);
  }
  return `Node ${process.versions.node}`;
});

let chaveApi = null;
const verificarChave = async () => {
  const { chave, origem } = resolverChaveApi();
  if (!chave) {
    throw new Error(
      'Nenhuma chave encontrada. Opções:\n' +
        '  npm run chave:definir                       (grava no cofre cifrado)\n' +
        `  criar ${CAMINHOS.ARQ_TEXTO}\n` +
        '  export ANTHROPIC_API_KEY=sk-ant-...\n' +
        '  npm run diagnostico -- --chave sk-ant-...'
    );
  }
  chaveApi = chave;
  const formatoOk = chave.startsWith('sk-ant-');
  return `${mascarar(chave)} · origem: ${origem}` + (formatoOk ? '' : '\nAtenção: formato fora do padrão "sk-ant-".');
};

if (semIa) {
  // Com --sem-ia a chave nem e usada; ausencia dela nao e falha.
  const { chave, origem } = resolverChaveApi();
  chaveApi = chave;
  if (chave) console.log(`${cor.ok('✓')} Chave da API Anthropic ${cor.fraco(`(${mascarar(chave)} · ${origem})`)}`);
  else pular('Chave da API Anthropic', 'flag --sem-ia');
} else {
  await etapa('Chave da API Anthropic', verificarChave);
}

// ---- 2. Banco de dados -----------------------------------------------------
titulo('2. Banco de dados');

let bancoOk = false;
bancoOk = await etapa('Abrir banco (somente leitura)', async () => {
  abrirBanco();
  const meta = obterMetadados();
  const nums = obterEstatisticas();
  return [
    `NCM: ${nums.ncm} registros (${nums.ncm_itens} itens de 8 dígitos)`,
    `CEST: ${nums.cest} códigos · ${nums.vinculos_cest_ncm} vínculos com NCM`,
    `Vigência: ${meta.ncm_vigencia} · carga em ${meta.carga_em?.slice(0, 10)}`,
  ].join('\n');
});

if (bancoOk) {
  await etapa('Proteção de escrita', async () => {
    try {
      abrirBanco().exec("INSERT INTO meta (chave, valor) VALUES ('teste','x')");
    } catch (erro) {
      return `Escrita bloqueada como esperado: ${erro.message}`;
    }
    throw new Error('O banco aceitou escrita. Ele deveria estar em modo somente leitura.');
  });

  await etapa('Busca por texto (FTS)', async () => {
    const casos = [
      ['cerveja de malte', '22030000'],
      ['sorvete', '21050010'],
      ['água gaseificada com açúcar', '22021000'],
    ];
    const linhas = [];
    for (const [termo, esperado] of casos) {
      const achados = buscarNcmPorTexto([termo], 10);
      const posicao = achados.findIndex((a) => a.codigo_numerico === esperado);
      if (posicao < 0) throw new Error(`"${termo}" não trouxe o NCM ${esperado} entre os 10 primeiros.`);
      linhas.push(`"${termo}" → ${achados[posicao].codigo} (posição ${posicao + 1} de ${achados.length})`);
    }
    return linhas.join('\n');
  });

  await etapa('Vínculo NCM → CEST', async () => {
    const cests = buscarCestPorNcm('22021000');
    if (cests.length === 0) throw new Error('NCM 2202.10.00 deveria ter CEST vinculado.');
    return `2202.10.00 → ${cests.length} CEST (ex.: ${cests[0].cest} · ${cests[0].segmento_nome})`;
  });
}

// ---- 3. Regras fiscais (sem IA) --------------------------------------------
titulo('3. Regras fiscais');

if (bancoOk) {
  await etapa('Alíquotas dos 9 estados do Nordeste', async () => {
    if (ESTADOS.length !== 9) throw new Error(`Esperado 9 estados, encontrado ${ESTADOS.length}.`);
    return ESTADOS.map((e) => `${e.uf} ${e.aliquota_icms}%`).join(' · ');
  });

  await etapa('Produto com ST · Regime Normal', async () => {
    const ncm = obterNcm('22021000');
    const ficha = montarFichaFiscal({
      ncm,
      cestsDoNcm: buscarCestPorNcm('22021000'),
      uf: 'PE',
      regime: 'regime_normal',
    });
    if (!ficha.substituicao_tributaria.possui) throw new Error('Refrigerante deveria ter ST.');
    if (ficha.cfop.codigo !== '5405') throw new Error(`CFOP esperado 5405, veio ${ficha.cfop.codigo}.`);
    if (ficha.icms.cst !== '060') throw new Error(`CST esperado 060, veio ${ficha.icms.cst}.`);
    return `NCM 2202.10.00 / PE → CEST ${ficha.substituicao_tributaria.cest.codigo} · CFOP ${ficha.cfop.codigo} · CST ${ficha.icms.cst} · ICMS ${ficha.icms.aliquota_interna}%`;
  });

  await etapa('Produto sem ST · Simples Nacional', async () => {
    const ncm = obterNcm('10063021'); // arroz polido, sem CEST vinculado
    const alvo = ncm ?? obterNcm('10064000');
    const ficha = montarFichaFiscal({
      ncm: alvo,
      cestsDoNcm: buscarCestPorNcm(alvo.codigo_numerico),
      uf: 'BA',
      regime: 'simples_nacional',
    });
    if (ficha.substituicao_tributaria.possui) {
      return `Atenção: ${alvo.codigo} tem CEST vinculado; verifique se é o esperado. CSOSN ${ficha.icms.csosn}.`;
    }
    if (ficha.cfop.codigo !== '5102') throw new Error(`CFOP esperado 5102, veio ${ficha.cfop.codigo}.`);
    if (ficha.icms.csosn !== '102') throw new Error(`CSOSN esperado 102, veio ${ficha.icms.csosn}.`);
    if (ficha.pis_cofins !== null) throw new Error('Simples Nacional não deve destacar PIS/COFINS.');
    return `NCM ${alvo.codigo} / BA → CFOP ${ficha.cfop.codigo} · CSOSN ${ficha.icms.csosn} · sem PIS/COFINS`;
  });

  await etapa('Regra do NCM residual ("Outros" não tem ST, exceto bebida)', async () => {
    const bd = abrirBanco();
    const residual = bd
      .prepare(
        `SELECT n.* FROM ncm n
           JOIN cest_ncm v ON v.ncm_prefixo = substr(n.codigo_numerico, 1, v.prefixo_tamanho)
          WHERE n.is_outros = 1 AND n.nivel = 8 AND n.capitulo <> '22'
          LIMIT 1`
      )
      .get();
    if (!residual) return 'Nenhum NCM residual com CEST encontrado para testar.';
    const ficha = montarFichaFiscal({
      ncm: residual,
      cestsDoNcm: buscarCestPorNcm(residual.codigo_numerico),
      uf: 'CE',
      regime: 'regime_normal',
    });
    if (ficha.substituicao_tributaria.possui) {
      throw new Error(`${residual.codigo} é residual e não-bebida, mas foi marcado com ST.`);
    }
    const bebida = obterNcm('22029900'); // "Outras" no capítulo 22
    const fichaBebida = bebida
      ? montarFichaFiscal({
          ncm: bebida,
          cestsDoNcm: buscarCestPorNcm('22029900'),
          uf: 'CE',
          regime: 'regime_normal',
        })
      : null;
    return [
      `${residual.codigo} ("${residual.descricao}") → sem ST, CFOP ${ficha.cfop.codigo}`,
      fichaBebida
        ? `2202.99.00 ("${bebida.descricao}", bebida) → ${fichaBebida.substituicao_tributaria.possui ? 'com ST (exceção aplicada)' : 'sem ST'}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  });
}

// ---- 4. Comunicação com a IA ----------------------------------------------
titulo('4. Comunicação com a IA');

let iaOk = false;
if (semIa) {
  pular('Conexão com a API da Anthropic', 'flag --sem-ia');
} else if (!chaveApi) {
  pular('Conexão com a API da Anthropic', 'chave não configurada');
} else {
  iaOk = await etapa(`Conexão com ${MODELO_IA}`, async () => {
    const r = await testarConexao(chaveApi);
    return [
      `Resposta: "${r.texto}"`,
      `Modelo confirmado: ${r.modelo}`,
      `Tokens: ${r.uso?.input_tokens ?? '?'} entrada / ${r.uso?.output_tokens ?? '?'} saída`,
      `Raciocínio adaptativo: ${config.ia.pensamento === 'adaptive' ? 'ligado' : 'desligado'}`,
      'Parâmetros de amostragem (temperature/top_p/top_k): não enviados — o Sonnet 5 rejeita.',
    ].join('\n');
  });

  if (iaOk) {
    await etapa('Tradução comercial → técnica', async () => {
      const r = await interpretarProduto(chaveApi, produtoTeste);
      return [
        `"${produtoTeste}" → ${r.produto_normalizado}`,
        `Categoria: ${r.categoria}`,
        `Termos: ${r.termos_tecnicos.join(' | ')}`,
      ].join('\n');
    });
  }
}

// ---- 5. Consulta ponta a ponta --------------------------------------------
titulo('5. Consulta ponta a ponta');

if (!iaOk || !bancoOk) {
  pular('Busca por produto', !bancoOk ? 'banco indisponível' : 'IA indisponível');
  pular('Busca por NCM', !bancoOk ? 'banco indisponível' : 'IA indisponível');
} else {
  await etapa(`Busca por produto: "${produtoTeste}" (${ufTeste}, ${regimeTeste})`, async () => {
    const r = await consultarPorProduto(chaveApi, { texto: produtoTeste, uf: ufTeste, regime: regimeTeste });
    const f = r.ficha;
    const linhas = [
      `NCM ${f.ncm.codigo} — ${f.ncm.descricao}`,
      `ST: ${f.substituicao_tributaria.possui ? 'sim' : 'não'}${f.substituicao_tributaria.cest ? ` · CEST ${f.substituicao_tributaria.cest.codigo}` : ''}`,
      `CFOP ${f.cfop.codigo} · ICMS ${f.icms.aliquota_interna}%${f.icms.cst ? ` · CST ${f.icms.cst}` : ''}${f.icms.csosn ? ` · CSOSN ${f.icms.csosn}` : ''}`,
      f.pis_cofins ? `PIS ${f.pis_cofins.pis.aliquota}% (CST ${f.pis_cofins.pis.cst}) · COFINS ${f.pis_cofins.cofins.aliquota}% (CST ${f.pis_cofins.cofins.cst})` : 'PIS/COFINS: não se aplica (Simples Nacional)',
      `Confiança da IA: ${r.escolha.confianca}`,
    ];
    for (const aviso of r.avisos) linhas.push(`Aviso: ${aviso}`);
    return linhas.join('\n');
  });

  await etapa(`Busca por NCM: ${ncmTeste} (${ufTeste})`, async () => {
    const r = await consultarPorNcm(chaveApi, { codigo: ncmTeste, uf: ufTeste });
    return [
      `${r.ncm.codigo} — ${r.ncm.descricao}`,
      r.explicacao ? `Em linguagem comercial: ${r.explicacao.descricao_comercial}` : 'Sem descrição comercial (IA indisponível).',
      r.explicacao?.exemplos_de_produtos?.length ? `Exemplos: ${r.explicacao.exemplos_de_produtos.join(', ')}` : '',
      `ST em ${r.estado.uf}: ${r.substituicao_tributaria.possui ? `sim · CEST ${r.substituicao_tributaria.cest.codigo}` : 'não'}`,
    ]
      .filter(Boolean)
      .join('\n');
  });
}

// ---- Resumo ----------------------------------------------------------------
titulo('Resumo');

const falhas = resumo.filter((r) => r.situacao === 'falhou');
const pulados = resumo.filter((r) => r.situacao === 'pulado');
console.log(
  `${cor.ok(`${resumo.filter((r) => r.situacao === 'ok').length} ok`)} · ` +
    `${falhas.length ? cor.falha(`${falhas.length} falha(s)`) : '0 falhas'} · ` +
    `${pulados.length} pulado(s)\n`
);

if (falhas.length) {
  for (const f of falhas) console.log(`${cor.falha('✗')} ${f.etapa}: ${f.motivo}`);
  console.log('');
  process.exit(1);
}
console.log(cor.ok('Sistema pronto para uso.\n'));
