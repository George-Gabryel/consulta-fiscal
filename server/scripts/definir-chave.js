#!/usr/bin/env node
/**
 * Grava a chave da API Anthropic no cofre cifrado.
 *
 *   npm run chave:definir                    pergunta no console (entrada oculta)
 *   npm run chave:definir -- --chave sk-...   passa direto pelo comando
 *   npm run chave:definir -- --do-arquivo     importa secrets/anthropic.key.txt
 *
 * Depois de gravar, o arquivo em texto puro pode (e deve) ser apagado.
 */

import fs from 'node:fs';
import readline from 'node:readline';
import { guardarChave, mascarar, CAMINHOS, carregarChave } from '../src/security/cofre.js';
import { testarConexao } from '../src/services/cliente-anthropic.js';

function argumento(nome) {
  const i = process.argv.indexOf(`--${nome}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  const comIgual = process.argv.find((a) => a.startsWith(`--${nome}=`));
  return comIgual ? comIgual.slice(nome.length + 3) : null;
}

/** Le do console sem ecoar os caracteres digitados. */
function perguntarOculto(rotulo) {
  return new Promise((resolver) => {
    const leitor = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const saida = process.stdout;
    const escreverOriginal = saida.write.bind(saida);
    let ocultando = false;
    saida.write = (pedaco, ...resto) => {
      if (ocultando && typeof pedaco === 'string' && !pedaco.includes('\n')) return true;
      return escreverOriginal(pedaco, ...resto);
    };
    leitor.question(rotulo, (resposta) => {
      saida.write = escreverOriginal;
      escreverOriginal('\n');
      leitor.close();
      resolver(resposta.trim());
    });
    ocultando = true;
  });
}

async function principal() {
  console.log('\nCofre da chave Anthropic');
  console.log('─'.repeat(40));

  let chave = argumento('chave');

  if (!chave && process.argv.includes('--do-arquivo')) {
    if (!fs.existsSync(CAMINHOS.ARQ_TEXTO)) {
      console.error(`\nArquivo não encontrado: ${CAMINHOS.ARQ_TEXTO}`);
      process.exit(1);
    }
    chave = fs
      .readFileSync(CAMINHOS.ARQ_TEXTO, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'));
    console.log(`Chave lida de ${CAMINHOS.ARQ_TEXTO}`);
  }

  if (!chave) {
    chave = await perguntarOculto('Cole a chave (sk-ant-...) e pressione Enter: ');
  }

  if (!chave) {
    console.error('Nenhuma chave informada.');
    process.exit(1);
  }

  let caminho;
  try {
    caminho = guardarChave(chave);
  } catch (erro) {
    console.error(`\n${erro.message}`);
    process.exit(1);
  }

  console.log(`\nChave gravada  · ${mascarar(chave)}`);
  console.log(`Arquivo        · ${caminho}`);
  console.log(`Chave mestra   · ${process.env.CHAVE_MESTRA ? 'variável CHAVE_MESTRA' : CAMINHOS.ARQ_CHAVE_MESTRA}`);

  // Confere se a chave funciona de verdade.
  process.stdout.write('\nTestando a chave na API... ');
  try {
    const { chave: recarregada } = carregarChave();
    const r = await testarConexao(recarregada);
    console.log(`ok (${r.modelo}, ${r.duracaoMs}ms)`);
  } catch (erro) {
    console.log('falhou');
    console.error(`  ${erro.message}`);
    console.error('  A chave foi gravada mesmo assim. Rode "npm run diagnostico" depois de corrigir.');
    process.exit(1);
  }

  if (fs.existsSync(CAMINHOS.ARQ_TEXTO)) {
    console.log(`\nAgora você pode apagar o arquivo em texto puro:\n  rm ${CAMINHOS.ARQ_TEXTO}`);
  }
  console.log('');
}

principal();
