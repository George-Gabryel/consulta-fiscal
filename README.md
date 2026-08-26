# Consulta Fiscal — NCM, CEST e tributação no Nordeste

Sistema de consulta que responde, a partir do **nome comercial de um produto** ou de um **código NCM**, quais dados fiscais usar na saída: NCM, CEST, CFOP, alíquota de ICMS, CST/CSOSN e PIS/COFINS — para os nove estados do Nordeste, em Simples Nacional ou Regime Normal.

- **Back-end:** Node.js 22 + Express
- **Front-end:** React + Vite
- **Banco:** SQLite (`better-sqlite3` 13.0.3), carregado das tabelas oficiais
- **IA:** Claude Sonnet 5, com papel restrito a tradução e leitura

---

## Índice

1. [Instalação](#1-instalação)
2. [A chave da API Anthropic](#2-a-chave-da-api-anthropic)
3. [Diagnóstico](#3-diagnóstico)
4. [Rodando o sistema](#4-rodando-o-sistema)
5. [Publicando na rede local](#5-publicando-na-rede-local)
6. [Como o sistema funciona](#6-como-o-sistema-funciona)
7. [O papel da IA](#7-o-papel-da-ia)
8. [Regras fiscais e o que você precisa conferir](#8-regras-fiscais-e-o-que-você-precisa-conferir)
9. [Segurança do token](#9-segurança-do-token)
10. [Espaço reservado: planilhas Excel](#10-espaço-reservado-planilhas-excel)
11. [Mapa dos arquivos](#11-mapa-dos-arquivos)
12. [API](#12-api)
13. [Problemas comuns](#13-problemas-comuns)

---

## 1. Instalação

Requisito: **Node.js 22 ou superior** (o `better-sqlite3` 13.0.3 exige isso).

```bash
node -v            # precisa mostrar v22 ou maior

# Back-end
cd server
npm install
npm run db:build   # gera data/fiscal.db a partir dos JSONs em fontes/

# Front-end
cd ../web
npm install
```

A carga do banco leva alguns segundos e mostra um resumo:

```
NCM                   15156
NCM itens 8 dígitos   10515
CEST                   1010
CEST × NCM             1223
```

Rode `npm run db:build` de novo sempre que trocar os arquivos em `server/fontes/` por versões mais novas da tabela NCM ou do CEST.

---

## 2. A chave da API Anthropic

Existem quatro formas de fornecer a chave. O sistema procura nesta ordem:

### a) Cofre cifrado — recomendado

```bash
cd server
npm run chave:definir
```

Pede a chave no console (a digitação fica oculta), grava cifrada em `secrets/anthropic.key.enc` e testa a chave na API antes de terminar.

### b) Arquivo de texto

Crie `server/secrets/anthropic.key.txt` com a chave em uma linha:

```
sk-ant-api03-...
```

Funciona direto. Para migrar depois para o cofre:

```bash
npm run chave:definir -- --do-arquivo
rm secrets/anthropic.key.txt
```

### c) Direto no console

```bash
npm start -- --chave sk-ant-api03-...
npm run diagnostico -- --chave sk-ant-api03-...
```

### d) Variável de ambiente

```bash
export ANTHROPIC_API_KEY=sk-ant-api03-...
```

Ou no arquivo `.env` (copie de `.env.example`).

---

## 3. Diagnóstico

Testa a comunicação com a IA **sem subir o servidor nem o front-end**:

```bash
cd server
npm run diagnostico
```

Ele roda cinco blocos independentes — se a IA estiver fora do ar, os testes de banco e de regras continuam e mostram o que está saudável:

| Bloco | O que verifica |
|---|---|
| 1. Ambiente | versão do Node, origem da chave |
| 2. Banco | abertura em somente leitura, bloqueio de escrita, busca textual, vínculo NCM→CEST |
| 3. Regras fiscais | alíquotas dos 9 estados, caso com ST, caso sem ST, regra do NCM residual |
| 4. IA | conexão com o modelo, tokens gastos, tradução comercial → técnica |
| 5. Ponta a ponta | uma busca por produto e uma por NCM, completas |

Opções:

```bash
npm run diagnostico -- --sem-ia                 # só banco e regras, não gasta cota
npm run diagnostico -- --produto "Budweiser"    # testa outro produto
npm run diagnostico -- --ncm 2203.00.00         # testa outro código
npm run diagnostico -- --uf BA --regime simples_nacional
```

Sai com código `1` se algo falhar, então serve em script de verificação automática.

---

## 4. Rodando o sistema

**Desenvolvimento** (dois terminais):

```bash
cd server && npm run dev     # API em http://localhost:3001
cd web    && npm run dev     # interface em http://localhost:5173
```

O Vite repassa `/api` para o back-end, então o navegador nunca precisa saber o endereço da API.

**Produção** (um processo só):

```bash
cd web && npm run build      # gera web/dist
cd ../server && npm start    # serve API + interface em http://localhost:3001
```

Quando `web/dist` existe, o Express entrega a interface junto com a API na mesma porta. É o modo recomendado para o servidor da rede.

---

## 5. Publicando na rede local

1. Descubra o IP do servidor (`ip addr` no Linux, `ipconfig` no Windows). O próprio servidor imprime os endereços ao subir.
2. Em `server/.env`:

```ini
HOST=0.0.0.0
PORTA=3001
ORIGENS_PERMITIDAS=http://192.168.0.50:3001
SENHA_ACESSO=uma-senha-que-so-a-equipe-conhece
```

3. Gere o build do front (`cd web && npm run build`) e inicie `npm start` no `server/`.
4. A equipe acessa `http://192.168.0.50:3001`.
5. Libere a porta no firewall do servidor.

Se você definir `SENHA_ACESSO`, o front precisa mandá-la. Crie `web/.env` com:

```ini
VITE_SENHA_ACESSO=uma-senha-que-so-a-equipe-conhece
```

e gere o build de novo. Isso é uma tranca de porta contra acesso casual dentro da rede — **não** é a proteção do token da Anthropic, que é outra coisa (seção 9).

Para o serviço subir sozinho, use `systemd` no Linux ou `pm2` em qualquer sistema:

```bash
npm install -g pm2
cd server && pm2 start src/server.js --name consulta-fiscal && pm2 save && pm2 startup
```

---

## 6. Como o sistema funciona

### Busca por nome de produto

O usuário digita `Coca-Cola lata`, escolhe o estado e o regime.

```
"Coca-Cola lata"
      │
      ├─ IA traduz → "águas gaseificadas adicionadas de açúcar", "refrigerante"
      │
      ├─ BANCO busca esses termos → 12 candidatos de NCM, cada um com seus CEST
      │
      ├─ IA escolhe UM candidato da lista → 2202.10.00, CEST 03.010.02
      │       (a escolha é conferida: código fora da lista é descartado)
      │
      └─ REGRAS montam a ficha → CFOP 5405 · CST 060 · ICMS 20,5% · PIS/COFINS
```

### Busca por código NCM

O usuário digita `2202.10.00` e escolhe o estado. O sistema mostra o item, a hierarquia da nomenclatura, uma explicação em linguagem comercial (essa parte vem da IA) e se há substituição tributária naquele estado — com o CEST, quando houver.

Código parcial funciona: digitar `2202` lista os itens de 8 dígitos daquela posição para escolher.

---

## 7. O papel da IA

A IA faz **três coisas, todas de leitura ou tradução**:

1. traduzir o nome comercial para os termos técnicos da nomenclatura NCM;
2. escolher **um item de uma lista fechada** que o banco devolveu;
3. explicar, em linguagem comercial, o que se enquadra em um NCM já encontrado.

Ela **não** cria dado fiscal. CFOP, CST, CSOSN, alíquota e a decisão de ST saem de `server/src/domain/regras-fiscais.js` e dos arquivos em `server/config/` — código determinístico, sem IA no caminho.

Três travas garantem isso:

- O banco é aberto com `readonly: true` e `PRAGMA query_only = ON`. Nenhum caminho de execução do servidor consegue escrever nele; a única escrita é o `npm run db:build`.
- Todo código que a IA devolve é conferido contra a lista de candidatos. Se ela responder um NCM ou CEST que não estava na lista, a resposta é descartada, o sistema usa o candidato mais relevante da busca e mostra um aviso na tela.
- A IA nunca recebe as regras tributárias no prompt, então não tem como opinar sobre elas.

### Restrições do Claude Sonnet 5 tratadas no código

Conferido na [documentação oficial](https://platform.claude.com/docs/en/models/sonnet-5/whats-new-sonnet-5):

| Item | Situação | O que o projeto faz |
|---|---|---|
| `temperature`, `top_p`, `top_k` | **erro 400** se enviados com valor diferente do padrão | não são enviados; há uma guarda em `cliente-anthropic.js` que quebra com mensagem clara se alguém reintroduzir |
| `thinking: {type:"enabled", budget_tokens}` | **removido**, erro 400 | usamos `thinking: {type:"disabled"}` — as tarefas são curtas; dá para ligar o raciocínio adaptativo com `IA_PENSAMENTO=ligado` |
| Prefill da mensagem do assistente | não suportado | JSON garantido por `output_config.format` (structured outputs) |
| Recusa por política de uso | volta com HTTP **200** e `stop_reason: "refusal"` | tratada como erro de negócio, não como sucesso |

Para orientar o comportamento do modelo, use o **system prompt** — é o caminho que substitui o `temperature`. Os prompts ficam em `server/src/services/ia-fiscal.js`.

Modelo usado: `claude-sonnet-5`, declarado uma única vez em `server/src/config.js`.

---

## 8. Regras fiscais e o que você precisa conferir

As regras implementadas:

| Situação | CFOP | CST ICMS (Regime Normal) | CSOSN (Simples) |
|---|---|---|---|
| Tributado normal | 5102 | 000 | 102 |
| Substituição tributária | 5405 | 060 | 500 |

**ICMS por estado** (`server/config/estados.json`):

| MA | PI | BA | PE | CE | PB | RN | AL | SE |
|---|---|---|---|---|---|---|---|---|
| 23% | 22,5% | 20,5% | 20,5% | 20% | 20% | 20% | 19% | 19% |

**Regra do NCM residual:** itens cuja descrição é "Outros"/"Outras" são tratados como **sem** substituição tributária, exceto bebidas (capítulo 22 da NCM e segmentos CEST 02 e 03). Configurável em `substituicao-tributaria.json`.

### Dois pontos que precisam da sua contabilidade

**1. Quais segmentos CEST cada estado adota.**
Os arquivos de origem trazem a lista nacional do Convênio ICMS 142/2018, mas não dizem o que cada UF adotou por protocolo ou decreto. O padrão do sistema é "tudo que está no Convênio tem ST", com listas de exceção por estado — hoje vazias — em `server/config/substituicao-tributaria.json`:

```json
"PE": { "segmentos_excluidos": ["19"], "cest_excluidos": ["17.111.00"] }
```

Confira com o RICMS de cada estado e preencha. Editar o arquivo e reiniciar o servidor basta; não precisa mexer em código.

**2. PIS/COFINS.**
"Regime Normal" abrange Lucro Real e Lucro Presumido, que têm alíquotas diferentes. O padrão está em não cumulativo (1,65% / 7,6%); troque em `server/config/tributos.json`:

```json
"perfil_pis_cofins_padrao": "cumulativo"
```

O sistema também detecta **produtos monofásicos** por segmento CEST (bebidas, combustíveis, farmacêuticos, autopeças, pneus) e devolve CST 04 com alíquota zero, que é o correto na revenda. É por isso que um refrigerante aparece com PIS/COFINS zerados. Se o enquadramento da empresa for outro, esvazie `segmentos_cest_monofasicos.codigos`.

> O sistema é uma ferramenta de consulta e apoio. Antes de usar os códigos em documentos fiscais, valide as configurações com a contabilidade — a responsabilidade pelo enquadramento é do contribuinte.

---

## 9. Segurança do token

O que está implementado:

- **A chave nunca sai do servidor.** Não existe rota da API que devolva a chave, e ela não entra em nenhum bundle do front-end. Quem fala com a Anthropic é sempre o back-end. O navegador do usuário só conhece o endereço do seu servidor.
- **Cifrada em disco.** AES-256-GCM com chave derivada por `scrypt`. O arquivo `secrets/anthropic.key.enc` não contém a chave em texto — se ele vazar num backup ou num commit, o token não vaza junto.
- **Mascarada em toda saída.** Logs, diagnóstico e a rota `/api/saude` mostram `sk-ant-api…7890`, nunca o valor.
- **CORS fechado.** Só as origens listadas em `ORIGENS_PERMITIDAS` conseguem chamar a API pelo navegador.
- **Senha de acesso opcional** (`SENHA_ACESSO`) para o sistema inteiro.
- **Limite de requisições** por IP (`LIMITE_REQ_MINUTO`, padrão 30), para um laço acidental no cliente não queimar a cota.
- **`secrets/` fora do git.**

O que isso **não** cobre, para ficar claro: quem tiver acesso de administrador ao sistema de arquivos do servidor consegue ler tanto o cofre quanto a chave mestra. A cifragem protege contra o cenário realista — arquivo copiado, backup vazado, commit por engano — não contra alguém que já é dono da máquina. Por isso valem também: manter o servidor só na rede interna, não expor a porta na internet, e usar `CHAVE_MESTRA` como variável de ambiente (fora do disco) se o ambiente permitir.

---

## 10. Espaço reservado: planilhas Excel

O lugar está preparado em `server/src/services/exportacao-excel.js`.

**Já funciona:** `processarLote()` recebe uma lista de produtos, processa em paralelo (3 por vez), reaproveita exatamente o mesmo caminho da consulta individual e isola os erros por linha — uma linha problemática não derruba o lote.

**Falta:** ler o `.xlsx` de entrada e escrever o de saída, que dependem do modelo da planilha.

Quando o modelo chegar:

1. `cd server && npm install exceljs`
2. preencher `MAPA_COLUNAS` com os cabeçalhos reais
3. implementar `lerPlanilha()` e `gerarPlanilha()`
4. liberar a rota `POST /api/planilha` em `src/routes/index.js` (hoje responde 501 com esta explicação)
5. ativar o cartão de upload no front

As regras fiscais e a integração com a IA são reaproveitadas sem alteração. `GET /api/planilha/status` já informa o que está pronto e o que falta.

---

## 11. Mapa dos arquivos

```
consulta-fiscal/
├── server/
│   ├── fontes/                     tabelas oficiais (.json) — origem do banco
│   ├── config/
│   │   ├── estados.json                alíquotas de ICMS por UF
│   │   ├── substituicao-tributaria.json segmentos com ST por UF, regra do "Outros"
│   │   └── tributos.json               CFOP, CST, CSOSN, PIS/COFINS
│   ├── data/fiscal.db              banco gerado (não vai para o git)
│   ├── secrets/                    cofre da chave (não vai para o git)
│   ├── scripts/
│   │   ├── diagnostico.js          teste completo sem subir o sistema
│   │   └── definir-chave.js        grava a chave no cofre
│   └── src/
│       ├── server.js               Express, CORS, senha, limite de requisições
│       ├── config.js               configuração e resolução da chave
│       ├── db/
│       │   ├── schema.sql          estrutura do banco
│       │   ├── build-database.js   carga dos JSONs (única escrita do sistema)
│       │   └── index.js            consultas, somente leitura
│       ├── domain/regras-fiscais.js   ST, CFOP, CST, CSOSN, PIS/COFINS
│       ├── services/
│       │   ├── cliente-anthropic.js   chamadas à API, restrições do Sonnet 5
│       │   ├── ia-fiscal.js           prompts e validação das respostas
│       │   ├── consulta.js            orquestração das duas buscas
│       │   └── exportacao-excel.js    espaço reservado + lote pronto
│       └── routes/index.js         rotas da API
└── web/
    └── src/
        ├── App.jsx                     tela e formulário de busca
        ├── components/FichaFiscal.jsx  ficha de resultado
        ├── lib/api.js                  cliente da API
        └── estilos.css                 estilo
```

O visual da ficha segue as caixas de campo do DANFE — rótulo miúdo em maiúsculas, valor em fonte monoespaçada — porque é o formato que quem trabalha com nota fiscal já lê, e os códigos ficam alinhados dígito a dígito para conferência. Todas as fontes são de sistema, de propósito: o servidor pode rodar numa rede sem internet, e fonte que não carrega vira layout quebrado.

---

## 12. API

| Método | Rota | O que faz |
|---|---|---|
| `GET` | `/api/saude` | estado do banco e da chave (mascarada) |
| `GET` | `/api/referencias` | estados, regimes e versão das tabelas |
| `POST` | `/api/consulta` | consulta principal |
| `GET` | `/api/ncm/:codigo` | consulta direta ao banco, **sem IA** — útil para conferência |
| `POST` | `/api/planilha` | reservado (responde 501) |
| `GET` | `/api/planilha/status` | o que falta para a planilha |

```bash
curl -X POST http://localhost:3001/api/consulta \
  -H 'content-type: application/json' \
  -d '{"texto":"Coca-Cola lata","uf":"PE","regime":"regime_normal"}'
```

Campos: `texto` (produto ou NCM), `uf` (uma das nove do Nordeste), `regime` (`simples_nacional` ou `regime_normal`), `tipo` (opcional: `produto` ou `ncm`; sem ele o sistema deduz pelo formato).

---

## 13. Problemas comuns

**`Banco não encontrado`** — rode `npm run db:build` dentro de `server/`.

**`Chave da API recusada (401)`** — a chave está errada ou foi revogada. Rode `npm run chave:definir` de novo.

**`Não foi possível abrir o cofre`** — a `CHAVE_MESTRA` mudou ou `secrets/.chave-mestra` foi perdido. Rode `npm run chave:definir` para regravar; nenhum dado se perde.

**`Modelo não encontrado (404)`** — a chave não tem acesso ao `claude-sonnet-5`. Confira no console da Anthropic.

**Erro 400 falando em `temperature`** — algum trecho novo está enviando parâmetro de amostragem. O Sonnet 5 recusa; use o system prompt. A guarda em `cliente-anthropic.js` aponta onde.

**A busca não acha o produto** — descreva pelo tipo em vez da marca ("refrigerante de cola" no lugar de "Coca-Cola Zero 350ml"). O painel "outros NCM que a busca encontrou" mostra as alternativas ranqueadas.

**A rede não enxerga o servidor** — confira `HOST=0.0.0.0`, o firewall e se o IP em `ORIGENS_PERMITIDAS` é o mesmo que a equipe digita no navegador.

**`npm install` falha no better-sqlite3** — quase sempre é Node abaixo de 22. Confira com `node -v`.
