/**
 * Carga do banco de dados fiscal.
 *
 *   npm run db:build
 *
 * Le os arquivos oficiais em ./fontes e gera ./data/fiscal.db.
 * Este e o UNICO ponto do sistema que escreve no banco. Em tempo de execucao
 * (e portanto para a IA) o banco e aberto somente para leitura.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..', '..');
const DIR_FONTES = path.join(RAIZ, 'fontes');
const DIR_DADOS = path.join(RAIZ, 'data');
const CAMINHO_BANCO = path.join(DIR_DADOS, 'fiscal.db');
const CAMINHO_SCHEMA = path.join(__dirname, 'schema.sql');

// --------------------------------------------------------------------------
// Utilidades
// --------------------------------------------------------------------------

/** Remove tudo que nao for digito. "0101.21.00" -> "01012100" */
function somenteDigitos(valor) {
  return String(valor ?? '').replace(/\D/g, '');
}

/** Formata um codigo numerico de NCM no padrao oficial. */
function formatarNcm(digitos) {
  if (digitos.length === 8) {
    return `${digitos.slice(0, 4)}.${digitos.slice(4, 6)}.${digitos.slice(6, 8)}`;
  }
  if (digitos.length === 4) return `${digitos.slice(0, 2)}.${digitos.slice(2, 4)}`;
  return digitos;
}

/** Tira os tracos de hierarquia do inicio da descricao: "-- Outros" -> "Outros". */
function limparDescricao(texto) {
  return String(texto ?? '')
    .replace(/^[\s\-–—.]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A tabela oficial usa descricoes hierarquicas. Um item como
 * "0101.29.00 -- Outros" so faz sentido junto dos seus ancestrais:
 * "Animais vivos > Cavalos, asininos e muares, vivos > Cavalos > Outros".
 * Sem isso, qualquer busca textual por descricao vira ruido.
 */
function montarDescricaoCompleta(codigo, mapa) {
  const partes = [];
  let atual = codigo;
  const visitados = new Set();
  while (atual && !visitados.has(atual)) {
    visitados.add(atual);
    const no = mapa.get(atual);
    if (!no) break;
    if (no.descricaoLimpa) partes.unshift(no.descricaoLimpa);
    atual = no.codigoPai;
  }
  return partes.join(' > ');
}

/** Localiza o pai de um codigo: o maior prefixo existente e mais curto que ele. */
function encontrarPai(codigo, existentes) {
  for (let tam = codigo.length - 1; tam >= 2; tam -= 1) {
    const candidato = codigo.slice(0, tam);
    if (existentes.has(candidato)) return candidato;
  }
  return null;
}

function lerJson(nomeArquivo) {
  const caminho = path.join(DIR_FONTES, nomeArquivo);
  if (!fs.existsSync(caminho)) {
    throw new Error(
      `Arquivo de origem nao encontrado: ${caminho}\n` +
        `Coloque as tabelas oficiais (.json) dentro de ${DIR_FONTES}.`
    );
  }
  return JSON.parse(fs.readFileSync(caminho, 'utf8'));
}

/** Descobre o nome do arquivo por prefixo, para tolerar mudanca de data. */
function acharArquivo(prefixo) {
  const arquivos = fs.readdirSync(DIR_FONTES).filter((f) => f.startsWith(prefixo) && f.endsWith('.json'));
  if (arquivos.length === 0) throw new Error(`Nenhum arquivo "${prefixo}*.json" em ${DIR_FONTES}`);
  return arquivos.sort().reverse()[0]; // o mais recente pela ordem alfabetica da data
}

// --------------------------------------------------------------------------
// Carga
// --------------------------------------------------------------------------

function construir() {
  fs.mkdirSync(DIR_DADOS, { recursive: true });
  for (const sufixo of ['', '-wal', '-shm']) {
    const arquivo = CAMINHO_BANCO + sufixo;
    if (fs.existsSync(arquivo)) fs.unlinkSync(arquivo);
  }

  const bd = new Database(CAMINHO_BANCO);
  bd.exec(fs.readFileSync(CAMINHO_SCHEMA, 'utf8'));

  // ---- NCM -----------------------------------------------------------------
  const arquivoNcm = acharArquivo('Tabela_NCM_Vigente');
  const arquivoSubitem = acharArquivo('Tabela_NCM_SUBITEM_Vigente');

  const tabelaNcm = lerJson(arquivoNcm);
  const tabelaSubitem = lerJson(arquivoSubitem);

  // Unidade de medida so existe na tabela de subitens.
  const unidadePorCodigo = new Map();
  for (const item of tabelaSubitem.Nomenclaturas ?? []) {
    const digitos = somenteDigitos(item.Codigo);
    if (item.SiglaUme) unidadePorCodigo.set(digitos, item.SiglaUme);
  }

  const registros = new Map();
  for (const item of tabelaNcm.Nomenclaturas ?? []) {
    const digitos = somenteDigitos(item.Codigo);
    if (!digitos) continue;
    // A tabela pode repetir codigos com vigencias diferentes; fica o primeiro.
    if (registros.has(digitos)) continue;
    registros.set(digitos, {
      codigoNumerico: digitos,
      codigoOriginal: item.Codigo,
      descricao: String(item.Descricao ?? '').trim(),
      descricaoLimpa: limparDescricao(item.Descricao),
      dataInicio: item.Data_Inicio ?? null,
      dataFim: item.Data_Fim ?? null,
      ato: [item.Tipo_Ato_Ini, item.Numero_Ato_Ini, item.Ano_Ato_Ini].filter(Boolean).join(' ') || null,
      codigoPai: null,
    });
  }

  const existentes = new Set(registros.keys());
  for (const registro of registros.values()) {
    registro.codigoPai = encontrarPai(registro.codigoNumerico, existentes);
  }

  const inserirNcm = bd.prepare(`
    INSERT INTO ncm (codigo_numerico, codigo, descricao, descricao_completa, nivel,
                     codigo_pai, capitulo, unidade, is_outros, data_inicio, data_fim, ato)
    VALUES (@codigo_numerico, @codigo, @descricao, @descricao_completa, @nivel,
            @codigo_pai, @capitulo, @unidade, @is_outros, @data_inicio, @data_fim, @ato)
  `);
  const inserirFts = bd.prepare(
    `INSERT INTO ncm_fts (codigo_numerico, descricao, descricao_completa) VALUES (?, ?, ?)`
  );

  // "Outros" / "Outras" identifica itens residuais da nomenclatura. A regra de
  // negocio do sistema depende disso, entao marcamos na carga.
  const regexOutros = /^(outros|outras)\b/i;

  const gravarNcm = bd.transaction(() => {
    // Ordenar por tamanho garante que o pai exista antes do filho (FK).
    const ordenados = [...registros.values()].sort(
      (a, b) => a.codigoNumerico.length - b.codigoNumerico.length || a.codigoNumerico.localeCompare(b.codigoNumerico)
    );
    for (const registro of ordenados) {
      const descricaoCompleta = montarDescricaoCompleta(registro.codigoNumerico, registros);
      const linha = {
        codigo_numerico: registro.codigoNumerico,
        codigo: formatarNcm(registro.codigoNumerico),
        descricao: registro.descricaoLimpa || registro.descricao,
        descricao_completa: descricaoCompleta,
        nivel: registro.codigoNumerico.length,
        codigo_pai: registro.codigoPai,
        capitulo: registro.codigoNumerico.slice(0, 2),
        unidade: unidadePorCodigo.get(registro.codigoNumerico) ?? null,
        is_outros: regexOutros.test(registro.descricaoLimpa) ? 1 : 0,
        data_inicio: registro.dataInicio,
        data_fim: registro.dataFim,
        ato: registro.ato,
      };
      inserirNcm.run(linha);
      inserirFts.run(linha.codigo_numerico, linha.descricao, linha.descricao_completa);
    }
  });
  gravarNcm();

  // ---- CEST ----------------------------------------------------------------
  const tabelaCest = lerJson('cest.json');
  const inserirCest = bd.prepare(`
    INSERT OR IGNORE INTO cest (cest, descricao, segmento_codigo, segmento_nome)
    VALUES (?, ?, ?, ?)
  `);
  const gravarCest = bd.transaction(() => {
    for (const item of tabelaCest.dados ?? []) {
      const cest = String(item.cest ?? '').trim();
      if (!cest) continue;
      const segmentoBruto = String(item.segmento ?? '').trim();
      const casamento = segmentoBruto.match(/^(\d+)\.\s*(.*)$/);
      const segmentoCodigo = casamento ? casamento[1].padStart(2, '0') : cest.slice(0, 2);
      const segmentoNome = casamento ? casamento[2] : segmentoBruto || 'Nao informado';
      inserirCest.run(cest, String(item.descricao ?? '').trim(), segmentoCodigo, segmentoNome);
    }
  });
  gravarCest();

  // ---- CEST x NCM ----------------------------------------------------------
  const tabelaCestNcm = lerJson('cest_ncm.json');
  const inserirVinculo = bd.prepare(`
    INSERT INTO cest_ncm (cest, ncm_prefixo, ncm_original, prefixo_tamanho)
    VALUES (?, ?, ?, ?)
  `);
  const cestConhecidos = new Set(bd.prepare('SELECT cest FROM cest').all().map((l) => l.cest));
  let vinculosIgnorados = 0;
  const gravarVinculos = bd.transaction(() => {
    for (const item of tabelaCestNcm.dados ?? []) {
      const cest = String(item.cest ?? '').trim();
      const prefixo = somenteDigitos(item.ncm);
      if (!cest || !prefixo) continue;
      if (!cestConhecidos.has(cest)) {
        vinculosIgnorados += 1;
        continue;
      }
      inserirVinculo.run(cest, prefixo, String(item.ncm).trim(), prefixo.length);
    }
  });
  gravarVinculos();

  // ---- Metadados -----------------------------------------------------------
  const inserirMeta = bd.prepare('INSERT OR REPLACE INTO meta (chave, valor) VALUES (?, ?)');
  inserirMeta.run('ncm_vigencia', tabelaNcm.Data_Ultima_Atualizacao_NCM ?? 'nao informado');
  inserirMeta.run('ncm_ato', tabelaNcm.Ato ?? 'nao informado');
  inserirMeta.run('cest_gerado_em', tabelaCest.gerado_em ?? 'nao informado');
  inserirMeta.run('carga_em', new Date().toISOString());
  inserirMeta.run('arquivo_ncm', arquivoNcm);
  inserirMeta.run('arquivo_ncm_subitem', arquivoSubitem);

  bd.exec("INSERT INTO ncm_fts(ncm_fts) VALUES('optimize')");

  const contar = (tabela) => bd.prepare(`SELECT COUNT(*) AS total FROM ${tabela}`).get().total;
  const resumo = {
    ncm: contar('ncm'),
    ncm_itens_8_digitos: bd.prepare('SELECT COUNT(*) AS total FROM ncm WHERE nivel = 8').get().total,
    cest: contar('cest'),
    cest_ncm: contar('cest_ncm'),
    vinculos_ignorados: vinculosIgnorados,
  };

  bd.close();
  return { caminho: CAMINHO_BANCO, resumo, vigencia: tabelaNcm.Data_Ultima_Atualizacao_NCM };
}

const resultado = construir();
console.log('Banco gerado em:', resultado.caminho);
console.log('Vigencia NCM   :', resultado.vigencia);
console.table(resultado.resumo);
