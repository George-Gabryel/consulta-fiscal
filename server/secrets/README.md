# Pasta de segredos

Nada aqui vai para o git (veja o `.gitignore` da raiz).

| Arquivo | O que é |
|---|---|
| `anthropic.key.enc` | Cofre cifrado com a chave da API (AES-256-GCM). Gerado por `npm run chave:definir`. |
| `.chave-mestra` | Chave que abre o cofre, gerada automaticamente. Se você perder, é só regravar a chave da API. |
| `anthropic.key.txt` | Opção em texto puro. Funciona, mas prefira o cofre. |

## Usando o arquivo de texto

Crie `anthropic.key.txt` com a chave em uma linha:

```
sk-ant-api03-...
```

Linhas começando com `#` são ignoradas. Depois, para migrar para o cofre:

```
npm run chave:definir -- --do-arquivo
rm secrets/anthropic.key.txt
```
