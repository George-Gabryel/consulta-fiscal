/**
 * Papel da IA no sistema.
 *
 * A IA faz exatamente tres coisas, todas de leitura/tradução:
 *   1. traduzir o nome comercial ("Coca-Cola", "Budweiser") para os termos
 *      tecnicos usados na nomenclatura NCM ("água gaseificada adicionada de
 *      açúcar", "cerveja de malte");
 *   2. escolher UM item de uma lista de candidatos que o BANCO devolveu;
 *   3. explicar, em linguagem comercial, o que e um NCM ja encontrado.
 *
 * A IA NAO cria dado fiscal. Ela nao define ST, CFOP, CST, CSOSN nem aliquota
 * - isso e responsabilidade de src/domain/regras-fiscais.js. E toda escolha
 * que ela faz e conferida contra a lista de candidatos antes de ser aceita:
 * se o codigo devolvido nao estiver na lista, ele e descartado.
 */

import { chamarModelo, ErroIA } from './cliente-anthropic.js';

// ---------------------------------------------------------------------------
// 1. Nome comercial -> termos tecnicos de busca
// ---------------------------------------------------------------------------

const SISTEMA_INTERPRETAR = `Você traduz nomes comerciais de produtos para a linguagem técnica da NCM (Nomenclatura Comum do Mercosul) brasileira.

Recebe: o que um usuário digitou (marca, apelido, nome de prateleira ou descrição solta).
Devolve: termos de busca no vocabulário da tabela NCM, que usa linguagem aduaneira formal.

Regras:
- Gere de 3 a 6 termos, do mais provável para o menos provável.
- Use os substantivos que a NCM usaria, não a marca. Exemplos do tipo de tradução esperada:
  "Coca-Cola" -> "águas gaseificadas adicionadas de açúcar", "refrigerante", "bebida não alcoólica"
  "Budweiser" -> "cervejas de malte", "cerveja"
  "Picolé" -> "sorvetes", "gelados comestíveis"
  "Risoto pronto" -> "preparações alimentícias à base de arroz", "arroz preparado"
- Cada termo deve ter de 1 a 4 palavras. Termos longos não encontram nada.
- Não invente códigos NCM nem CEST. Você só produz palavras de busca.
- Se o texto for genérico demais para identificar um produto, devolva os termos mais próximos possíveis e diga isso em "observacao".
- Escreva em português do Brasil.`;

const ESQUEMA_INTERPRETAR = {
  type: 'object',
  properties: {
    produto_normalizado: { type: 'string', description: 'O produto em linguagem comum, sem marca. Ex.: "refrigerante de cola em lata".' },
    categoria: { type: 'string', description: 'Categoria comercial ampla. Ex.: "bebida não alcoólica".' },
    termos_tecnicos: {
      type: 'array',
      description: 'De 3 a 6 termos de busca no vocabulário da NCM, do mais provável ao menos provável.',
      items: { type: 'string' },
    },
    observacao: { type: 'string', description: 'Ressalva sobre a interpretação, ou string vazia.' },
  },
  required: ['produto_normalizado', 'categoria', 'termos_tecnicos', 'observacao'],
  additionalProperties: false,
};

export async function interpretarProduto(chaveApi, textoBusca) {
  const resultado = await chamarModelo(chaveApi, {
    system: SISTEMA_INTERPRETAR,
    mensagens: [{ role: 'user', content: `Produto pesquisado pelo usuário: "${textoBusca}"` }],
    esquema: ESQUEMA_INTERPRETAR,
    maxTokens: 700,
  });

  const dados = resultado.json ?? {};
  const termos = Array.isArray(dados.termos_tecnicos) ? dados.termos_tecnicos.filter(Boolean).slice(0, 6) : [];
  if (termos.length === 0) {
    throw new ErroIA('A IA não conseguiu gerar termos de busca para este produto.', {
      codigo: 'sem_termos',
      status: 422,
    });
  }

  return {
    produto_normalizado: dados.produto_normalizado ?? textoBusca,
    categoria: dados.categoria ?? '',
    termos_tecnicos: termos,
    observacao: dados.observacao ?? '',
    uso: resultado.uso,
  };
}

// ---------------------------------------------------------------------------
// 2. Escolha do NCM (e do CEST) dentro dos candidatos do banco
// ---------------------------------------------------------------------------

const SISTEMA_ESCOLHER = `Você classifica produtos escolhendo o NCM correto dentro de uma lista fechada.

Você recebe o produto pesquisado e uma lista numerada de candidatos que vieram do banco de dados oficial. Cada candidato traz o código NCM, a descrição do item e a hierarquia completa da nomenclatura.

Regras absolutas:
- Escolha SOMENTE um código que esteja na lista. Nunca escreva um código que não aparece ali.
- Se nenhum candidato servir, devolva ncm_escolhido igual a "" e explique em justificativa.
- Prefira o item mais específico que descreva o produto. Itens residuais ("Outros", "Outras") só quando nenhum item específico couber.
- Quando o candidato escolhido tiver CEST vinculados, escolha o CEST cuja descrição melhor corresponda ao produto (embalagem, apresentação, tipo). Se o produto não deixar claro qual, escolha o mais abrangente da lista. O CEST também precisa estar na lista do candidato.
- Se não houver CEST na lista do candidato, devolva cest_escolhido igual a "".
- confianca: "alta" quando a descrição do NCM cobre o produto sem ambiguidade; "media" quando é a melhor opção mas há alternativas plausíveis; "baixa" quando a escolha é um chute razoável.
- justificativa: uma ou duas frases, em português do Brasil, dizendo por que este item descreve o produto.
- Você não define tributação. Não mencione alíquota, CFOP, CST ou CSOSN.`;

const ESQUEMA_ESCOLHER = {
  type: 'object',
  properties: {
    ncm_escolhido: { type: 'string', description: 'Código NCM exatamente como aparece na lista, ou "" se nenhum servir.' },
    cest_escolhido: { type: 'string', description: 'Código CEST da lista do candidato escolhido, ou "".' },
    justificativa: { type: 'string' },
    confianca: { type: 'string', enum: ['alta', 'media', 'baixa'] },
  },
  required: ['ncm_escolhido', 'cest_escolhido', 'justificativa', 'confianca'],
  additionalProperties: false,
};

function formatarCandidatos(candidatos) {
  return candidatos
    .map((c, i) => {
      const cests = (c.cests ?? [])
        .map((ce) => `      - CEST ${ce.cest}: ${ce.descricao} [segmento: ${ce.segmento_nome}]`)
        .join('\n');
      return [
        `${i + 1}. NCM ${c.codigo}`,
        `   Descrição: ${c.descricao}`,
        `   Hierarquia: ${c.descricao_completa}`,
        cests ? `   CEST vinculados:\n${cests}` : '   CEST vinculados: nenhum',
      ].join('\n');
    })
    .join('\n\n');
}

export async function escolherNcm(chaveApi, { textoBusca, interpretacao, candidatos }) {
  const mensagem = [
    `Produto pesquisado: "${textoBusca}"`,
    interpretacao?.produto_normalizado ? `Leitura do produto: ${interpretacao.produto_normalizado}` : null,
    interpretacao?.categoria ? `Categoria: ${interpretacao.categoria}` : null,
    '',
    'Candidatos vindos do banco de dados:',
    '',
    formatarCandidatos(candidatos),
  ]
    .filter((l) => l !== null)
    .join('\n');

  const resultado = await chamarModelo(chaveApi, {
    system: SISTEMA_ESCOLHER,
    mensagens: [{ role: 'user', content: mensagem }],
    esquema: ESQUEMA_ESCOLHER,
    maxTokens: 900,
  });

  const dados = resultado.json ?? {};
  const escolhido = String(dados.ncm_escolhido ?? '').replace(/\D/g, '');

  // Conferencia: o codigo precisa existir entre os candidatos que o banco enviou.
  const candidato = candidatos.find((c) => c.codigo_numerico === escolhido);
  if (!candidato) {
    return {
      candidato: null,
      cest_escolhido: null,
      justificativa: dados.justificativa ?? '',
      confianca: 'baixa',
      fora_da_lista: escolhido.length > 0,
      uso: resultado.uso,
    };
  }

  // Mesma conferencia para o CEST.
  const cestBruto = String(dados.cest_escolhido ?? '').trim();
  const cestValido = (candidato.cests ?? []).some((c) => c.cest === cestBruto) ? cestBruto : null;

  return {
    candidato,
    cest_escolhido: cestValido,
    justificativa: dados.justificativa ?? '',
    confianca: dados.confianca ?? 'media',
    fora_da_lista: false,
    uso: resultado.uso,
  };
}

// ---------------------------------------------------------------------------
// 3. Explicar um NCM em linguagem comercial
// ---------------------------------------------------------------------------

const SISTEMA_EXPLICAR = `Você explica, em linguagem comercial simples, que tipo de produto se enquadra em um código NCM.

Você recebe o código, a descrição oficial e a hierarquia completa da nomenclatura, todos vindos do banco de dados.

Regras:
- Baseie-se apenas no que foi informado. Não acrescente códigos, alíquotas nem regras tributárias.
- "descricao_comercial": uma ou duas frases, como um vendedor explicaria a um cliente.
- "exemplos_de_produtos": de 2 a 5 produtos do dia a dia que caem nesse código. Pode citar nomes de categoria ("refrigerante de cola em lata") em vez de marcas.
- Se a descrição oficial for residual ("Outros"), explique que é a sobra da posição e cite o que a posição cobre.
- Português do Brasil.`;

const ESQUEMA_EXPLICAR = {
  type: 'object',
  properties: {
    descricao_comercial: { type: 'string' },
    exemplos_de_produtos: { type: 'array', items: { type: 'string' } },
    observacao: { type: 'string' },
  },
  required: ['descricao_comercial', 'exemplos_de_produtos', 'observacao'],
  additionalProperties: false,
};

export async function explicarNcm(chaveApi, { ncm, hierarquia, cests }) {
  const mensagem = [
    `NCM: ${ncm.codigo}`,
    `Descrição oficial: ${ncm.descricao}`,
    `Hierarquia: ${hierarquia.map((h) => h.descricao).join(' > ')}`,
    ncm.unidade ? `Unidade de medida estatística: ${ncm.unidade}` : null,
    cests.length
      ? `CEST vinculados: ${cests.map((c) => `${c.cest} (${c.descricao})`).join('; ')}`
      : 'CEST vinculados: nenhum',
  ]
    .filter(Boolean)
    .join('\n');

  const resultado = await chamarModelo(chaveApi, {
    system: SISTEMA_EXPLICAR,
    mensagens: [{ role: 'user', content: mensagem }],
    esquema: ESQUEMA_EXPLICAR,
    maxTokens: 700,
  });

  const dados = resultado.json ?? {};
  return {
    descricao_comercial: dados.descricao_comercial ?? '',
    exemplos_de_produtos: Array.isArray(dados.exemplos_de_produtos) ? dados.exemplos_de_produtos : [],
    observacao: dados.observacao ?? '',
    uso: resultado.uso,
  };
}
