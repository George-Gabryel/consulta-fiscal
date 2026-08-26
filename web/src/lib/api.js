/**
 * Cliente da API.
 *
 * O front-end nunca vê a chave da Anthropic: ele conversa apenas com o
 * back-end, que guarda a chave cifrada e faz as chamadas à IA.
 *
 * VITE_API_BASE existe para o caso de o front ser servido de um endereço
 * diferente do back. Em desenvolvimento, o proxy do Vite resolve e o valor
 * padrão (caminho relativo) é o suficiente.
 */

const BASE = import.meta.env.VITE_API_BASE ?? '';
const SENHA = import.meta.env.VITE_SENHA_ACESSO ?? '';

async function pedir(caminho, opcoes = {}) {
  let resposta;
  try {
    resposta = await fetch(`${BASE}/api${caminho}`, {
      ...opcoes,
      headers: {
        'content-type': 'application/json',
        ...(SENHA ? { 'x-acesso': SENHA } : {}),
        ...(opcoes.headers ?? {}),
      },
    });
  } catch {
    throw Object.assign(new Error('Não foi possível falar com o servidor. Verifique se ele está rodando e se o endereço está certo.'), {
      codigo: 'sem_conexao',
    });
  }

  const dados = await resposta.json().catch(() => null);

  if (!resposta.ok) {
    const erro = new Error(dados?.mensagem ?? `Erro ${resposta.status}.`);
    erro.codigo = dados?.codigo ?? 'erro';
    erro.sugestoes = dados?.sugestoes ?? null;
    erro.termos_pesquisados = dados?.termos_pesquisados ?? null;
    throw erro;
  }

  return dados;
}

export const api = {
  referencias: () => pedir('/referencias'),
  saude: () => pedir('/saude'),
  consultar: (corpo) => pedir('/consulta', { method: 'POST', body: JSON.stringify(corpo) }),
};
