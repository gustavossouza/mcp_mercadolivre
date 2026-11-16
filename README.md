> **Fork de segurança em revisão; não aprovado para produção HTTP.**
> O transporte permanece stdio. Não exponha por proxy/túnel sem camada autenticada revisada.
> Agora o padrão é somente leitura, perfil `leitura`; configurações inválidas abortam.
> Uploads de arquivos locais e vídeo foram removidos deliberadamente. Imagens usam apenas URL HTTPS pública.
> OAuth requer state/PKCE e callback local; compatibilidade PKCE com a aplicação Mercado Livre deve ser homologada.
> Veja `SECURITY-HARDENING.md` para alterações, limitações e migração.

# MCP Mercado Livre

Servidor MCP (Model Context Protocol) em TypeScript para a API do Mercado Livre, focado em vendedores. Permite que LLMs (Claude Desktop, Kimi Code, Cursor etc.) pesquisem o marketplace, publiquem e gerenciem anúncios, respondam perguntas, acompanhem pedidos, envios, reclamações, reputação, catálogo, promoções e muito mais — tudo por linguagem natural.

Projeto **open source (MIT)** — contribuições são bem-vindas! Veja [Contribuindo](#contribuindo).

## Destaques

- **42 ferramentas** cobrindo o ciclo completo do vendedor (busca, publicação, gestão, pós-venda, reputação, catálogo, promoções, Ads, Full, Shops)
- **OAuth 2.0 com refresh automático** — tokens de 6h renovados 5 min antes de expirar, com persistência da rotação do refresh token
- **Suporte a Docker Compose** — rode o servidor e a autenticação em containers, com tokens em volume persistente
- **Erros graciosos** — falhas da API (validação, escopo, permissão) retornam a mensagem do Mercado Livre de forma clara, sem derrubar o servidor
- **Zero dependências além do essencial** — apenas `@modelcontextprotocol/sdk` e `zod`; HTTP via `fetch` nativo do Node 18+

## Início rápido

> 🔰 **Nunca usou MCP ou a API do Mercado Livre?** Siga o [guia de instalação detalhado para iniciantes](docs/instalacao.md) — passo a passo com prints do que esperar em cada etapa.

### Via npm (recomendado — sem clonar o repositório)

1. Crie o aplicativo no [portal de desenvolvedores do Mercado Livre](https://developers.mercadolivre.com.br) (detalhes no [guia de instalação](docs/instalacao.md#passo-2--criar-o-aplicativo-no-portal-de-desenvolvedores-do-mercado-livre)) e anote o Client ID e o Client Secret.
2. Escolha uma pasta fixa para os tokens (ex. `~/mcp-meli`), entre nela e autentique:
   ```bash
   mkdir -p ~/mcp-meli && cd ~/mcp-meli
   npx -y -p @gustavohssouza/mcp-mercadolivre mcp-mercadolivre-auth
   ```
   O navegador abre, você autoriza, e o `tokens.json` é salvo nessa pasta. Como clientes MCP podem iniciar o servidor com outro diretório de trabalho, o passo seguinte aponta `ML_TOKENS_FILE` para esse arquivo.
3. Configure o cliente MCP (Claude Desktop, Cursor, Kimi Code):
   ```json
   {
     "mcpServers": {
       "mercadolivre": {
         "command": "npx",
         "args": ["-y", "@gustavohssouza/mcp-mercadolivre"],
         "env": {
           "ML_CLIENT_ID": "seu_client_id",
           "ML_CLIENT_SECRET": "seu_client_secret",
           "ML_SITE_ID": "MLB",
           "ML_TOKENS_FILE": "/caminho/absoluto/para/mcp-meli/tokens.json"
         }
       }
     }
   }
   ```

### Alternativa: instalação a partir do código-fonte

Para contribuir ou modificar o código:

```bash
git clone https://github.com/SEU_USUARIO/mcp_mercadolivre
cd mcp_mercadolivre
```

### Pré-requisitos

- Node.js >= 18 (ou Docker + Docker Compose)
- Um aplicativo criado em [developers.mercadolivre.com.br](https://developers.mercadolivre.com.br) com a Redirect URI `http://localhost:3333/callback`

### Configuração

1. Instale as dependências:
   ```bash
   npm install
   ```
2. Crie o arquivo de ambiente:
   ```bash
   cp .env.example .env
   ```
3. Preencha `.env` com `ML_CLIENT_ID` e `ML_CLIENT_SECRET` do seu aplicativo.
4. Compile:
   ```bash
   npm run build
   ```
5. Autentique (abre o navegador, captura o código e salva os tokens em `tokens.json`):
   ```bash
   npm run auth
   ```
6. Configure seu cliente MCP (veja [Configuração nos clientes MCP](#configuração-nos-clientes-mcp)) e comece a conversar.

Os tokens são renovados automaticamente (vida útil de 6h, com refresh 5 min antes de expirar). O refresh token é rotacionado pelo Mercado Livre e sempre persistido junto.

## Ferramentas disponíveis (42)

Legenda: 📖 leitura · ✏️ escrita (operação real na conta)

### Busca & Leitura

| Ferramenta | Tipo | Descrição |
|---|---|---|
| `search_products` | 📖 | Busca produtos em todo o marketplace (filtros de categoria e faixa de preço) |
| `get_item` | 📖 | Detalhes de um anúncio pelo ID (preço, estoque, vendidos, fotos, atributos) |
| `get_my_items` | 📖 | Lista os anúncios do vendedor autenticado (filtro por status: active/paused/closed) |
| `get_questions` | 📖 | Perguntas recebidas (filtro por status, ex. UNANSWERED, e por anúncio) |
| `get_orders` | 📖 | Pedidos/vendas do vendedor, mais recentes primeiro |

### Publicação

| Ferramenta | Tipo | Descrição |
|---|---|---|
| `predict_category` | 📖 | Prevê a categoria ideal a partir do título do produto |
| `get_category_attributes` | 📖 | Lista os atributos (e quais são obrigatórios) de uma categoria |
| `get_listing_types` | 📖 | Lista os tipos de anúncio disponíveis (Clássica, Premium etc.) |
| `get_listing_prices` | 📖 | Estima as taxas de venda por tipo de anúncio para um dado preço |
| `create_item` | ✏️ | Cria e publica um novo anúncio |
| `upload_picture` | ✏️ | Faz upload de imagem (URL pública ou arquivo local) e retorna o ID da foto |
| `upload_video` | ✏️ | Faz upload de vídeo (arquivo local) e retorna o `video_id` para anexar ao anúncio |

### Gestão de anúncios

| Ferramenta | Tipo | Descrição |
|---|---|---|
| `update_item` | ✏️ | Atualiza preço, estoque, título ou vídeo de um anúncio existente |
| `update_item_status` | ✏️ | Pausa, ativa ou fecha um anúncio (fechar com vendas é irreversível) |

### Perguntas

| Ferramenta | Tipo | Descrição |
|---|---|---|
| `answer_question` | ✏️ | Responde uma pergunta de comprador (pública e não editável) |
| `manage_question_blacklist` | 📖/✏️ | Gerencia a blacklist de perguntas (listar, bloquear, desbloquear usuários) |

### Envios

| Ferramenta | Tipo | Descrição |
|---|---|---|
| `get_shipment` | 📖 | Detalhes do envio de uma venda (status, rastreio, endereço, itens) |
| `get_shipment_label` | 📖 | Baixa a etiqueta de envio (PDF ou ZPL2) em `labels/` |

### Mensagens

| Ferramenta | Tipo | Descrição |
|---|---|---|
| `get_order_messages` | 📖 | Lê a conversa de pós-venda com o comprador de um pedido |
| `send_message` | ✏️ | Envia mensagem ao comprador (moderada; máx. 350 caracteres) |

### Reclamações & Devoluções

| Ferramenta | Tipo | Descrição |
|---|---|---|
| `get_claims` | 📖 | Busca reclamações do vendedor (filtros de status e período) |
| `get_claim_detail` | 📖 | Detalhes de uma reclamação, incluindo as mensagens do thread |
| `send_claim_message` | ✏️ | Responde dentro do thread de uma reclamação (visível à mediação) |
| `get_returns` | 📖 | Lista devoluções de produtos, geralmente ligadas a reclamações |

### Reputação & Métricas

| Ferramenta | Tipo | Descrição |
|---|---|---|
| `get_seller_reputation` | 📖 | Termômetro de reputação e métricas (claims, atrasos, cancelamentos) |
| `get_item_visits` | 📖 | Visitas por anúncio em um período (padrão: últimos 30 dias) |

### Catálogo

| Ferramenta | Tipo | Descrição |
|---|---|---|
| `search_catalog` | 📖 | Busca produtos do catálogo (listings compartilhados com buy box) |
| `get_catalog_product` | 📖 | Detalhes do produto de catálogo, incluindo quem vence o buy box |
| `create_catalog_listing` | ✏️ | Vincula um anúncio existente a um produto de catálogo |

### Preço & Mercado

| Ferramenta | Tipo | Descrição |
|---|---|---|
| `get_price_suggestion` | 📖 | Sugestão de preço competitivo do Mercado Livre para um anúncio |
| `get_trends` | 📖 | Termos de busca em alta no marketplace (site ou por categoria) |
| `convert_currency` | 📖 | Taxa de câmbio atual entre moedas |

### Categorias

| Ferramenta | Tipo | Descrição |
|---|---|---|
| `get_site_categories` | 📖 | Categorias de primeiro nível do site |
| `get_category` | 📖 | Detalhes, filhos e restrições de uma categoria (máx. fotos etc.) |

### Promoções

| Ferramenta | Tipo | Descrição |
|---|---|---|
| `get_promotions` | 📖 | Lista campanhas/promoções oferecidas ao vendedor (candidatas e ativas) |
| `get_promotion_items` | 📖 | Itens participando de uma promoção, com preço promocional |
| `add_item_to_promotion` | ✏️ | Inscreve um anúncio em uma campanha com o preço oferecido |

### Mercado Ads

| Ferramenta | Tipo | Descrição |
|---|---|---|
| `get_ads_campaigns` | 📖 | Lista campanhas de Product Ads (status, orçamento, estratégia) |
| `get_ads_campaign_metrics` | 📖 | Métricas de uma campanha (impressões, cliques, CTR, custo, ACOS) |

### Fulfillment (Full)

| Ferramenta | Tipo | Descrição |
|---|---|---|
| `get_fulfillment_stock` | 📖 | Estoque armazenado nos centros de fulfillment do Mercado Livre |

### Mercado Shops & Depósitos

| Ferramenta | Tipo | Descrição |
|---|---|---|
| `get_mercado_shop` | 📖 | Informações da Mercado Shop do vendedor (se a conta tiver uma) |
| `get_warehouses` | 📖 | Depósitos/origens de estoque cadastrados pelo vendedor |

> **Nota:** as ferramentas de Mercado Ads, Fulfillment (Full) e Mercado Shops exigem que a conta/aplicativo tenha esses recursos habilitados (escopo de advertising, conta Full, loja criada). Caso contrário, o erro retornado pelo Mercado Livre é exibido claramente pela ferramenta.

## Fluxos recomendados

### Criar um anúncio

1. **`predict_category`** com o título do produto → obtém o `category_id` ideal.
2. **`get_category_attributes`** com a categoria escolhida → descobre os atributos obrigatórios.
3. *(opcional)* **`get_listing_types`** e **`get_listing_prices`** → escolhe o tipo de anúncio e estima as taxas.
4. *(opcional)* **`upload_picture`** e/ou **`upload_video`** → envia as mídias locais antes, caso não estejam em URLs públicas, e guarda os IDs retornados.
5. **`create_item`** com todos os atributos obrigatórios preenchidos (e `video_id` se houver vídeo) → publica o anúncio.

Se o Mercado Livre rejeitar a criação com erro de validação, o corpo completo do erro é retornado — basta corrigir os campos indicados e tentar novamente.

### Operação diária do vendedor

1. **`get_questions`** com `status=UNANSWERED` → responde com **`answer_question`** (conversão depende disso).
2. **`get_orders`** → novos pedidos; **`get_shipment`** + **`get_shipment_label`** para despachar.
3. **`get_claims`** com `status=opened` → entende com **`get_claim_detail`** e responde com **`send_claim_message`** (prazos contam para a reputação).
4. **`get_item_visits`** + **`get_my_items`** → detecta anúncios com visitas e sem vendas; ajusta preço com **`get_price_suggestion`** e **`update_item`**.
5. **`get_seller_reputation`** → acompanha o termômetro e as métricas de claims/atrasos/cancelamentos.

## Uso com Docker Compose

```bash
# build da imagem
docker compose build

# autenticação no HOST confiável, não no container (callback apenas loopback)
node dist/auth-cli.js

# executar o servidor MCP manualmente (stdio)
docker compose run --rm mcp-mercadolivre
```

Os tokens ficam no volume nomeado `meli-data` (`/app/data/tokens.json` dentro do container), usado pelo serviço `mcp-mercadolivre`. O auth em container foi removido; transfira o arquivo de tokens por um fluxo administrativo seguro, sem publicar a porta de callback.

## Configuração nos clientes MCP

### Execução local (Node)

Claude Desktop (`claude_desktop_config.json`), Kimi Code ou Cursor — trecho `mcpServers`:

```json
{
  "mcpServers": {
    "mercadolivre": {
      "command": "node",
      "args": ["/caminho/absoluto/para/mcp_mercadolivre/dist/index.js"],
      "env": {
        "ML_CLIENT_ID": "seu_app_id",
        "ML_CLIENT_SECRET": "seu_client_secret",
        "ML_SITE_ID": "MLB"
      }
    }
  }
}
```

O caminho exato do arquivo de configuração de cada cliente (macOS/Windows/Linux) está no [guia de instalação](docs/instalacao.md#passo-6--conectar-no-seu-cliente-mcp).

### Execução via Docker

```json
{
  "mcpServers": {
    "mercadolivre": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "--env-file", "/caminho/absoluto/para/mcp_mercadolivre/.env",
        "-e", "ML_TOKENS_FILE=/app/data/tokens.json",
        "-v", "mcp_mercadolivre_meli-data:/app/data",
        "mcp-mercadolivre"
      ]
    }
  }
}
```

> Importante: rode a autenticação (`node dist/auth-cli.js`) antes de usar o servidor via Docker, para que os tokens existam no volume.

## Segurança

O servidor inclui um pacote de proteções para operar sua conta com segurança, especialmente enquanto você experimenta.

### Modo somente leitura (`ML_READ_ONLY`)

`ML_READ_ONLY=true` e `ML_TOOL_PROFILE=leitura` são os padrões. Para habilitar escritas é necessário configurar explicitamente `ML_READ_ONLY=false` e um perfil de escrita. Valores inválidos interrompem a inicialização. Nenhuma ferramenta de escrita, inclusive blacklist, é registrada no modo leitura.

### Perfis de ferramentas (`ML_TOOL_PROFILE`)

Limita quais ferramentas o servidor expõe:

| Perfil | Ferramentas | Total |
|---|---|---|
| `all` (opt-in) | Todas exceto vídeo local | 41 |
| `leitura` (padrão) | Apenas leitura | 31 |
| `vendas` | Leitura + responder perguntas, mensagens ao comprador, mensagens em reclamações, blacklist de perguntas | 35 |
| `publicacao` | Leitura + criar/atualizar anúncios, imagem HTTPS, opt-in de catálogo | 36 |

### Confirmação de ação irreversível

`update_item_status` com `action="close"` exige o parâmetro `confirm: true` — sem ele, a chamada é recusada com uma mensagem pedindo a confirmação explícita (fechar um anúncio com vendas é irreversível).

### Guarda de conteúdo em mensagens

`send_message` e `send_claim_message` varrem o texto **antes** de chamar a API e bloqueiam mensagens contendo e-mails, telefones (formatos BR) ou links/domínios — conteúdo proibido pela moderação do Mercado Livre, que pode sancionar a conta. A mensagem de bloqueio explica o motivo para o texto ser reformulado.

### Log de auditoria

Toda invocação de ferramenta de escrita é registrada em `audit.log` (raiz do projeto, append-only, gitignored) com timestamp, ferramenta, e resultado (sem conteúdo dos parâmetros) (`ok`/`error`). Ferramentas de leitura não são logadas.

### Permissões do arquivo de tokens

Na inicialização e após salvar tokens, o servidor verifica `tokens.json`: se as permissões forem mais abertas que `0600` (legível por grupo/outros), um aviso é impresso e o modo é corrigido automaticamente para `0600`.

## Solução de problemas

- **O cadastro do app rejeita a Redirect URI `http://localhost:3333/callback`:** o Mercado Livre exige HTTPS para apps em produção, mas aceita `http://localhost` durante a autenticação. Se o formulário de cadastro recusar, cadastre temporariamente uma URL HTTPS qualquer (ex. `https://localhost/callback`) e, na hora de autenticar, mantenha `ML_REDIRECT_URI=http://localhost:3333/callback` no `.env` — ou use uma URL HTTPS válida e ajuste `ML_REDIRECT_URI` e o `auth-cli` de acordo.
- **Redirect URI mismatch na autenticação:** o `ML_REDIRECT_URI` do `.env` precisa ser idêntico ao cadastrado no aplicativo (incluindo porta e path). Qualquer diferença faz o Meli recusar o callback.
- **`No tokens stored`:** rode `npm run auth` (ou o serviço `auth` do compose) novamente.
- **Erros 401 persistentes / refresh token expirado:** o refresh token tem validade máxima (~6 meses) e é rotacionado a cada refresh — se a conta ficou muito tempo sem uso ou o arquivo de tokens foi perdido, refaça a autenticação.
- **Erros de escopo/permissão nas ferramentas de Ads, Full ou Shops (403/404):** essas APIs exigem recursos extras — escopo de advertising concedido ao app, conta Full habilitada, ou uma Mercado Shop criada. O servidor retorna a mensagem do Meli como está; habilite o recurso na conta/app e tente novamente.
- **Erros de validação no `create_item`:** o corpo completo do erro do Meli é retornado — normalmente indica atributos obrigatórios faltando (rode `get_category_attributes` na categoria) ou valores fora do permitido. Corrija os campos indicados e reenvie.
- **Etiqueta de envio não encontrada:** a etiqueta só existe quando o envio está `ready_to_ship`, e tipos logísticos como `flex`/`self_service` não têm etiqueta para impressão.

## Estrutura do projeto

```
mcp_mercadolivre/
├── src/
│   ├── index.ts        # Servidor MCP: registro das 42 ferramentas
│   ├── meli-client.ts  # Cliente HTTP da API Meli (Bearer, retry 401, multipart, binário)
│   ├── auth.ts         # OAuth 2.0: URL de autorização, troca/refresh de tokens
│   ├── auth-cli.ts     # CLI de autenticação (servidor local :3333 + browser)
│   ├── token-store.ts  # Persistência dos tokens em tokens.json (0600)
│   ├── safety.ts       # Perfis, read-only, guarda de conteúdo, audit log
│   └── config.ts       # Variáveis de ambiente + parser de .env sem dependências
├── docs/
│   ├── instalacao.md   # Guia de instalação passo a passo para iniciantes
│   ├── arquitetura.md  # Arquitetura, fluxo OAuth e decisões de design
│   ├── tools.md        # Referência completa das 42 ferramentas
│   └── api-map.md      # Mapa de endpoints da API Meli utilizados e cobertura
├── dist/               # Build (tsc)
├── Dockerfile
├── docker-compose.yml
├── LICENSE             # Licença MIT
├── CONTRIBUTING.md     # Guia de contribuição
├── .env.example
└── package.json
```

## Documentação

- [docs/instalacao.md](docs/instalacao.md) — guia de instalação passo a passo (para quem nunca usou MCP)
- [docs/arquitetura.md](docs/arquitetura.md) — arquitetura interna, fluxo OAuth e estratégia de erros
- [docs/tools.md](docs/tools.md) — referência detalhada de cada ferramenta (parâmetros, endpoints, notas)
- [docs/api-map.md](docs/api-map.md) — endpoints da API do Mercado Livre utilizados e áreas não cobertas

## Contribuindo

Contribuições são muito bem-vindas — issues, sugestões de novas ferramentas e pull requests. Leia o [CONTRIBUTING.md](CONTRIBUTING.md) para os padrões do código e o checklist de como adicionar uma nova ferramenta.

## Licença

Distribuído sob a licença MIT. Veja o arquivo [LICENSE](LICENSE) para o texto completo.

## Autor & Contato

- **Nome:** Gustavo Santos
- **GitHub:** https://github.com/gustavossouza
- **Email:** gustavohsantos2009@hotmail.com
- **LinkedIn:** https://www.linkedin.com/in/gustavohssouza/
- **WhatsApp:** +55 41 99101-6997
