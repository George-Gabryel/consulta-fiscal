/**
 * Rotas da API.
 *
 * Regra de ouro: a chave da Anthropic nunca aparece em resposta nenhuma.
 * O front-end conversa apenas com estas rotas; quem fala com a IA e o servidor.
 */

import { Router } from 'express';
import { config, resolverChaveApi, resumoDaChave, MODELO_IA } from '../config.js';
import { configuracaoPublica } from '../domain/regras-fiscais.js';
import { obterMetadados, obterEstatisticas, buscarCestPorNcm, obterNcm, obterHierarquia } from '../db/index.js';
import { consultarPorProduto, consultarPorNcm, pareceCodigoNcm, ErroConsulta } from '../services/consulta.js';
import { ErroNaoImplementado } from '../services/exportacao-excel.js';

export const rotas = Router();

function chave() {
  return resolverChaveApi().chave;
}

function responderErro(res, erro) {
  const status = erro.status ?? 500;
  res.status(status).json({
    erro: true,
    codigo: erro.codigo ?? 'erro_interno',
    mensagem: erro.message ?? 'Erro inesperado.',
    ...(erro.extras ?? {}),
  });
}

// ---------------------------------------------------------------------------
// Saude e referencia
// ---------------------------------------------------------------------------

rotas.get('/saude', (_req, res) => {
  let banco = null;
  let erroBanco = null;
  try {
    banco = { ...obterEstatisticas(), ...obterMetadados() };
  } catch (erro) {
    erroBanco = erro.message;
  }
  res.json({
    status: erroBanco ? 'degradado' : 'ok',
    ambiente: config.ambiente,
    modelo_ia: MODELO_IA,
    // Apenas se a chave existe e de onde veio - nunca o valor.
    chave_ia: resumoDaChave(),
    banco,
    erro_banco: erroBanco,
  });
});

rotas.get('/referencias', (_req, res) => {
  res.json({ ...configuracaoPublica(), fonte_dados: obterMetadados() });
});

// ---------------------------------------------------------------------------
// Consulta unificada
// ---------------------------------------------------------------------------

rotas.post('/consulta', async (req, res) => {
  try {
    const { texto, uf, regime, tipo } = req.body ?? {};
    const entrada = String(texto ?? '').trim();

    if (!entrada) {
      throw new ErroConsulta('Informe o produto ou o código NCM que deseja consultar.', { codigo: 'entrada_vazia' });
    }

    // "tipo" pode vir do front-end; se nao vier, deduzimos pelo formato.
    const buscarPorCodigo = tipo === 'ncm' || (tipo !== 'produto' && pareceCodigoNcm(entrada));

    if (buscarPorCodigo) {
      const resultado = await consultarPorNcm(chave(), { codigo: entrada, uf, regime: regime || null });
      return res.json(resultado);
    }

    if (!regime) {
      throw new ErroConsulta('Selecione o regime tributário para buscar por nome de produto.', {
        codigo: 'regime_ausente',
      });
    }
    const resultado = await consultarPorProduto(chave(), { texto: entrada, uf, regime });
    return res.json(resultado);
  } catch (erro) {
    return responderErro(res, erro);
  }
});

// ---------------------------------------------------------------------------
// Consulta direta ao banco (sem IA) - util para conferencia e para o suporte
// ---------------------------------------------------------------------------

rotas.get('/ncm/:codigo', (req, res) => {
  try {
    const ncm = obterNcm(req.params.codigo);
    if (!ncm) {
      return res.status(404).json({ erro: true, codigo: 'ncm_inexistente', mensagem: 'NCM não encontrado.' });
    }
    return res.json({
      ncm,
      hierarquia: obterHierarquia(ncm.codigo_numerico),
      cests: buscarCestPorNcm(ncm.codigo_numerico),
    });
  } catch (erro) {
    return responderErro(res, erro);
  }
});

// ---------------------------------------------------------------------------
// Planilha Excel - reservado (ver src/services/exportacao-excel.js)
// ---------------------------------------------------------------------------

rotas.post('/planilha', (_req, res) => {
  const erro = new ErroNaoImplementado(
    'A entrega de dados fiscais por planilha ainda não está disponível: o modelo do arquivo Excel será definido em breve. ' +
      'A estrutura já está preparada em server/src/services/exportacao-excel.js.'
  );
  responderErro(res, erro);
});

rotas.get('/planilha/status', (_req, res) => {
  res.json({
    disponivel: false,
    mensagem: 'Aguardando definição do modelo da planilha.',
    pronto: ['processamento em lote', 'regras fiscais', 'integração com a IA'],
    pendente: ['leitura do .xlsx de entrada', 'geração do .xlsx de saída', 'mapa de colunas'],
  });
});
