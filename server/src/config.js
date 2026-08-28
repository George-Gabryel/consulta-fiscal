/**
 * Configuracao de execucao do servidor.
 * Tudo que muda entre a maquina local e o servidor da rede sai daqui.
 */

import 'dotenv/config';
import { carregarChave, mascarar, existeChaveEmTextoPuro } from './security/cofre.js';

// O modelo e a unica string de modelo do projeto. Ver README (secao "IA").
export const MODELO_IA = 'claude-sonnet-5';
export const URL_API_ANTHROPIC = 'https://api.anthropic.com/v1/messages';
export const VERSAO_API_ANTHROPIC = '2023-06-01';

function lerLista(valor, padrao) {
  if (!valor || !valor.trim()) return padrao;
  return valor
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

export const config = {
  porta: Number(process.env.PORTA ?? 3001),
  // 0.0.0.0 permite acesso pelos outros computadores da rede local.
  host: process.env.HOST ?? '0.0.0.0',
  ambiente: process.env.NODE_ENV ?? 'development',

  // Origens autorizadas a chamar a API (CORS). Esta lista e um acrescimo: a
  // mesma origem do servidor e os enderecos de rede local ja sao aceitos por
  // padrao (ver src/security/origens.js). Use "*" para liberar tudo.
  origensPermitidas: lerLista(process.env.ORIGENS_PERMITIDAS, []),

  // Aceitar chamadas vindas de enderecos da rede local (192.168.x, 10.x,
  // 172.16-31.x, localhost, nomes .local). E o padrao porque o sistema foi
  // feito para rodar dentro da rede da empresa. PERMITIR_REDE_LOCAL=nao deixa
  // valer somente ORIGENS_PERMITIDAS e a mesma origem.
  permitirRedeLocal: process.env.PERMITIR_REDE_LOCAL !== 'nao',

  // Senha simples de acesso ao sistema (opcional). Se definida, o front-end
  // precisa enviar o cabecalho x-acesso. Nao tem relacao com a chave da IA.
  senhaAcesso: process.env.SENHA_ACESSO ?? null,

  // Limite de requisicoes por IP por minuto nas rotas que consomem a IA.
  limiteRequisicoesPorMinuto: Number(process.env.LIMITE_REQ_MINUTO ?? 30),

  ia: {
    modelo: MODELO_IA,
    // max_tokens cobre o texto da resposta. O Sonnet 5 tem raciocinio adaptativo
    // ligado por padrao; aqui ele fica desligado porque a tarefa e curta e
    // objetiva (traduzir termo comercial -> termo tecnico e escolher da lista).
    maxTokens: Number(process.env.IA_MAX_TOKENS ?? 1500),
    pensamento: process.env.IA_PENSAMENTO === 'ligado' ? 'adaptive' : 'disabled',
    tempoLimiteMs: Number(process.env.IA_TIMEOUT_MS ?? 45000),
  },
};

/**
 * Resolve a chave da API. Ordem: --chave / -k na linha de comando,
 * depois variavel de ambiente, cofre cifrado e arquivo .txt.
 */
export function resolverChaveApi(argv = process.argv) {
  const indice = argv.findIndex((a) => a === '--chave' || a === '-k');
  if (indice >= 0 && argv[indice + 1]) {
    return { chave: argv[indice + 1].trim(), origem: 'linha de comando (--chave)' };
  }
  const comIgual = argv.find((a) => a.startsWith('--chave='));
  if (comIgual) {
    return { chave: comIgual.slice('--chave='.length).trim(), origem: 'linha de comando (--chave=)' };
  }
  return carregarChave();
}

/** Resumo seguro para log/diagnostico: nunca inclui a chave inteira. */
export function resumoDaChave() {
  try {
    const { chave, origem } = resolverChaveApi();
    return {
      configurada: Boolean(chave),
      origem,
      mascara: chave ? mascarar(chave) : null,
      aviso_texto_puro: existeChaveEmTextoPuro()
        ? 'Existe uma chave em texto puro em secrets/anthropic.key.txt. Rode "npm run chave:definir" para movê-la ao cofre cifrado.'
        : null,
    };
  } catch (erro) {
    return { configurada: false, origem: null, mascara: null, erro: erro.message };
  }
}
