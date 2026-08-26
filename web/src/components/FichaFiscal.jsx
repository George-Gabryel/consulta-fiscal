/**
 * Ficha fiscal — o resultado da consulta.
 *
 * O desenho segue as caixas de campo do DANFE: rótulo miúdo em maiúsculas,
 * valor grande em monoespaçada. Quem trabalha com nota fiscal já lê nesse
 * formato, e os códigos ficam alinhados dígito a dígito para conferência.
 */

function Campo({ rotulo, valor, nota, destaque = false, mono = true }) {
  return (
    <div className={`campo${destaque ? ' destaque' : ''}`}>
      <dt>{rotulo}</dt>
      <dd>
        {valor === null || valor === undefined || valor === '' ? (
          <span className="valor-nulo" title="Não se aplica a esta operação">
            —
          </span>
        ) : (
          <span className={mono ? 'valor-codigo' : 'valor-texto'}>{valor}</span>
        )}
        {nota ? <span className="campo-nota">{nota}</span> : null}
      </dd>
    </div>
  );
}

export default function FichaFiscal({ ficha, hierarquia = [], escolha = null }) {
  if (!ficha) return null;

  const { ncm, estado, regime, substituicao_tributaria: st, cfop, icms, pis_cofins, alertas } = ficha;
  const simples = regime.valor === 'simples_nacional';

  return (
    <article className="ficha">
      <header className="ficha-topo">
        <div>
          <div className="ficha-titulo">Ficha fiscal do produto</div>
          <h2 className="ficha-produto">{ncm.descricao}</h2>
          <div className={`carimbo ${st.possui ? 'com-st' : 'sem-st'}`} style={{ marginTop: 10 }}>
            {st.possui ? 'Com substituição tributária' : 'Tributação normal'}
          </div>
        </div>
        <div className="ficha-contexto">
          {estado.nome} ({estado.uf})
          <br />
          {regime.rotulo}
        </div>
      </header>

      <dl className="grade">
        <Campo rotulo="NCM" valor={ncm.codigo} nota={ncm.unidade ? `Unidade: ${ncm.unidade}` : null} destaque />
        <Campo
          rotulo="CEST"
          valor={st.cest?.codigo ?? null}
          nota={st.cest ? st.cest.descricao : 'Sem substituição tributária nesta UF'}
          destaque={Boolean(st.cest)}
        />
        <Campo rotulo="CFOP" valor={cfop.codigo} nota={cfop.descricao} />
        <Campo
          rotulo="Alíquota ICMS"
          valor={`${String(icms.aliquota_interna).replace('.', ',')}%`}
          nota={
            simples
              ? 'Referência da UF — no Simples o ICMS sai no DAS'
              : st.possui
                ? 'Já retido pelo substituto — sem destaque na saída'
                : 'Alíquota interna do estado'
          }
        />
        {simples ? (
          <Campo rotulo="CSOSN" valor={icms.csosn} nota={icms.csosn_descricao} destaque />
        ) : (
          <Campo rotulo="CST ICMS" valor={icms.cst} nota={icms.cst_descricao} destaque />
        )}
        {pis_cofins ? (
          <>
            <Campo
              rotulo="PIS"
              valor={`${String(pis_cofins.pis.aliquota).replace('.', ',')}%`}
              nota={`CST ${pis_cofins.pis.cst} — ${pis_cofins.pis.descricao}`}
            />
            <Campo
              rotulo="COFINS"
              valor={`${String(pis_cofins.cofins.aliquota).replace('.', ',')}%`}
              nota={`CST ${pis_cofins.cofins.cst} — ${pis_cofins.cofins.descricao}`}
            />
          </>
        ) : (
          <Campo rotulo="PIS / COFINS" valor={null} nota="Recolhidos no DAS do Simples Nacional" />
        )}
      </dl>

      {hierarquia.length > 0 && (
        <section className="secao">
          <h3>Classificação na nomenclatura</h3>
          <p className="trilha">
            {hierarquia.map((nivel) => (
              <span key={nivel.codigo}>{nivel.descricao}</span>
            ))}
          </p>
        </section>
      )}

      {escolha?.justificativa && (
        <section className="secao">
          <h3>Por que este NCM · confiança {escolha.confianca}</h3>
          <p>{escolha.justificativa}</p>
        </section>
      )}

      <section className="secao">
        <h3>Como a substituição tributária foi definida</h3>
        <ul className="lista-motivos">
          {st.motivos.map((motivo, i) => (
            <li key={i}>{motivo}</li>
          ))}
        </ul>
        {st.cest_candidatos.length > 1 && (
          <>
            <h3 style={{ marginTop: 14 }}>Outros CEST ligados a este NCM</h3>
            <div className="etiquetas">
              {st.cest_candidatos
                .filter((c) => c.codigo !== st.cest?.codigo)
                .map((c) => (
                  <span key={c.codigo} className="etiqueta" title={c.descricao}>
                    {c.codigo} · {c.descricao.length > 52 ? `${c.descricao.slice(0, 52)}…` : c.descricao}
                  </span>
                ))}
            </div>
          </>
        )}
      </section>

      {alertas.length > 0 && (
        <section className="secao">
          <h3>Observações</h3>
          <ul className="lista-motivos">
            {alertas.map((alerta, i) => (
              <li key={i}>{alerta}</li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
