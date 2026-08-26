/**
 * Servidor HTTP.
 *
 * Uso:
 *   npm start                       (chave vinda do cofre / .env / .txt)
 *   npm start -- --chave sk-ant-... (chave passada no console)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';

import { config, resolverChaveApi, resumoDaChave, MODELO_IA } from './config.js';
import { rotas } from './routes/index.js';
import { abrirBanco, obterMetadados } from './db/index.js';
import { mascarar } from './security/cofre.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PASTA_WEB = path.resolve(__dirname, '..', '..', 'web', 'dist');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// --- CORS -------------------------------------------------------------------
// Em rede local o front-end pode estar em outra maquina; a lista de origens
// permitidas fica em ORIGENS_PERMITIDAS (.env).
app.use(
  cors({
    origin(origem, retorno) {
      if (!origem) return retorno(null, true); // curl, apps nativos, mesma origem
      if (config.origensPermitidas.includes('*')) return retorno(null, true);
      if (config.origensPermitidas.includes(origem)) return retorno(null, true);
      return retorno(new Error(`Origem não autorizada: ${origem}`));
    },
    credentials: false,
  })
);

// --- Senha de acesso (opcional) ---------------------------------------------
// Protege o sistema inteiro. Nao tem relacao com a chave da Anthropic, que
// nunca sai do servidor.
app.use('/api', (req, res, proximo) => {
  if (!config.senhaAcesso) return proximo();
  if (req.path === '/saude') return proximo();
  if (req.get('x-acesso') === config.senhaAcesso) return proximo();
  return res.status(401).json({ erro: true, codigo: 'nao_autorizado', mensagem: 'Senha de acesso inválida ou ausente.' });
});

// --- Limite de requisicoes por IP -------------------------------------------
// Evita que um laco no cliente consuma a cota da API sem querer.
const contadores = new Map();
app.use('/api/consulta', (req, res, proximo) => {
  const agora = Date.now();
  const ip = req.ip ?? 'desconhecido';
  const janela = contadores.get(ip)?.filter((t) => agora - t < 60_000) ?? [];
  if (janela.length >= config.limiteRequisicoesPorMinuto) {
    return res.status(429).json({
      erro: true,
      codigo: 'limite_excedido',
      mensagem: `Limite de ${config.limiteRequisicoesPorMinuto} consultas por minuto atingido. Aguarde um instante.`,
    });
  }
  janela.push(agora);
  contadores.set(ip, janela);
  return proximo();
});

app.use('/api', rotas);

// --- Front-end compilado (opcional) -----------------------------------------
// Depois de "npm run build" em web/, o servidor entrega a interface tambem.
if (fs.existsSync(PASTA_WEB)) {
  app.use(express.static(PASTA_WEB));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(PASTA_WEB, 'index.html')));
}

app.use((erro, _req, res, _proximo) => {
  const status = erro.status ?? 500;
  res.status(status).json({ erro: true, codigo: erro.codigo ?? 'erro_interno', mensagem: erro.message });
});

// --- Inicializacao ----------------------------------------------------------

function enderecosDaRede() {
  const enderecos = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const rede of interfaces ?? []) {
      if (rede.family === 'IPv4' && !rede.internal) enderecos.push(rede.address);
    }
  }
  return enderecos;
}

try {
  abrirBanco();
  const meta = obterMetadados();
  console.log(`Banco carregado  · NCM ${meta.ncm_vigencia ?? '?'}`);
} catch (erro) {
  console.error('\n[ERRO] ' + erro.message + '\n');
  process.exit(1);
}

const { chave, origem } = resolverChaveApi();
if (chave) {
  console.log(`Chave da IA      · ${mascarar(chave)} (${origem})`);
} else {
  console.warn(
    '\n[AVISO] Nenhuma chave da Anthropic configurada. As consultas vão falhar até você rodar\n' +
      '        "npm run chave:definir" ou iniciar com --chave sk-ant-...\n'
  );
}
const aviso = resumoDaChave().aviso_texto_puro;
if (aviso) console.warn(`[AVISO] ${aviso}`);

app.listen(config.porta, config.host, () => {
  console.log(`Modelo           · ${MODELO_IA}`);
  console.log(`\nServidor no ar:`);
  console.log(`  local          http://localhost:${config.porta}`);
  for (const endereco of enderecosDaRede()) {
    console.log(`  rede local     http://${endereco}:${config.porta}`);
  }
  console.log(`\nOrigens liberadas (CORS): ${config.origensPermitidas.join(', ')}`);
  if (!config.senhaAcesso) {
    console.log('Sem senha de acesso. Defina SENHA_ACESSO no .env para exigir senha na rede.');
  }
});
