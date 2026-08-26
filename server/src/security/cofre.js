/**
 * Cofre da chave da API Anthropic.
 *
 * O que este modulo garante:
 *  - a chave nunca e gravada em texto puro no disco (AES-256-GCM);
 *  - a chave nunca sai do processo do servidor: nao existe rota que a devolva,
 *    e ela nao entra em nenhum bundle do front-end;
 *  - os logs e as respostas de erro mostram apenas a chave mascarada.
 *
 * Origens aceitas, nesta ordem:
 *   1. variavel de ambiente ANTHROPIC_API_KEY
 *   2. secrets/anthropic.key.enc   (arquivo cifrado - forma recomendada)
 *   3. secrets/anthropic.key.txt   (texto puro - conveniencia, veja o aviso)
 *
 * A chave mestra que cifra o cofre vem de CHAVE_MESTRA (env). Sem ela, o
 * sistema gera uma chave aleatoria em secrets/.chave-mestra com permissao 600.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR_SEGREDOS = path.resolve(__dirname, '..', '..', 'secrets');
const ARQ_CIFRADO = path.join(DIR_SEGREDOS, 'anthropic.key.enc');
const ARQ_TEXTO = path.join(DIR_SEGREDOS, 'anthropic.key.txt');
const ARQ_CHAVE_MESTRA = path.join(DIR_SEGREDOS, '.chave-mestra');

const ALGORITMO = 'aes-256-gcm';
const TAMANHO_SAL = 16;
const TAMANHO_IV = 12;

function garantirDiretorio() {
  fs.mkdirSync(DIR_SEGREDOS, { recursive: true, mode: 0o700 });
}

function obterSenhaMestra() {
  const doAmbiente = process.env.CHAVE_MESTRA;
  if (doAmbiente && doAmbiente.trim()) return doAmbiente.trim();

  garantirDiretorio();
  if (fs.existsSync(ARQ_CHAVE_MESTRA)) {
    return fs.readFileSync(ARQ_CHAVE_MESTRA, 'utf8').trim();
  }
  const gerada = crypto.randomBytes(32).toString('base64');
  fs.writeFileSync(ARQ_CHAVE_MESTRA, gerada, { mode: 0o600 });
  return gerada;
}

function derivarChave(senha, sal) {
  return crypto.scryptSync(senha, sal, 32, { N: 16384, r: 8, p: 1 });
}

export function cifrar(textoPuro) {
  const sal = crypto.randomBytes(TAMANHO_SAL);
  const iv = crypto.randomBytes(TAMANHO_IV);
  const chave = derivarChave(obterSenhaMestra(), sal);
  const cifrador = crypto.createCipheriv(ALGORITMO, chave, iv);
  const conteudo = Buffer.concat([cifrador.update(textoPuro, 'utf8'), cifrador.final()]);
  const tag = cifrador.getAuthTag();
  return Buffer.concat([sal, iv, tag, conteudo]).toString('base64');
}

export function decifrar(pacoteBase64) {
  const pacote = Buffer.from(pacoteBase64, 'base64');
  const sal = pacote.subarray(0, TAMANHO_SAL);
  const iv = pacote.subarray(TAMANHO_SAL, TAMANHO_SAL + TAMANHO_IV);
  const tag = pacote.subarray(TAMANHO_SAL + TAMANHO_IV, TAMANHO_SAL + TAMANHO_IV + 16);
  const conteudo = pacote.subarray(TAMANHO_SAL + TAMANHO_IV + 16);
  const chave = derivarChave(obterSenhaMestra(), sal);
  const decifrador = crypto.createDecipheriv(ALGORITMO, chave, iv);
  decifrador.setAuthTag(tag);
  return Buffer.concat([decifrador.update(conteudo), decifrador.final()]).toString('utf8');
}

/** Grava a chave cifrada. Retorna o caminho do arquivo gerado. */
export function guardarChave(chaveApi) {
  const limpa = String(chaveApi ?? '').trim();
  if (!limpa) throw new Error('Chave vazia.');
  if (!limpa.startsWith('sk-ant-')) {
    throw new Error('A chave não parece uma chave da Anthropic (o formato esperado começa com "sk-ant-").');
  }
  garantirDiretorio();
  fs.writeFileSync(ARQ_CIFRADO, cifrar(limpa), { mode: 0o600 });
  return ARQ_CIFRADO;
}

/** Mostra apenas as pontas: sk-ant-a...4f2c */
export function mascarar(chave) {
  if (!chave) return '(vazia)';
  if (chave.length <= 14) return '***';
  return `${chave.slice(0, 10)}…${chave.slice(-4)}`;
}

/**
 * Carrega a chave. Devolve { chave, origem } ou { chave: null, origem: null }.
 * Nunca lanca por ausencia de chave - quem chama decide o que fazer.
 */
export function carregarChave() {
  const doAmbiente = process.env.ANTHROPIC_API_KEY;
  if (doAmbiente && doAmbiente.trim()) {
    return { chave: doAmbiente.trim(), origem: 'variável de ambiente ANTHROPIC_API_KEY' };
  }

  if (fs.existsSync(ARQ_CIFRADO)) {
    try {
      const chave = decifrar(fs.readFileSync(ARQ_CIFRADO, 'utf8').trim());
      return { chave, origem: 'cofre cifrado (secrets/anthropic.key.enc)' };
    } catch (erro) {
      throw new Error(
        'Não foi possível abrir o cofre secrets/anthropic.key.enc. ' +
          'Isso acontece quando a CHAVE_MESTRA mudou ou o arquivo secrets/.chave-mestra foi perdido. ' +
          'Rode "npm run chave:definir" para gravar a chave novamente. Detalhe: ' +
          erro.message
      );
    }
  }

  if (fs.existsSync(ARQ_TEXTO)) {
    const conteudo = fs
      .readFileSync(ARQ_TEXTO, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'));
    if (conteudo) {
      return { chave: conteudo, origem: 'arquivo de texto (secrets/anthropic.key.txt)' };
    }
  }

  return { chave: null, origem: null };
}

export function existeChaveEmTextoPuro() {
  return fs.existsSync(ARQ_TEXTO);
}

export const CAMINHOS = { ARQ_CIFRADO, ARQ_TEXTO, ARQ_CHAVE_MESTRA, DIR_SEGREDOS };
