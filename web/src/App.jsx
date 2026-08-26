import { useEffect, useState } from 'react';
import { api } from './lib/api.js';
import FichaFiscal from './components/FichaFiscal.jsx';

const CHAVE_PREFERENCIAS = 'consulta-fiscal:preferencias';

function lerPreferencias() {
  try {
    return JSON.parse(localStorage.getItem(CHAVE_PREFERENCIAS) ?? '{}');
  } catch {
    return {};
  }
}

/** Detecta se o texto digitado parece um código NCM, para alternar o modo sozinho. */
function pareceCodigo(texto) {
  const limpo = texto.trim();
  if (!limpo || !/^[\d.\s-]+$/.test(limpo)) return false;
  const digitos = limpo.replace(/\D/g, '');
  return digitos.length >= 4 && digitos.length <= 8;
}

export default function App() {
  const preferencias = lerPreferencias();

  const [modo, setModo] = useState('produto');
  // Enquanto o usuário não escolher a aba na mão, o modo se ajusta ao que ele digita.
  const [modoManual, setModoManual] = useState(false);
  const [texto, setTexto] = useState('');
  const [uf, setUf] = useState(preferencias.uf ?? 'PE');
  const [regime, setRegime] = useState(preferencias.regime ?? 'regime_normal');

  const [referencias, setReferencias] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState(null);
  const [resultado, setResultado] = useState(null);

  useEffect(() => {
    api.referencias().then(setReferencias).catch((e) => setErro({ mensagem: e.message, codigo: e.codigo }));
  }, []);

  useEffect(() => {
    localStorage.setItem(CHAVE_PREFERENCIAS, JSON.stringify({ uf, regime }));
  }, [uf, regime]);

  // Quem digita "2202.10.00" quer buscar por código, mesmo sem trocar a aba.
  useEffect(() => {
    if (modoManual) return;
    setModo(pareceCodigo(texto) ? 'ncm' : 'produto');
  }, [texto, modoManual]);

  function escolherModo(novoModo) {
    setModoManual(true);
    setModo(novoModo);
  }

  async function consultar(evento, textoForcado = null) {
    evento?.preventDefault();
    const entrada = (textoForcado ?? texto).trim();
    if (!entrada || carregando) return;

    setCarregando(true);
    setErro(null);
    setResultado(null);
    try {
      const resposta = await api.consultar({
        texto: entrada,
        uf,
        // No modo NCM o regime é opcional: o usuário pode querer só saber se tem ST.
        regime,
        tipo: modo,
      });
      setResultado(resposta);
    } catch (e) {
      setErro({ mensagem: e.message, codigo: e.codigo, sugestoes: e.sugestoes, termos: e.termos_pesquisados });
    } finally {
      setCarregando(false);
    }
  }

  function usarSugestao(codigo) {
    setModoManual(true);
    setModo('ncm');
    setTexto(codigo);
    consultar(null, codigo);
  }

  const ficha = resultado?.ficha ?? null;
  const buscaPorNcm = resultado?.tipo_busca === 'ncm';

  return (
    <div className="aplicacao">
      <header className="cabecalho">
        <div>
          <h1>Consulta Fiscal</h1>
          <p>NCM, CEST e tributação de saída para os estados do Nordeste.</p>
        </div>
        {referencias?.fonte_dados && (
          <div className="selo-fonte">
            NCM <strong>{referencias.fonte_dados.ncm_vigencia}</strong>
            <br />
            CEST <strong>{referencias.base_legal}</strong>
          </div>
        )}
      </header>

      <form className="busca" onSubmit={consultar}>
        <div className="modos" role="group" aria-label="Tipo de busca">
          <button type="button" aria-pressed={modo === 'produto'} onClick={() => escolherModo('produto')}>
            Nome ou descrição
          </button>
          <button type="button" aria-pressed={modo === 'ncm'} onClick={() => escolherModo('ncm')}>
            Código NCM
          </button>
        </div>

        <div className="linha-busca">
          <input
            className={`campo-texto${modo === 'ncm' ? ' mono' : ''}`}
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            placeholder={modo === 'ncm' ? '2202.10.00' : 'Coca-Cola lata, picolé, cerveja Budweiser…'}
            aria-label={modo === 'ncm' ? 'Código NCM' : 'Nome ou descrição do produto'}
            autoFocus
          />
          <button className="botao-principal" type="submit" disabled={carregando || !texto.trim()}>
            {carregando ? 'Consultando…' : 'Consultar'}
          </button>
        </div>

        <div className="filtros">
          <div className="filtro">
            <label htmlFor="uf">Estado</label>
            <select id="uf" value={uf} onChange={(e) => setUf(e.target.value)}>
              {(referencias?.estados ?? []).map((e) => (
                <option key={e.uf} value={e.uf}>
                  {e.nome} ({e.uf}) — ICMS {String(e.aliquota_icms).replace('.', ',')}%
                </option>
              ))}
            </select>
          </div>
          <div className="filtro">
            <label htmlFor="regime">Regime tributário</label>
            <select id="regime" value={regime} onChange={(e) => setRegime(e.target.value)}>
              {(referencias?.regimes ?? []).map((r) => (
                <option key={r.valor} value={r.valor}>
                  {r.rotulo}
                </option>
              ))}
            </select>
          </div>
        </div>

        <p className="dica">
          {modo === 'ncm'
            ? 'Digite o código com ou sem pontos. Códigos parciais mostram os itens da posição.'
            : 'Pode usar o nome comercial ou a marca — a IA traduz para o termo técnico da NCM antes de buscar no banco.'}
        </p>
      </form>

      {erro && (
        <div className="mensagem erro">
          <h3>Não foi possível concluir a consulta</h3>
          <p style={{ margin: 0 }}>{erro.mensagem}</p>
          {erro.termos?.length > 0 && (
            <p style={{ margin: '8px 0 0', fontSize: 13 }}>Termos pesquisados: {erro.termos.join(' · ')}</p>
          )}
          {erro.sugestoes?.length > 0 && (
            <>
              <p style={{ margin: '10px 0 4px', fontSize: 13, fontWeight: 600 }}>Itens desta posição:</p>
              <table className="tabela-alternativas">
                <tbody>
                  {erro.sugestoes.map((s) => (
                    <tr key={s.codigo}>
                      <td>
                        <button type="button" onClick={() => usarSugestao(s.codigo)}>
                          {s.codigo}
                        </button>
                      </td>
                      <td>{s.descricao}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}

      {carregando && (
        <div className="carregando">
          <span className="pulso" />
          Traduzindo o produto, consultando o banco e montando a ficha…
        </div>
      )}

      {resultado?.avisos?.length > 0 && (
        <div className="mensagem aviso">
          <h3>Confira antes de usar</h3>
          <ul>
            {resultado.avisos.map((aviso, i) => (
              <li key={i}>{aviso}</li>
            ))}
          </ul>
        </div>
      )}

      {resultado && buscaPorNcm && (
        <div className="mensagem">
          <h3>
            {resultado.ncm.codigo} — {resultado.ncm.descricao}
          </h3>
          {resultado.explicacao ? (
            <>
              <p style={{ margin: '4px 0 0' }}>{resultado.explicacao.descricao_comercial}</p>
              {resultado.explicacao.exemplos_de_produtos.length > 0 && (
                <div className="etiquetas" style={{ marginTop: 10 }}>
                  {resultado.explicacao.exemplos_de_produtos.map((exemplo) => (
                    <span key={exemplo} className="etiqueta">
                      {exemplo}
                    </span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p style={{ margin: '4px 0 0' }}>{resultado.ncm.descricao_completa}</p>
          )}
        </div>
      )}

      {ficha && <FichaFiscal ficha={ficha} hierarquia={resultado.hierarquia ?? []} escolha={resultado.escolha ?? null} />}

      {resultado?.alternativas?.length > 0 && (
        <details className="alternativas">
          <summary>Ver {resultado.alternativas.length} outros NCM que a busca encontrou</summary>
          <table className="tabela-alternativas">
            <thead>
              <tr>
                <th>NCM</th>
                <th>Descrição</th>
              </tr>
            </thead>
            <tbody>
              {resultado.alternativas.map((alternativa) => (
                <tr key={alternativa.codigo}>
                  <td>
                    <button type="button" onClick={() => usarSugestao(alternativa.codigo)}>
                      {alternativa.codigo}
                    </button>
                  </td>
                  <td>
                    {alternativa.descricao}
                    <span className="campo-nota">{alternativa.hierarquia}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {!resultado && !carregando && !erro && (
        <div className="vazio">
          <strong>Comece pela busca acima</strong>
          Digite o nome comercial de um produto ou um código NCM.
        </div>
      )}

      {/* Espaço reservado — entrega automática por planilha Excel. */}
      <section className="reservado">
        <h3>Em preparação</h3>
        Entrega automática de dados fiscais em lote por planilha Excel. A estrutura já está no código
        (<code>server/src/services/exportacao-excel.js</code>); falta apenas o modelo da planilha.
      </section>

      <footer className="rodape">
        Base: tabela NCM vigente da Receita Federal e CEST do Convênio ICMS 142/2018. As alíquotas e as
        regras de substituição tributária ficam em <code>server/config/</code> e devem ser conferidas com a
        contabilidade antes do uso em documentos fiscais.
      </footer>
    </div>
  );
}
