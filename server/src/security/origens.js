/**
 * Politica de origens (CORS).
 *
 * O sistema roda dentro da rede da empresa: o servidor sobe numa maquina e a
 * equipe abre "http://192.168.0.50:3001" no navegador. Nesse cenario o
 * navegador manda o cabecalho Origin com o IP do servidor - e nao com
 * "localhost". Uma lista fixa de origens quebra exatamente esse uso: a pagina
 * carrega (navegacao nao manda Origin) mas toda chamada de /api e barrada, e o
 * sistema parece "so front-end".
 *
 * Por isso a decisao aqui e, nesta ordem:
 *   1. sem Origin           -> libera (navegacao, curl, app nativo)
 *   2. ORIGENS_PERMITIDAS   -> lista explicita do .env (ou "*")
 *   3. mesma origem         -> o Origin bate com o Host da requisicao
 *   4. rede local           -> localhost, 127.x, 10.x, 192.168.x, 172.16-31.x,
 *                             nomes .local/.lan e IPv6 local
 *
 * O item 4 pode ser desligado com PERMITIR_REDE_LOCAL=nao, para quem quiser a
 * lista estrita. Vale lembrar que CORS e uma protecao do navegador contra um
 * site externo chamar a API; ele nao impede um curl na propria rede. Quem
 * controla o acesso de verdade e a SENHA_ACESSO.
 */

const REDES_PRIVADAS = [
  /^10\./, // 10.0.0.0/8
  /^192\.168\./, // 192.168.0.0/16
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
  /^169\.254\./, // link-local (APIPA)
];

const SUFIXOS_LOCAIS = ['.local', '.lan', '.home', '.internal'];

/** Diz se um hostname pertence a maquina local ou a uma rede privada. */
export function ehEnderecoLocal(hostname) {
  const host = String(hostname ?? '')
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '');
  if (!host) return false;
  if (host === 'localhost' || host === '::1') return true;
  if (host.startsWith('127.')) return true;
  if (SUFIXOS_LOCAIS.some((sufixo) => host.endsWith(sufixo))) return true;
  if (REDES_PRIVADAS.some((rede) => rede.test(host))) return true;
  // IPv6: fe80::/10 (link-local) e fc00::/7 (unique local).
  if (/^fe80:/.test(host) || /^f[cd][0-9a-f]{2}:/.test(host)) return true;
  return false;
}

/**
 * Avalia uma origem. Devolve { permitida, motivo } - o motivo entra no log e
 * na mensagem de erro, para o suporte saber o que ajustar.
 *
 * @param {string|undefined} origem   cabecalho Origin da requisicao
 * @param {string|undefined} hostAlvo cabecalho Host da requisicao
 * @param {{ origensPermitidas: string[], permitirRedeLocal: boolean }} politica
 */
export function avaliarOrigem(origem, hostAlvo, politica) {
  if (!origem) return { permitida: true, motivo: 'requisicao sem Origin (mesma origem, curl ou app nativo)' };

  const lista = politica.origensPermitidas ?? [];
  if (lista.includes('*')) return { permitida: true, motivo: 'ORIGENS_PERMITIDAS aceita qualquer origem (*)' };
  if (lista.includes(origem)) return { permitida: true, motivo: 'origem listada em ORIGENS_PERMITIDAS' };

  let url;
  try {
    url = new URL(origem);
  } catch {
    return { permitida: false, motivo: 'cabecalho Origin malformado' };
  }

  // O caso mais comum em producao: o proprio servidor entrega a interface,
  // entao Origin e Host sao o mesmo endereco.
  if (hostAlvo && url.host.toLowerCase() === String(hostAlvo).toLowerCase()) {
    return { permitida: true, motivo: 'mesma origem do servidor' };
  }

  if (politica.permitirRedeLocal && ehEnderecoLocal(url.hostname)) {
    return { permitida: true, motivo: 'endereco de rede local' };
  }

  return {
    permitida: false,
    motivo: politica.permitirRedeLocal
      ? 'origem fora da rede local e ausente de ORIGENS_PERMITIDAS'
      : 'origem ausente de ORIGENS_PERMITIDAS (PERMITIR_REDE_LOCAL=nao)',
  };
}
