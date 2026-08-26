/**
 * ===========================================================================
 *  ESPACO RESERVADO - entrega automatica de dados fiscais por planilha Excel
 * ===========================================================================
 *
 * O que ja funciona: processarLote(). Ela recebe uma lista de produtos e
 * devolve a ficha fiscal de cada um, na mesma ordem, com os erros isolados
 * por linha. E a parte que nao depende do formato da planilha.
 *
 * O que falta: ler o arquivo .xlsx de entrada e escrever o .xlsx de saida.
 * Isso depende do modelo de planilha que ainda sera definido. As duas funcoes
 * lerPlanilha() e gerarPlanilha() estao com a assinatura pronta e lancam
 * ErroNaoImplementado ate la.
 *
 * Passo a passo para concluir quando o modelo chegar:
 *   1. cd server && npm install exceljs
 *   2. preencher MAPA_COLUNAS abaixo com os cabecalhos reais da planilha;
 *   3. implementar lerPlanilha() e gerarPlanilha();
 *   4. liberar a rota POST /api/planilha em src/routes/planilha.js
 *      (hoje ela responde 501 com esta mesma explicacao);
 *   5. no front-end, ativar o cartao de upload em web/src/components/PainelPlanilha.jsx.
 *
 * Nada mais precisa mudar: as regras fiscais e a IA ja sao reaproveitadas.
 */

import { consultarPorProduto, consultarPorNcm, pareceCodigoNcm } from './consulta.js';

export class ErroNaoImplementado extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'ErroNaoImplementado';
    this.status = 501;
    this.codigo = 'nao_implementado';
  }
}

/**
 * Mapa entre as colunas da planilha e os campos do sistema.
 * PREENCHER quando o modelo da planilha for definido.
 *
 * entrada: cabecalho na planilha recebida -> campo interno
 * saida:   campo interno -> cabecalho na planilha gerada
 */
export const MAPA_COLUNAS = {
  entrada: {
    // 'Descrição do produto': 'texto',
    // 'NCM': 'codigo_ncm',
    // 'UF': 'uf',
    // 'Regime': 'regime',
  },
  saida: {
    // codigo_ncm: 'NCM',
    // cest: 'CEST',
    // cfop: 'CFOP',
    // aliquota_icms: 'Alíquota ICMS (%)',
    // cst_icms: 'CST ICMS',
    // csosn: 'CSOSN',
    // pis_aliquota: 'PIS (%)',
    // cofins_aliquota: 'COFINS (%)',
  },
};

/**
 * Le a planilha enviada e devolve as linhas normalizadas.
 * @param {Buffer} _buffer conteudo do arquivo .xlsx
 * @returns {Promise<Array<{texto?:string, codigo_ncm?:string, uf:string, regime:string}>>}
 */
export async function lerPlanilha(_buffer) {
  throw new ErroNaoImplementado(
    'A leitura de planilhas ainda não foi implementada: o modelo do arquivo será definido em breve. ' +
      'Veja as instruções em server/src/services/exportacao-excel.js.'
  );
}

/**
 * Gera a planilha de saida com os resultados.
 * @param {Array} _resultados saida de processarLote()
 * @returns {Promise<Buffer>} conteudo .xlsx
 */
export async function gerarPlanilha(_resultados) {
  throw new ErroNaoImplementado(
    'A geração de planilhas ainda não foi implementada: o modelo do arquivo será definido em breve. ' +
      'Veja as instruções em server/src/services/exportacao-excel.js.'
  );
}

/**
 * Processa varias linhas reaproveitando o mesmo caminho da consulta individual.
 * Ja esta pronto para uso - so falta a camada de planilha em volta.
 *
 * @param {string} chaveApi
 * @param {Array}  linhas  [{ texto?, codigo_ncm?, uf, regime }]
 * @param {object} opcoes  { concorrencia }  chamadas simultaneas a IA
 */
export async function processarLote(chaveApi, linhas, { concorrencia = 3 } = {}) {
  const resultados = new Array(linhas.length);
  let proxima = 0;

  async function trabalhador() {
    while (proxima < linhas.length) {
      const indice = proxima;
      proxima += 1;
      const linha = linhas[indice];
      try {
        const entrada = linha.codigo_ncm ?? linha.texto ?? '';
        const resultado = linha.codigo_ncm || pareceCodigoNcm(entrada)
          ? await consultarPorNcm(chaveApi, { codigo: entrada, uf: linha.uf, regime: linha.regime })
          : await consultarPorProduto(chaveApi, { texto: entrada, uf: linha.uf, regime: linha.regime });
        resultados[indice] = { linha: indice + 1, entrada: linha, ok: true, resultado };
      } catch (erro) {
        // Uma linha com problema nao derruba o lote inteiro.
        resultados[indice] = {
          linha: indice + 1,
          entrada: linha,
          ok: false,
          erro: erro.message,
          codigo: erro.codigo ?? 'erro',
        };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concorrencia) }, trabalhador));
  return resultados;
}
