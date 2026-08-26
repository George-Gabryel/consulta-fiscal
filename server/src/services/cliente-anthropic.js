/**
 * Cliente da Messages API da Anthropic.
 *
 * Feito com fetch nativo (Node 22) em vez do SDK para deixar o corpo da
 * requisicao explicito e auditavel - especialmente as restricoes do modelo.
 *
 * ATENCAO - restricoes do Claude Sonnet 5 (verificadas na documentacao oficial,
 * https://platform.claude.com/docs/en/models/sonnet-5/whats-new-sonnet-5):
 *
 *   1. temperature / top_p / top_k  -> NAO sao aceitos. Enviar qualquer um
 *      deles com valor diferente do padrao devolve erro 400. Por isso este
 *      arquivo simplesmente nao possui esses campos, e ha um teste de guarda
 *      em montarCorpo() que impede alguem de reintroduzi-los sem perceber.
 *      Para controlar o comportamento do modelo, use o system prompt.
 *
 *   2. thinking: {type:"enabled", budget_tokens:N} -> removido, devolve 400.
 *      O raciocinio adaptativo vem ligado por padrao; aqui ele fica desligado
 *      (thinking: {type:"disabled"}) porque as tarefas sao curtas e objetivas.
 *
 *   3. Preenchimento da mensagem do assistente (prefill) -> nao suportado.
 *      Para obter JSON usamos output_config.format (structured outputs).
 *
 *   4. max_tokens limita o total da saida. Recusas de seguranca voltam com
 *      HTTP 200 e stop_reason "refusal" - tratadas abaixo como erro de negocio.
 */

import { config, URL_API_ANTHROPIC, VERSAO_API_ANTHROPIC } from '../config.js';

const PARAMETROS_PROIBIDOS = ['temperature', 'top_p', 'top_k', 'temperatura'];

export class ErroIA extends Error {
  constructor(mensagem, { codigo = 'erro_ia', status = 502, detalhe = null } = {}) {
    super(mensagem);
    this.name = 'ErroIA';
    this.codigo = codigo;
    this.status = status;
    this.detalhe = detalhe;
  }
}

function montarCorpo({ system, mensagens, esquema, maxTokens }) {
  const corpo = {
    model: config.ia.modelo,
    max_tokens: maxTokens ?? config.ia.maxTokens,
    system,
    messages: mensagens,
    thinking: { type: config.ia.pensamento === 'adaptive' ? 'adaptive' : 'disabled' },
  };

  if (esquema) {
    corpo.output_config = {
      format: { type: 'json_schema', schema: esquema },
    };
  }

  // Guarda: se alguem adicionar um parametro de amostragem no futuro, o erro
  // aparece aqui, com mensagem clara, em vez de virar um 400 opaco da API.
  for (const proibido of PARAMETROS_PROIBIDOS) {
    if (proibido in corpo) {
      throw new ErroIA(
        `O parâmetro "${proibido}" não é aceito pelo ${config.ia.modelo} e foi removido do projeto. ` +
          'Use o system prompt para orientar o comportamento do modelo.',
        { codigo: 'parametro_nao_suportado', status: 500 }
      );
    }
  }

  return corpo;
}

/**
 * Chama o modelo e devolve { texto, json, uso, modelo }.
 * @param {string}   chaveApi  chave resolvida pelo cofre
 * @param {object}   opcoes    { system, mensagens, esquema, maxTokens }
 */
export async function chamarModelo(chaveApi, opcoes) {
  if (!chaveApi) {
    throw new ErroIA(
      'Chave da API Anthropic não configurada. Rode "npm run chave:definir" ou defina ANTHROPIC_API_KEY.',
      { codigo: 'chave_ausente', status: 503 }
    );
  }

  const corpo = montarCorpo(opcoes);
  const controlador = new AbortController();
  const alarme = setTimeout(() => controlador.abort(), config.ia.tempoLimiteMs);

  let resposta;
  try {
    resposta = await fetch(URL_API_ANTHROPIC, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': chaveApi,
        'anthropic-version': VERSAO_API_ANTHROPIC,
      },
      body: JSON.stringify(corpo),
      signal: controlador.signal,
    });
  } catch (erro) {
    if (erro.name === 'AbortError') {
      throw new ErroIA(`A IA não respondeu em ${config.ia.tempoLimiteMs / 1000}s.`, {
        codigo: 'tempo_esgotado',
        status: 504,
      });
    }
    throw new ErroIA(`Falha de rede ao falar com a API da Anthropic: ${erro.message}`, {
      codigo: 'falha_rede',
      status: 502,
    });
  } finally {
    clearTimeout(alarme);
  }

  const bruto = await resposta.text();
  let dados;
  try {
    dados = JSON.parse(bruto);
  } catch {
    throw new ErroIA('A API da Anthropic devolveu uma resposta que não é JSON.', {
      codigo: 'resposta_invalida',
      status: 502,
      detalhe: bruto.slice(0, 400),
    });
  }

  if (!resposta.ok) {
    const mensagem = dados?.error?.message ?? `HTTP ${resposta.status}`;
    const mapa = {
      401: 'Chave da API recusada (401). Confira a chave em secrets/ ou em ANTHROPIC_API_KEY.',
      403: 'Acesso negado (403). Verifique se a chave tem permissão para este modelo.',
      404: `Modelo "${config.ia.modelo}" não encontrado (404). Confira o identificador do modelo.`,
      429: 'Limite de uso da API atingido (429). Tente novamente em instantes.',
      529: 'A API da Anthropic está sobrecarregada (529). Tente novamente em instantes.',
    };
    throw new ErroIA(mapa[resposta.status] ?? `Erro da API da Anthropic: ${mensagem}`, {
      codigo: dados?.error?.type ?? 'erro_api',
      status: resposta.status === 429 ? 429 : 502,
      detalhe: mensagem,
    });
  }

  if (dados.stop_reason === 'refusal') {
    throw new ErroIA('O modelo recusou a solicitação por política de uso.', {
      codigo: 'recusa',
      status: 422,
    });
  }
  if (dados.stop_reason === 'max_tokens') {
    throw new ErroIA('A resposta da IA foi cortada por limite de tokens. Aumente IA_MAX_TOKENS.', {
      codigo: 'limite_tokens',
      status: 502,
    });
  }

  const texto = (dados.content ?? [])
    .filter((bloco) => bloco.type === 'text')
    .map((bloco) => bloco.text)
    .join('\n')
    .trim();

  let json = null;
  if (opcoes.esquema) {
    try {
      json = JSON.parse(texto);
    } catch {
      // Rede de seguranca: se vier cercado por ``` (nao deve acontecer com
      // structured outputs), ainda assim recuperamos o JSON.
      const limpo = texto.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      try {
        json = JSON.parse(limpo);
      } catch {
        throw new ErroIA('A IA não devolveu um JSON válido.', {
          codigo: 'json_invalido',
          status: 502,
          detalhe: texto.slice(0, 400),
        });
      }
    }
  }

  return {
    texto,
    json,
    modelo: dados.model,
    uso: dados.usage ?? null,
    stop_reason: dados.stop_reason ?? null,
  };
}

/** Chamada minima usada pelo diagnostico. */
export async function testarConexao(chaveApi) {
  const inicio = Date.now();
  const resultado = await chamarModelo(chaveApi, {
    system: 'Responda exatamente com a palavra OK, sem pontuação e sem nenhuma outra palavra.',
    mensagens: [{ role: 'user', content: 'teste de conexão' }],
    maxTokens: 16,
  });
  return { ...resultado, duracaoMs: Date.now() - inicio };
}
