/**
 * Camada de acesso ao banco.
 *
 * O banco e aberto em modo SOMENTE LEITURA. Nenhum caminho de execucao do
 * servidor - nem o que atende a IA - consegue escrever aqui. A unica escrita
 * acontece no script de carga (npm run db:build).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAMINHO_BANCO = path.resolve(__dirname, '..', '..', 'data', 'fiscal.db');

let conexao = null;

export function abrirBanco() {
  if (conexao) return conexao;
  if (!fs.existsSync(CAMINHO_BANCO)) {
    throw new Error(
      `Banco nao encontrado em ${CAMINHO_BANCO}.\n` + `Rode "npm run db:build" dentro da pasta server/ antes de iniciar o sistema.`
    );
  }
  conexao = new Database(CAMINHO_BANCO, { readonly: true, fileMustExist: true });
  conexao.pragma('query_only = ON');
  return conexao;
}

export function fecharBanco() {
  if (conexao) {
    conexao.close();
    conexao = null;
  }
}

// ---------------------------------------------------------------------------
// Normalizacao de entrada
// ---------------------------------------------------------------------------

export function normalizarCodigoNcm(entrada) {
  return String(entrada ?? '').replace(/\D/g, '');
}

/** "22021000" -> "2202.10.00" */
export function formatarNcm(digitos) {
  const d = normalizarCodigoNcm(digitos);
  if (d.length === 8) return `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}`;
  if (d.length === 4) return `${d.slice(0, 2)}.${d.slice(2, 4)}`;
  return d;
}

const PALAVRAS_IGNORADAS = new Set([
  'de', 'da', 'do', 'das', 'dos', 'e', 'ou', 'a', 'o', 'as', 'os', 'em', 'no', 'na',
  'nos', 'nas', 'com', 'sem', 'para', 'por', 'um', 'uma', 'que', 'ao', 'aos',
]);

/**
 * Transforma texto livre em uma expressao MATCH do FTS5.
 * Cada token vira prefixo (`cerveja*`) porque o FTS5 nao tem stemmer de
 * portugues - sem isso "sorvete" nao encontra "Sorvetes".
 */
function montarExpressaoFts(texto, operador = 'AND') {
  const tokens = String(texto ?? '')
    .toLowerCase()
    .replace(/["'^*(){}\[\]:+\-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !PALAVRAS_IGNORADAS.has(t))
    .slice(0, 8);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `${t}*`).join(` ${operador} `);
}

// ---------------------------------------------------------------------------
// Consultas de NCM
// ---------------------------------------------------------------------------

export function obterNcm(codigo) {
  const bd = abrirBanco();
  const digitos = normalizarCodigoNcm(codigo);
  if (!digitos) return null;
  return bd.prepare('SELECT * FROM ncm WHERE codigo_numerico = ?').get(digitos) ?? null;
}

/** Devolve a cadeia hierarquica do NCM, do capitulo ate o item. */
export function obterHierarquia(codigo) {
  const bd = abrirBanco();
  const digitos = normalizarCodigoNcm(codigo);
  const cadeia = [];
  let atual = digitos;
  const vistos = new Set();
  while (atual && !vistos.has(atual)) {
    vistos.add(atual);
    const linha = bd
      .prepare('SELECT codigo, descricao, nivel, codigo_pai FROM ncm WHERE codigo_numerico = ?')
      .get(atual);
    if (!linha) break;
    cadeia.unshift({ codigo: linha.codigo, descricao: linha.descricao, nivel: linha.nivel });
    atual = linha.codigo_pai;
  }
  return cadeia;
}

/** Itens de 8 digitos que descendem de um codigo (ou ele proprio, se ja for item). */
export function listarItensDescendentes(codigoNumerico, limite = 12) {
  const bd = abrirBanco();
  const digitos = normalizarCodigoNcm(codigoNumerico);
  if (digitos.length === 8) {
    const proprio = obterNcm(digitos);
    return proprio ? [proprio] : [];
  }
  return bd
    .prepare(
      `SELECT * FROM ncm
        WHERE nivel = 8 AND codigo_numerico LIKE ? || '%'
        ORDER BY codigo_numerico
        LIMIT ?`
    )
    .all(digitos, limite);
}

/**
 * Busca textual. Recebe uma lista de termos tecnicos (gerados pela IA a partir
 * do nome comercial) e devolve candidatos de NCM ordenados por relevancia.
 *
 * Estrategia: para cada termo tenta AND (mais preciso); se vier vazio, tenta OR.
 * Resultados em nivel de capitulo/posicao sao expandidos para os itens de
 * 8 digitos, que sao os operacionais na nota fiscal.
 */
export function buscarNcmPorTexto(termos, limite = 25) {
  const bd = abrirBanco();
  const lista = (Array.isArray(termos) ? termos : [termos]).filter(Boolean);
  const pontuacao = new Map();

  const consulta = bd.prepare(
    `SELECT f.codigo_numerico, bm25(ncm_fts, 0.0, 12.0, 1.0) AS relevancia
       FROM ncm_fts f
      WHERE ncm_fts MATCH ?
      ORDER BY relevancia
      LIMIT 40`
  );

  lista.forEach((termo, indice) => {
    // Termos vindos primeiro na lista pesam mais (a IA ordena do mais provavel).
    const peso = 1 / (1 + indice * 0.35);
    let linhas = [];
    const expressaoE = montarExpressaoFts(termo, 'AND');
    if (expressaoE) {
      try {
        linhas = consulta.all(expressaoE);
      } catch {
        linhas = [];
      }
    }
    if (linhas.length === 0) {
      const expressaoOu = montarExpressaoFts(termo, 'OR');
      if (expressaoOu) {
        try {
          linhas = consulta.all(expressaoOu);
        } catch {
          linhas = [];
        }
      }
    }
    for (const linha of linhas) {
      // bm25 devolve valores negativos (quanto menor, melhor). Invertemos.
      const nota = -linha.relevancia * peso;
      pontuacao.set(linha.codigo_numerico, (pontuacao.get(linha.codigo_numerico) ?? 0) + nota);
    }
  });

  if (pontuacao.size === 0) return [];

  // Expande resultados nao-folha para os itens de 8 digitos.
  const candidatos = new Map();
  const ordenados = [...pontuacao.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
  for (const [codigoNumerico, nota] of ordenados) {
    const itens = listarItensDescendentes(codigoNumerico, 8);
    for (const item of itens) {
      const notaAtual = candidatos.get(item.codigo_numerico)?.nota ?? 0;
      if (nota > notaAtual) candidatos.set(item.codigo_numerico, { ...item, nota });
    }
  }

  return [...candidatos.values()].sort((a, b) => b.nota - a.nota).slice(0, limite);
}

// ---------------------------------------------------------------------------
// Consultas de CEST
// ---------------------------------------------------------------------------

/**
 * CEST vinculados a um NCM.
 * O vinculo oficial pode ser por prefixo: o CEST 01.002.00 aponta para "3917",
 * cobrindo todos os NCM que comecam com 3917. Por isso comparamos por prefixo
 * e devolvemos primeiro os vinculos mais especificos.
 */
export function buscarCestPorNcm(codigo) {
  const bd = abrirBanco();
  const digitos = normalizarCodigoNcm(codigo);
  if (!digitos) return [];
  return bd
    .prepare(
      `SELECT c.cest, c.descricao, c.segmento_codigo, c.segmento_nome,
              v.ncm_original, v.prefixo_tamanho
         FROM cest_ncm v
         JOIN cest c ON c.cest = v.cest
        WHERE v.ncm_prefixo = substr(?, 1, v.prefixo_tamanho)
        ORDER BY v.prefixo_tamanho DESC, c.cest`
    )
    .all(digitos);
}

export function obterCest(codigoCest) {
  const bd = abrirBanco();
  return bd.prepare('SELECT * FROM cest WHERE cest = ?').get(String(codigoCest ?? '').trim()) ?? null;
}

// ---------------------------------------------------------------------------
// Metadados
// ---------------------------------------------------------------------------

export function obterMetadados() {
  const bd = abrirBanco();
  const linhas = bd.prepare('SELECT chave, valor FROM meta').all();
  return Object.fromEntries(linhas.map((l) => [l.chave, l.valor]));
}

export function obterEstatisticas() {
  const bd = abrirBanco();
  return {
    ncm: bd.prepare('SELECT COUNT(*) AS t FROM ncm').get().t,
    ncm_itens: bd.prepare('SELECT COUNT(*) AS t FROM ncm WHERE nivel = 8').get().t,
    cest: bd.prepare('SELECT COUNT(*) AS t FROM cest').get().t,
    vinculos_cest_ncm: bd.prepare('SELECT COUNT(*) AS t FROM cest_ncm').get().t,
  };
}
