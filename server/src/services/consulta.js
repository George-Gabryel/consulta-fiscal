/**
 * Orquestracao das consultas.
 *
 * Fluxo por produto:
 *   texto do usuario -> IA traduz para termos tecnicos
 *                    -> BANCO devolve candidatos de NCM (+ CEST vinculados)
 *                    -> IA escolhe um candidato da lista
 *                    -> REGRAS montam a ficha fiscal (deterministico)
 *
 * Fluxo por NCM:
 *   codigo -> BANCO devolve o item e os CEST
 *          -> IA explica em linguagem comercial o que cai naquele codigo
 *          -> REGRAS avaliam ST / montam a ficha
 */

import {
  obterNcm,
  obterHierarquia,
  buscarNcmPorTexto,
  buscarCestPorNcm,
  listarItensDescendentes,
  normalizarCodigoNcm,
  formatarNcm,
} from '../db/index.js';
import { montarFichaFiscal, avaliarSubstituicaoTributaria, obterEstado, UFS_VALIDAS } from '../domain/regras-fiscais.js';
import { interpretarProduto, escolherNcm, explicarNcm } from './ia-fiscal.js';

export class ErroConsulta extends Error {
  constructor(mensagem, { status = 400, codigo = 'requisicao_invalida', extras = {} } = {}) {
    super(mensagem);
    this.name = 'ErroConsulta';
    this.status = status;
    this.codigo = codigo;
    this.extras = extras;
  }
}

/** Detecta se o usuario digitou um codigo NCM em vez de um nome de produto. */
export function pareceCodigoNcm(texto) {
  const limpo = String(texto ?? '').trim();
  if (!limpo) return false;
  if (!/^[\d.\s-]+$/.test(limpo)) return false;
  const digitos = limpo.replace(/\D/g, '');
  return digitos.length >= 4 && digitos.length <= 8;
}

function validarUf(uf) {
  const normalizada = String(uf ?? '').toUpperCase();
  if (!UFS_VALIDAS.includes(normalizada)) {
    throw new ErroConsulta(
      `Estado inválido. O sistema atende apenas o Nordeste: ${UFS_VALIDAS.join(', ')}.`,
      { codigo: 'uf_invalida' }
    );
  }
  return normalizada;
}

function anexarCests(itens) {
  return itens.map((item) => ({ ...item, cests: buscarCestPorNcm(item.codigo_numerico) }));
}

// ---------------------------------------------------------------------------
// Consulta por nome / descricao de produto
// ---------------------------------------------------------------------------

export async function consultarPorProduto(chaveApi, { texto, uf, regime }) {
  const termoUsuario = String(texto ?? '').trim();
  if (termoUsuario.length < 2) {
    throw new ErroConsulta('Digite o nome ou a descrição do produto.', { codigo: 'texto_curto' });
  }
  const ufValida = validarUf(uf);

  // 1. IA: nome comercial -> termos tecnicos.
  const interpretacao = await interpretarProduto(chaveApi, termoUsuario);

  // 2. Banco: candidatos. O texto original entra junto, caso o usuario ja
  //    tenha digitado o termo tecnico.
  const termosBusca = [...interpretacao.termos_tecnicos, termoUsuario];
  const encontrados = buscarNcmPorTexto(termosBusca, 12);

  if (encontrados.length === 0) {
    throw new ErroConsulta(
      `Nenhum NCM encontrado para "${termoUsuario}". Tente descrever o produto de outra forma (ex.: "refrigerante de cola" em vez da marca).`,
      {
        status: 404,
        codigo: 'sem_resultado',
        extras: { termos_pesquisados: interpretacao.termos_tecnicos },
      }
    );
  }

  const candidatos = anexarCests(encontrados);

  // 3. IA: escolhe um candidato da lista fechada.
  const escolha = await escolherNcm(chaveApi, {
    textoBusca: termoUsuario,
    interpretacao,
    candidatos,
  });

  const avisos = [];
  let selecionado = escolha.candidato;
  if (!selecionado) {
    selecionado = candidatos[0];
    avisos.push(
      escolha.fora_da_lista
        ? 'A IA sugeriu um código fora da lista do banco de dados e a sugestão foi descartada. Mostrando o candidato mais relevante da busca — confira antes de usar.'
        : 'A IA não encontrou um candidato adequado. Mostrando o mais relevante da busca — confira antes de usar.'
    );
  }
  if (escolha.confianca === 'baixa') {
    avisos.push('A IA classificou esta escolha como de baixa confiança. Confira o NCM com a contabilidade.');
  }

  // 4. Regras determinísticas.
  const ficha = montarFichaFiscal({
    ncm: selecionado,
    cestsDoNcm: selecionado.cests,
    uf: ufValida,
    regime,
    cestEscolhido: escolha.cest_escolhido,
  });

  return {
    tipo_busca: 'produto',
    consulta: { texto: termoUsuario, uf: ufValida, regime },
    interpretacao: {
      produto_normalizado: interpretacao.produto_normalizado,
      categoria: interpretacao.categoria,
      termos_tecnicos: interpretacao.termos_tecnicos,
      observacao: interpretacao.observacao,
    },
    escolha: {
      justificativa: escolha.justificativa,
      confianca: escolha.confianca,
    },
    ficha,
    alternativas: candidatos
      .filter((c) => c.codigo_numerico !== selecionado.codigo_numerico)
      .slice(0, 5)
      .map((c) => ({ codigo: c.codigo, descricao: c.descricao, hierarquia: c.descricao_completa })),
    avisos,
    hierarquia: obterHierarquia(selecionado.codigo_numerico),
  };
}

// ---------------------------------------------------------------------------
// Consulta direta por codigo NCM
// ---------------------------------------------------------------------------

export async function consultarPorNcm(chaveApi, { codigo, uf, regime = null }) {
  const digitos = normalizarCodigoNcm(codigo);
  if (digitos.length < 4) {
    throw new ErroConsulta('Informe ao menos 4 dígitos do NCM.', { codigo: 'ncm_curto' });
  }
  const ufValida = validarUf(uf);

  let ncm = obterNcm(digitos);

  // Codigo parcial (ex.: 2202) - sugere os itens de 8 digitos daquela posicao.
  if (!ncm || ncm.nivel !== 8) {
    const descendentes = listarItensDescendentes(digitos, 20);
    if (descendentes.length === 1) {
      ncm = descendentes[0];
    } else if (descendentes.length > 1) {
      throw new ErroConsulta(
        `${formatarNcm(digitos)} é uma posição da nomenclatura, não um item. Escolha um dos itens de 8 dígitos.`,
        {
          status: 400,
          codigo: 'ncm_incompleto',
          extras: {
            sugestoes: descendentes.map((d) => ({ codigo: d.codigo, descricao: d.descricao })),
          },
        }
      );
    } else if (!ncm) {
      throw new ErroConsulta(`NCM ${formatarNcm(digitos)} não existe na tabela vigente.`, {
        status: 404,
        codigo: 'ncm_inexistente',
      });
    }
  }

  const cests = buscarCestPorNcm(ncm.codigo_numerico);
  const hierarquia = obterHierarquia(ncm.codigo_numerico);

  // IA: traduz o texto tecnico para linguagem comercial.
  let explicacao = null;
  const avisos = [];
  try {
    explicacao = await explicarNcm(chaveApi, { ncm, hierarquia, cests });
  } catch (erro) {
    avisos.push(`A descrição comercial não pôde ser gerada (${erro.message}). Os dados fiscais abaixo não dependem da IA.`);
  }

  const estado = obterEstado(ufValida);
  const st = avaliarSubstituicaoTributaria({ ncm, cestsDoNcm: cests, uf: ufValida });

  // Se o regime foi informado, devolve a ficha completa.
  const ficha = regime
    ? montarFichaFiscal({ ncm, cestsDoNcm: cests, uf: ufValida, regime })
    : null;

  return {
    tipo_busca: 'ncm',
    consulta: { codigo: ncm.codigo, uf: ufValida, regime },
    ncm: {
      codigo: ncm.codigo,
      codigo_numerico: ncm.codigo_numerico,
      descricao: ncm.descricao,
      descricao_completa: ncm.descricao_completa,
      unidade: ncm.unidade,
      capitulo: ncm.capitulo,
      item_residual: ncm.is_outros === 1,
    },
    hierarquia,
    explicacao,
    estado: { uf: estado.uf, nome: estado.nome, aliquota_icms: estado.aliquota_icms },
    substituicao_tributaria: {
      possui: st.tem_st,
      cest: st.cest ? { codigo: st.cest.cest, descricao: st.cest.descricao, segmento: st.cest.segmento_nome } : null,
      motivos: st.motivos,
      cest_candidatos: cests.map((c) => ({
        codigo: c.cest,
        descricao: c.descricao,
        segmento: c.segmento_nome,
        vinculo_ncm: c.ncm_original,
      })),
    },
    ficha,
    avisos,
  };
}
