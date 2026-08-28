/**
 * Servidor HTTP.
 *
 * Uso:
 *   npm start                       (chave vinda do cofre / .env / .txt)
 *   npm start -- --chave sk-ant-... (chave passada no console)
 *
 * Em producao este processo entrega as duas coisas na mesma porta: a interface
 * compilada (web/dist) e a API (/api). E o modo recomendado para a rede local,
 * porque o navegador so precisa saber um endereco: http://IP-DO-SERVIDOR:3001.
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
import { avaliarOrigem } from './security/origens.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PASTA_WEB = path.resolve(__dirname, '..', '..', 'web', 'dist');
const INDICE_WEB = path.join(PASTA_WEB, 'index.html');

/** Verificado a cada pedido: permite gerar o build com o servidor no ar. */
function interfaceCompilada() {
  return fs.existsSync(INDICE_WEB);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// --- CORS -------------------------------------------------------------------
// So a API precisa de CORS. Os arquivos da interface ficam de fora de proposito:
// um erro de origem nunca deve impedir a pagina de carregar.
//
// A politica esta em security/origens.js. O resumo: mesma origem e enderecos
// de rede local passam; o resto depende de ORIGENS_PERMITIDAS.
const origensJaAvisadas = new Set();

app.use('/api', (req, res, proximo) => {
  const origem = req.get('origin');
  const veredito = avaliarOrigem(origem, req.get('host'), config);

  if (!veredito.permitida) {
    // Um 403 com corpo explicito e muito mais util no suporte do que o 500
    // generico que o middleware do cors produzia.
    if (!origensJaAvisadas.has(origem)) {
      origensJaAvisadas.add(origem);
      console.warn(
        `[CORS] Origem recusada: ${origem} (${veredito.motivo}).\n` +
          `       Se este endereco e legitimo, acrescente-o a ORIGENS_PERMITIDAS no server/.env.`
      );
    }
    // Devolvemos o cabecalho de CORS junto do 403 de proposito: sem ele o
    // navegador esconde a resposta e o usuario so ve "nao foi possivel falar
    // com o servidor". A mensagem nao expoe dado nenhum - so diz o que ajustar.
    if (origem) res.set('Access-Control-Allow-Origin', origem);
    return res.status(403).json({
      erro: true,
      codigo: 'origem_nao_autorizada',
      mensagem:
        `A origem ${origem} não está autorizada a chamar esta API (${veredito.motivo}). ` +
        'Acrescente-a a ORIGENS_PERMITIDAS no server/.env e reinicie o servidor.',
    });
  }
  return proximo();
});

// A decisao ja foi tomada no middleware acima. Aqui o cors so cuida da parte
// mecanica: espelhar a origem aceita em Access-Control-Allow-Origin e
// responder o pre-flight (OPTIONS).
app.use('/api', cors({ origin: true, credentials: false }));

// --- Senha de acesso (opcional) ---------------------------------------------
// Protege o sistema inteiro. Nao tem relacao com a chave da Anthropic, que
// nunca sai do servidor.
app.use('/api', (req, res, proximo) => {
  if (!config.senhaAcesso) return proximo();
  if (req.method === 'OPTIONS') return proximo(); // pre-flight nao carrega cabecalho
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

// Rota /api inexistente responde JSON, e nao o HTML padrao do Express - assim
// o front-end consegue mostrar o erro em vez de estourar no JSON.parse.
app.use('/api', (req, res) => {
  res.status(404).json({
    erro: true,
    codigo: 'rota_inexistente',
    mensagem: `Rota ${req.method} /api${req.path} não existe.`,
  });
});

const PAGINA_SEM_BUILD = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Interface não compilada</title>
<style>
 body{font:15px/1.6 system-ui,sans-serif;margin:0;padding:2.5rem 1.5rem;background:#f6f6f4;color:#1b1b1a}
 main{max-width:38rem;margin:0 auto;background:#fff;border:1px solid #ddd;border-radius:6px;padding:1.75rem}
 h1{font-size:1.15rem;margin:0 0 .75rem}
 code{background:#f0f0ee;padding:.15rem .35rem;border-radius:3px;font-size:.9em}
 pre{background:#1b1b1a;color:#f6f6f4;padding:.9rem 1rem;border-radius:4px;overflow-x:auto}
</style></head><body><main>
<h1>A API está no ar, mas a interface ainda não foi compilada.</h1>
<p>O servidor não encontrou <code>web/dist/index.html</code>. Gere o build na
raiz do projeto e recarregue esta página (não é preciso reiniciar o servidor):</p>
<pre>npm run build</pre>
<p>Para conferir que a API responde, abra <a href="/api/saude">/api/saude</a>.</p>
</main></body></html>`;

// --- Front-end compilado ----------------------------------------------------
// Depois de "npm run build" em web/, o servidor entrega a interface tambem.
app.use(express.static(PASTA_WEB));
app.get(/^\/(?!api).*/, (_req, res) => {
  if (interfaceCompilada()) return res.sendFile(INDICE_WEB);
  // Sem o build, o Express respondia "Cannot GET /" - o que parece o sistema
  // inteiro fora do ar. Melhor dizer o que falta fazer.
  return res.status(503).type('html').send(PAGINA_SEM_BUILD);
});

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

if (!interfaceCompilada()) {
  console.warn(
    '\n[AVISO] A interface não está compilada (web/dist/index.html não existe).\n' +
      '        O servidor sobe assim mesmo e responde /api, mas quem abrir o endereço no\n' +
      '        navegador verá um aviso. Rode "npm run build" na raiz do projeto.\n'
  );
}

app.listen(config.porta, config.host, () => {
  console.log(`Modelo           · ${MODELO_IA}`);
  console.log(`Interface        · ${interfaceCompilada() ? 'servida por este processo (web/dist)' : 'NÃO compilada - rode "npm run build"'}`);
  console.log(`\nServidor no ar:`);
  console.log(`  local          http://localhost:${config.porta}`);
  const enderecos = enderecosDaRede();
  for (const endereco of enderecos) {
    console.log(`  rede local     http://${endereco}:${config.porta}`);
  }
  if (enderecos.length === 0) {
    console.log('  (nenhuma interface de rede IPv4 encontrada além da local)');
  }
  console.log(
    `\nCORS: mesma origem${config.permitirRedeLocal ? ' + qualquer endereço da rede local' : ''}` +
      `${config.origensPermitidas.length ? ` + ${config.origensPermitidas.join(', ')}` : ''}.`
  );
  if (!config.senhaAcesso) {
    console.log('Sem senha de acesso. Defina SENHA_ACESSO no .env para exigir senha na rede.');
  }
  if (config.host !== '0.0.0.0' && config.host !== '::') {
    console.log(`[AVISO] HOST=${config.host}: outras máquinas da rede não vão conseguir se conectar. Use HOST=0.0.0.0.`);
  }
  console.log('Se a rede não enxergar o servidor, libere a porta no firewall da máquina.');
});
