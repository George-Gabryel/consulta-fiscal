/**
 * Motor de regras fiscais.
 *
 * Este modulo e deterministico: dados o NCM, o CEST, a UF e o regime, o
 * resultado e sempre o mesmo. A IA nao participa desta etapa - ela apenas
 * ajuda a descobrir QUAL NCM/CEST consultar. Toda a definicao de CFOP, CST,
 * CSOSN, aliquota e ST sai daqui e dos arquivos em config/.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR_CONFIG = path.resolve(__dirname, '..', '..', 'config');

function lerConfig(arquivo) {
  return JSON.parse(fs.readFileSync(path.join(DIR_CONFIG, arquivo), 'utf8'));
}

const CFG_ESTADOS = lerConfig('estados.json');
const CFG_ST = lerConfig('substituicao-tributaria.json');
const CFG_TRIBUTOS = lerConfig('tributos.json');

export const ESTADOS = CFG_ESTADOS.estados;
export const UFS_VALIDAS = ESTADOS.map((e) => e.uf);
export const REGIMES = [
  { valor: 'simples_nacional', rotulo: 'Simples Nacional' },
  { valor: 'regime_normal', rotulo: 'Regime Normal' },
];

export function obterEstado(uf) {
  return ESTADOS.find((e) => e.uf === String(uf ?? '').toUpperCase()) ?? null;
}

// ---------------------------------------------------------------------------
// Substituicao Tributaria
// ---------------------------------------------------------------------------

/**
 * Decide se a operacao tem ST na UF escolhida e qual CEST aplicar.
 *
 * @param {object} ncm         linha da tabela ncm
 * @param {Array}  cestsDoNcm  CEST vinculados ao NCM (vindos do banco)
 * @param {string} uf          sigla do estado
 * @param {string} cestEscolhido  CEST selecionado (pela IA ou pelo usuario), opcional
 */
export function avaliarSubstituicaoTributaria({ ncm, cestsDoNcm = [], uf, cestEscolhido = null }) {
  const motivos = [];
  const ufNormalizada = String(uf ?? '').toUpperCase();
  const configUf = CFG_ST.por_uf[ufNormalizada] ?? { segmentos_excluidos: [], cest_excluidos: [] };

  if (cestsDoNcm.length === 0) {
    motivos.push('NCM sem CEST vinculado na tabela do Convênio ICMS 142/2018.');
    return { tem_st: false, cest: null, motivos, candidatos: [] };
  }

  // Se veio um CEST escolhido, ele precisa estar entre os vinculados ao NCM.
  let selecionado = null;
  if (cestEscolhido) {
    selecionado = cestsDoNcm.find((c) => c.cest === cestEscolhido) ?? null;
    if (!selecionado) {
      motivos.push(`CEST ${cestEscolhido} não está vinculado a este NCM; usando o vínculo mais específico da tabela.`);
    }
  }
  if (!selecionado) selecionado = cestsDoNcm[0]; // ja vem ordenado do mais especifico

  // Regra do cliente: NCM residual ("Outros"/"Outras") nao tem ST, exceto bebidas.
  const regraOutros = CFG_ST.regra_ncm_outros;
  if (regraOutros?.ativa && ncm.is_outros === 1) {
    const excecao = regraOutros.excecao_bebidas ?? { capitulos_ncm: [], segmentos_cest: [] };
    const ehBebida =
      (excecao.capitulos_ncm ?? []).includes(ncm.capitulo) ||
      (excecao.segmentos_cest ?? []).includes(selecionado.segmento_codigo);
    if (!ehBebida) {
      motivos.push(
        `NCM ${ncm.codigo} é item residual ("${ncm.descricao}") e não é bebida — tratado como sem Substituição Tributária.`
      );
      return { tem_st: false, cest: null, motivos, candidatos: cestsDoNcm };
    }
    motivos.push('NCM residual, mas classificado como bebida — a exceção mantém a Substituição Tributária.');
  }

  // Excecoes configuradas para a UF.
  if ((configUf.cest_excluidos ?? []).includes(selecionado.cest)) {
    motivos.push(`CEST ${selecionado.cest} está na lista de exceções de ${ufNormalizada}.`);
    return { tem_st: false, cest: null, motivos, candidatos: cestsDoNcm };
  }
  if ((configUf.segmentos_excluidos ?? []).includes(selecionado.segmento_codigo)) {
    motivos.push(
      `Segmento ${selecionado.segmento_codigo} (${selecionado.segmento_nome}) não é adotado em ${ufNormalizada} conforme configuração local.`
    );
    return { tem_st: false, cest: null, motivos, candidatos: cestsDoNcm };
  }

  motivos.push(
    `CEST ${selecionado.cest} — segmento ${selecionado.segmento_codigo} (${selecionado.segmento_nome}) adotado em ${ufNormalizada}.`
  );
  return { tem_st: true, cest: selecionado, motivos, candidatos: cestsDoNcm };
}

// ---------------------------------------------------------------------------
// Montagem da ficha fiscal
// ---------------------------------------------------------------------------

function perfilPisCofins(temSt, segmentoCest) {
  const monofasicos = CFG_TRIBUTOS.segmentos_cest_monofasicos?.codigos ?? [];
  if (segmentoCest && monofasicos.includes(segmentoCest)) {
    return { chave: 'monofasico_revenda', ...CFG_TRIBUTOS.pis_cofins.monofasico_revenda };
  }
  const padrao = CFG_TRIBUTOS.perfil_pis_cofins_padrao ?? 'nao_cumulativo';
  return { chave: padrao, ...CFG_TRIBUTOS.pis_cofins[padrao] };
}

/**
 * Monta a ficha fiscal completa a partir do NCM + UF + regime.
 * Retorna sempre a mesma estrutura, com os campos irrelevantes em null.
 */
export function montarFichaFiscal({ ncm, cestsDoNcm = [], uf, regime, cestEscolhido = null }) {
  const estado = obterEstado(uf);
  if (!estado) throw new Error(`UF inválida: ${uf}. Válidas: ${UFS_VALIDAS.join(', ')}`);

  const regimeNormalizado = String(regime ?? '').toLowerCase();
  if (!REGIMES.some((r) => r.valor === regimeNormalizado)) {
    throw new Error(`Regime inválido: ${regime}. Válidos: ${REGIMES.map((r) => r.valor).join(', ')}`);
  }

  const st = avaliarSubstituicaoTributaria({ ncm, cestsDoNcm, uf: estado.uf, cestEscolhido });
  const temSt = st.tem_st;

  const cfop = temSt ? CFG_TRIBUTOS.cfop.substituicao_tributaria : CFG_TRIBUTOS.cfop.tributado_normal;
  const alertas = [];

  // --- ICMS ---------------------------------------------------------------
  const icms = {
    aliquota_interna: estado.aliquota_icms,
    aliquota_destacada: temSt ? 0 : estado.aliquota_icms,
    cst: null,
    cst_descricao: null,
    csosn: null,
    csosn_descricao: null,
  };

  if (regimeNormalizado === 'regime_normal') {
    const cst = temSt ? CFG_TRIBUTOS.cst_icms.substituicao_tributaria : CFG_TRIBUTOS.cst_icms.tributado_normal;
    icms.cst = cst.codigo;
    icms.cst_descricao = cst.descricao;
    if (temSt) {
      alertas.push('CST 060: o ICMS já foi retido pelo substituto — não há destaque de ICMS próprio na saída.');
    }
  } else {
    const csosn = temSt ? CFG_TRIBUTOS.csosn.substituicao_tributaria : CFG_TRIBUTOS.csosn.tributado_normal;
    icms.csosn = csosn.codigo;
    icms.csosn_descricao = csosn.descricao;
    alertas.push('Simples Nacional: o ICMS é recolhido no DAS. A alíquota interna aparece apenas como referência da UF.');
  }

  // --- PIS / COFINS (somente Regime Normal) -------------------------------
  let pisCofins = null;
  if (regimeNormalizado === 'regime_normal') {
    const perfil = perfilPisCofins(temSt, st.cest?.segmento_codigo ?? null);
    pisCofins = {
      perfil: perfil.chave,
      perfil_rotulo: perfil.rotulo,
      pis: { ...perfil.pis },
      cofins: { ...perfil.cofins },
    };
    if (perfil.chave === 'monofasico_revenda') {
      alertas.push(
        `Segmento CEST ${st.cest?.segmento_codigo} costuma ser monofásico: na revenda o PIS/COFINS sai com CST 04 e alíquota zero. Confirme com a contabilidade.`
      );
    }
  } else {
    alertas.push('Simples Nacional: PIS e COFINS estão incluídos no DAS e não são destacados na nota.');
  }

  return {
    ncm: {
      codigo: ncm.codigo,
      codigo_numerico: ncm.codigo_numerico,
      descricao: ncm.descricao,
      descricao_completa: ncm.descricao_completa,
      capitulo: ncm.capitulo,
      unidade: ncm.unidade,
      item_residual: ncm.is_outros === 1,
    },
    estado: { uf: estado.uf, nome: estado.nome },
    regime: {
      valor: regimeNormalizado,
      rotulo: REGIMES.find((r) => r.valor === regimeNormalizado).rotulo,
    },
    substituicao_tributaria: {
      possui: temSt,
      cest: st.cest ? { codigo: st.cest.cest, descricao: st.cest.descricao, segmento: st.cest.segmento_nome, segmento_codigo: st.cest.segmento_codigo } : null,
      motivos: st.motivos,
      cest_candidatos: st.candidatos.map((c) => ({
        codigo: c.cest,
        descricao: c.descricao,
        segmento: c.segmento_nome,
        vinculo_ncm: c.ncm_original,
      })),
    },
    cfop: { codigo: cfop.codigo, descricao: cfop.descricao },
    icms,
    pis_cofins: pisCofins,
    alertas,
    base_legal: CFG_ST.base_legal,
  };
}

export function configuracaoPublica() {
  return {
    estados: ESTADOS,
    regimes: REGIMES,
    base_legal: CFG_ST.base_legal,
    perfil_pis_cofins: CFG_TRIBUTOS.perfil_pis_cofins_padrao,
  };
}
