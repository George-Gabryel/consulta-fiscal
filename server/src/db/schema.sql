-- ============================================================================
--  Banco de dados fiscal - NCM / CEST
--  Somente leitura em tempo de execucao. A escrita acontece apenas no
--  script de carga (npm run db:build).
-- ============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- NCM (Nomenclatura Comum do Mercosul)
--   codigo          -> formatado, ex. "2202.10.00"
--   codigo_numerico -> apenas digitos, ex. "22021000" (usado nas buscas/joins)
--   nivel           -> 2 capitulo | 4 posicao | 5-7 subposicao | 8 item/subitem
--   descricao       -> texto original da tabela oficial
--   descricao_completa -> descricao concatenada com a hierarquia (pai -> filho).
--                         E o que da sentido a descricoes como "-- Outros".
-- ---------------------------------------------------------------------------
CREATE TABLE ncm (
  codigo_numerico     TEXT PRIMARY KEY,
  codigo              TEXT NOT NULL,
  descricao           TEXT NOT NULL,
  descricao_completa  TEXT NOT NULL,
  nivel               INTEGER NOT NULL,
  codigo_pai          TEXT REFERENCES ncm(codigo_numerico),
  capitulo            TEXT NOT NULL,
  unidade             TEXT,
  is_outros           INTEGER NOT NULL DEFAULT 0,
  data_inicio         TEXT,
  data_fim            TEXT,
  ato                 TEXT
);

CREATE INDEX idx_ncm_pai       ON ncm(codigo_pai);
CREATE INDEX idx_ncm_nivel     ON ncm(nivel);
CREATE INDEX idx_ncm_capitulo  ON ncm(capitulo);

-- ---------------------------------------------------------------------------
-- CEST (Codigo Especificador da Substituicao Tributaria) - Conv. ICMS 142/2018
-- ---------------------------------------------------------------------------
CREATE TABLE cest (
  cest              TEXT PRIMARY KEY,
  descricao         TEXT NOT NULL,
  segmento_codigo   TEXT NOT NULL,
  segmento_nome     TEXT NOT NULL
);

CREATE INDEX idx_cest_segmento ON cest(segmento_codigo);

-- ---------------------------------------------------------------------------
-- Relacao CEST x NCM.
-- O NCM da tabela CEST pode ser um prefixo (ex. "3917" cobre todo 3917.xx.xx),
-- por isso guardamos tambem o prefixo numerico e seu tamanho.
-- ---------------------------------------------------------------------------
CREATE TABLE cest_ncm (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  cest              TEXT NOT NULL REFERENCES cest(cest),
  ncm_prefixo       TEXT NOT NULL,   -- apenas digitos, pode ter 2 a 8 caracteres
  ncm_original      TEXT NOT NULL,   -- como veio na fonte
  prefixo_tamanho   INTEGER NOT NULL
);

CREATE INDEX idx_cest_ncm_prefixo ON cest_ncm(ncm_prefixo);
CREATE INDEX idx_cest_ncm_cest    ON cest_ncm(cest);
CREATE INDEX idx_cest_ncm_tam     ON cest_ncm(prefixo_tamanho);

-- ---------------------------------------------------------------------------
-- Busca textual (FTS5) sobre as descricoes de NCM.
-- remove_diacritics=2 permite buscar "acucar" e achar "açúcar".
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE ncm_fts USING fts5(
  codigo_numerico UNINDEXED,
  descricao,
  descricao_completa,
  tokenize = "unicode61 remove_diacritics 2"
);

-- ---------------------------------------------------------------------------
-- Metadados da carga (versao das tabelas oficiais usadas).
-- ---------------------------------------------------------------------------
CREATE TABLE meta (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
