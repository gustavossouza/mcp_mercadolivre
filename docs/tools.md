> Security fork: local file_path upload and upload_video are disabled/removed. upload_picture accepts a public HTTPS URL only. See SECURITY-HARDENING.md.

# Referência completa das ferramentas

Documentação das 42 ferramentas do servidor MCP Mercado Livre, fiel à implementação em `src/index.ts`. Tipos: `leitura` (não altera nada na conta) e `escrita` (operação real no Mercado Livre — confirme com o usuário antes de executar).

Todos os endpoints são relativos a `https://api.mercadolibre.com`. `{site}` = `ML_SITE_ID` (padrão `MLB`). `{me}` = id do vendedor autenticado, resolvido via `GET /users/me`.

---

## Busca & Leitura

### search_products — leitura

Busca anúncios públicos em todo o marketplace (não nos anúncios do próprio vendedor — para isso use `get_my_items`).

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `query` | string | sim | — | Texto da busca, ex. "iphone 13 128gb" |
| `limit` | int | não | 10 | Máx. de resultados por página (1–50) |
| `offset` | int | não | — | Deslocamento de paginação |
| `category` | string | não | — | Restringe a uma categoria, ex. "MLB1055" |
| `price_min` | number | não | — | Preço mínimo (combinado com `price_max` no filtro `price=min-max`) |
| `price_max` | number | não | — | Preço máximo |

- **Endpoint:** `GET /sites/{site}/search`
- **Notas:** faixas abertas são suportadas (`price_min` sozinho vira `min-*`). Retorna id, título, preço, moeda, permalink, thumbnail, condição e flag de frete grátis.

### get_item — leitura

Detalhes completos de um anúncio pelo ID (próprio ou de concorrente).

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `item_id` | string | sim | — | ID completo com prefixo do site, ex. "MLB123456789" (números puros não funcionam) |

- **Endpoint:** `GET /items/{item_id}`
- **Retorno:** título, preço, moeda, estoque, vendidos, condição, status, permalink, URLs das fotos e atributos (id/nome/valor).

### get_my_items — leitura

Lista os anúncios do vendedor autenticado, hidratados com título/status/preço via multiget.

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `status` | enum (`active`, `paused`, `closed`) | não | todos | Filtro por status do anúncio |
| `limit` | int | não | 20 | Máx. de itens (1–100) |
| `offset` | int | não | — | Deslocamento de paginação |

- **Endpoints:** `GET /users/me` → `GET /users/{me}/items/search` → `GET /items?ids=...` (multiget, até 50 IDs por chamada)

### get_questions — leitura

Perguntas de pré-venda recebidas pelo vendedor, mais recentes primeiro.

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `status` | string | não | todos | `UNANSWERED`, `ANSWERED`, `DELETED`, `BANNED` ou `DISABLED` |
| `item_id` | string | não | — | Restringe a um anúncio |
| `limit` | int | não | 20 | Máx. de perguntas (1–50) |

- **Endpoint:** `GET /questions/search?seller_id={me}&sort_fields=date_created&sort_types=DESC`
- **Notas:** o caso mais comum é `status=UNANSWERED` — perguntas sem resposta prejudicam a conversão. O `id` da pergunta é necessário para `answer_question`.

### get_orders — leitura

Pedidos (vendas) do vendedor, mais recentes primeiro.

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `limit` | int | não | 10 | Máx. de pedidos (1–50) |
| `offset` | int | não | — | Deslocamento de paginação |
| `status` | string | não | todos | Filtro `order.status`: `confirmed`, `payment_required`, `payment_in_process`, `paid`, `shipped`, `delivered`, `cancelled` |

- **Endpoint:** `GET /orders/search?seller={me}&sort=date_desc`
- **Retorno:** id, data (ISO 8601), status, valor total, moeda, nickname do comprador e itens (id, título, quantidade, preço unitário). O `shipping.id` do pedido é o `shipment_id` usado nas ferramentas de Envios.

---

## Publicação

### predict_category — leitura

Prevê a categoria ideal para um título de produto. Chame ANTES de `create_item`.

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `title` | string | sim | — | Título do produto a classificar |

- **Endpoint:** `GET /sites/{site}/category_predictor/predict?title=...`
- **Retorno:** lista de previsões com id, nome, caminho completo (`path_from_root`) e probabilidade.

### get_category_attributes — leitura

Atributos de uma categoria e quais são obrigatórios. Chame após escolher a categoria e antes de `create_item`.

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `category_id` | string | sim | — | ID da categoria (de `predict_category`), ex. "MLB1055" |

- **Endpoint:** `GET /categories/{category_id}/attributes`
- **Notas:** todo atributo com `required=true` DEVE ir no parâmetro `attributes` de `create_item`. `allowed_values` é limitado a 50 entradas por atributo.

### get_listing_types — leitura

Tipos de anúncio (planos de exposição) disponíveis no site. Sem parâmetros.

- **Endpoint:** `GET /sites/{site}/listing_types`
- **Retorno:** ids e nomes (ex. `gold_special` = Clássica, `gold_pro` = Premium).

### get_listing_prices — leitura

Estima as taxas de venda por tipo de anúncio para um dado preço.

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `price` | number | sim | — | Preço de venda pretendido |
| `category_id` | string | não | — | Categoria (taxa mais precisa) |
| `listing_type_id` | string | não | todos | Tipo de anúncio; omita para ver todos |

- **Endpoint:** `GET /sites/{site}/listing_prices`
- **Retorno:** por tipo de anúncio: percentual e valor da comissão, exposição, free_relist, stop_time.

### create_item — escrita

Cria e PUBLICA um anúncio. Operação real: o item fica público e taxas se aplicam quando vender.

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `title` | string | sim | — | Título, máx. 60 caracteres |
| `category_id` | string | sim | — | Categoria (de `predict_category`) |
| `price` | number | sim | — | Preço de venda (> 0) |
| `available_quantity` | int | sim | — | Estoque (≥ 1) |
| `condition` | enum (`new`, `used`) | não | `new` | Condição do item |
| `listing_type_id` | string | não | `gold_special` | Plano de exposição (de `get_listing_types`) |
| `buying_mode` | string | não | `buy_it_now` | Modo de compra |
| `currency_id` | string | não | moeda do site (BRL p/ MLB) | Moeda ISO do preço |
| `description` | string | não | — | Descrição em texto puro (enviada como `plain_text`) |
| `pictures` | string[] | não | — | URLs de imagens (Meli baixa via `pictures[].source`) |
| `attributes` | {id, value_name}[] | não | — | Atributos; DEVE incluir todos os obrigatórios da categoria |
| `video_id` | string | não | — | ID de vídeo enviado com `upload_video` |
| `shipping` | objeto | não | — | Opções de envio, ex. `{free_shipping: true, mode: "me2"}` |

- **Endpoint:** `POST /items`
- **Notas:** em erro de validação, o corpo completo do erro do Meli é retornado para correção e nova tentativa (geralmente atributos obrigatórios faltando). Apenas os campos fornecidos são enviados.

### upload_picture — escrita (upload)

Envia uma imagem para a conta do vendedor e retorna o ID da foto.

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `url` | string (URL) | um dos dois | — | URL pública da imagem (Meli baixa) |
| `file_path` | string | um dos dois | — | Caminho absoluto de arquivo local (multipart) |

- **Endpoint:** `POST /pictures` (JSON `{source: url}` ou multipart `file`)
- **Notas:** exatamente um de `url`/`file_path` é obrigatório — enviar ambos ou nenhum retorna erro. Para imagens já em URL pública, passar a URL direto em `create_item` também funciona.

### upload_video — escrita (upload)

Envia um vídeo local e retorna o `video_id` para anexar a anúncios.

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `file_path` | string | sim | — | Caminho absoluto do vídeo (.mp4, .mov, .avi, .mkv, .webm) |

- **Endpoint:** `POST /pictures` (multipart `file`)
- **Notas:** extensão validada no cliente; arquivo inexistente ou extensão inválida falha antes de chamar a API. Meli impõe limites de tamanho/duração — arquivos grandes podem ser rejeitados (erro retornado como está).

---

## Gestão de anúncios

### update_item — escrita

Atualiza campos mutáveis de um anúncio: preço, estoque, título ou vídeo. Apenas os campos fornecidos são enviados.

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `item_id` | string | sim | — | ID completo do anúncio |
| `price` | number | não | — | Novo preço (> 0) |
| `available_quantity` | int | não | — | Novo estoque (≥ 0) |
| `title` | string | não | — | Novo título (máx. 60; só permitido sem vendas) |
| `video_id` | string | não | — | ID de vídeo da conta do vendedor |

- **Endpoint:** `PUT /items/{item_id}`
- **Notas:** chamar sem nenhum campo retorna erro local. O título só pode ser alterado enquanto o anúncio não tem vendas.

### update_item_status — escrita

Altera a visibilidade de um anúncio (mapeado para `status` = `paused`/`active`/`closed`).

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `item_id` | string | sim | — | ID completo do anúncio |
| `action` | enum (`pause`, `activate`, `close`) | sim | — | Ação a aplicar |
| `confirm` | boolean | obrigatório para `close` | — | Deve ser exatamente `true` para confirmar o fechamento irreversível |

- **Endpoint:** `PUT /items/{item_id}` com body `{status}`
- **Notas:** **fechar é efetivamente irreversível para anúncios com vendas** — um item `closed` não pode ser reativado. Pausar é reversível e preserva o histórico. **Portão de segurança:** `action="close"` sem `confirm: true` é recusado com a mensagem "Closing an item is irreversible. Call again with confirm: true to proceed."

---

## Perguntas

### answer_question — escrita

Responde uma pergunta de pré-venda. A resposta é pública e NÃO pode ser editada nem apagada.

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `question_id` | number | sim | — | ID da pergunta (de `get_questions`) |
| `text` | string | sim | — | Texto da resposta |

- **Endpoint:** `POST /answers`

### manage_question_blacklist — leitura/escrita

Gerencia a blacklist de perguntas: usuários bloqueados não podem fazer novas perguntas (mas ainda podem comprar).

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `action` | enum (`list`, `block`, `unblock`) | sim | — | `list` é leitura; `block`/`unblock` são escrita |
| `user_id` | number | para `block`/`unblock` | — | ID do usuário a bloquear/desbloquear |

- **Endpoints:** `GET /users/{me}/questions_blacklist` (list) · `POST /users/{user_id}/questions_blacklist?seller_id={me}` (block) · `DELETE /users/{user_id}/questions_blacklist?seller_id={me}` (unblock)

---

## Envios

### get_shipment — leitura

Detalhes do envio de uma venda: status, rastreio, endereço do destinatário e itens.

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `shipment_id` | number | sim | — | ID do envio (vem do `shipping.id` do pedido — use `get_orders` antes) |

- **Endpoint:** `GET /shipments/{shipment_id}`
- **Notas:** status incluem `pending`, `ready_to_ship`, `shipped`, `delivered`, `cancelled`. O endereço do destinatário é retornado como vem da API (o vendedor precisa dele).

### get_shipment_label — leitura (download)

Baixa a etiqueta de envio do Mercado Envios e salva em arquivo local.

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `shipment_id` | number | sim | — | ID do envio |
| `response_type` | enum (`pdf`, `zpl2`) | não | `pdf` | Formato da etiqueta (ZPL2 para impressoras térmicas Zebra) |

- **Endpoint:** `GET /shipment_labels?shipment_ids={id}&response_type={pdf|zpl2}` (conteúdo binário)
- **Notas:** salva em `labels/label_{shipment_id}.{pdf|zpl}` na raiz do projeto e retorna o caminho absoluto + tamanho. A etiqueta só existe após `ready_to_ship`; tipos logísticos como `flex`/`self_service` podem não ter etiqueta — o erro do Meli é retornado como está (a resposta JSON de erro é detectada via content-type, não salva como "etiqueta").

---

## Mensagens

### get_order_messages — leitura

Conversa de pós-venda com o comprador de um pedido.

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `order_id` | number | sim | — | ID do pedido (na API de mensagens, pack_id = order id) |
| `limit` | int | não | 20 | Máx. de mensagens (1–50) |

- **Endpoint:** `GET /messages/packs/{order_id}/sellers/{me}`
- **Retorno:** por mensagem: remetente/destinatário (user id + papel), texto, data e flag de lida.

### send_message — escrita

Envia mensagem de pós-venda ao comprador de um pedido. Mensagem REAL entregue ao comprador.

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `order_id` | number | sim | — | ID do pedido |
| `text` | string | sim | — | Texto, máx. 350 caracteres |

- **Endpoints:** `GET /orders/{order_id}` (descobre `buyer.id`) → `POST /messages/packs/{order_id}/sellers/{me}`
- **Notas:** mensagens passam por moderação — NÃO podem conter links, telefones, e-mails ou redes sociais, sob risco de sanções à conta (até suspensão). O limite de 350 caracteres é validado no schema. **Guarda de conteúdo:** o servidor varre o texto antes de chamar a API e bloqueia e-mails, telefones (formatos BR) e links/domínios, retornando "Message blocked: contains contact info...".

---

## Reclamações & Devoluções

### get_claims — leitura

Busca reclamações (claims) abertas contra o vendedor.

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `status` | string | não | todos | Filtro, ex. `opened`, `closed` |
| `date_from` | string | não | — | Criadas a partir de (ISO 8601; vira `date_created.from`) |
| `date_to` | string | não | — | Criadas até (ISO 8601; vira `date_created.to`) |
| `limit` | int | não | 10 | Máx. de reclamações (1–50) |
| `offset` | int | não | — | Deslocamento de paginação |

- **Endpoint:** `GET /post-purchase/claims/search?seller_id={me}`
- **Notas:** reclamações abertas têm prazo de resposta e prejudicam a reputação. Retorna id, tipo, status, estágio, `resource_id` (pedido), motivo e data.

### get_claim_detail — leitura

Detalhes completos de uma reclamação, incluindo as mensagens do thread.

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `claim_id` | number | sim | — | ID da reclamação (de `get_claims`) |

- **Endpoints:** `GET /post-purchase/claims/{claim_id}` + `GET /post-purchase/claims/{claim_id}/messages`
- **Notas:** se o endpoint de mensagens falhar, as mensagens são simplesmente omitidas — o restante do detalhe ainda é retornado. Retorna tipo, status, estágio, motivo, partes (complainant = comprador, respondent = vendedor), resolução e datas.

### send_claim_message — escrita

Envia mensagem dentro do thread de uma reclamação, como vendedor (`sender_role: "respondent"`).

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `claim_id` | number | sim | — | ID da reclamação |
| `text` | string | sim | — | Texto da mensagem |

- **Endpoint:** `POST /post-purchase/claims/{claim_id}/messages`
- **Notas:** visível ao comprador E à mediação do Mercado Livre — vira parte do registro da reclamação. Valem as regras de moderação (sem contatos/links), e a **guarda de conteúdo** bloqueia e-mails, telefones e links antes de chamar a API.

### get_returns — leitura

Lista devoluções de produtos, geralmente ligadas a uma reclamação.

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `status` | string | não | todos | Filtro, ex. `opened`, `closed` |
| `limit` | int | não | 10 | Máx. de devoluções (1–50) |
| `offset` | int | não | — | Deslocamento de paginação |

- **Endpoint:** `GET /post-purchase/returns/search?seller_id={me}`
- **Notas:** use `get_claim_detail` no `claim_id` retornado para o contexto completo. Contas sem devoluções podem receber erro da API — retornado de forma graciosa.

---

## Reputação & Métricas

### get_seller_reputation — leitura

Reputação de um vendedor (a própria conta por padrão, ou qualquer vendedor — dado público).

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `user_id` | number | não | conta autenticada | ID do vendedor a consultar |

- **Endpoint:** `GET /users/{user_id}`
- **Notas:** `level_id` é a escala de cores (1_red pior → 5_green melhor); `power_seller_status` traz os níveis Mercado Líder (`silver`, `gold`, `platinum`). Métricas retornadas: claims, atraso de despacho e cancelamentos (taxa, valor e período).

### get_item_visits — leitura

Visitas por anúncio em um período (padrão: últimos 30 dias, calculado no código).

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `item_ids` | string[] | sim | — | IDs dos anúncios (1–50) |
| `date_from` | string | não | 30 dias atrás | Início, YYYY-MM-DD |
| `date_to` | string | não | hoje | Fim, YYYY-MM-DD |

- **Endpoint:** `GET /items/visits?ids=...`
- **Notas:** combinação poderosa com `get_my_items` para achar anúncios com muitas visitas e poucas vendas. Lida com os dois formatos de resposta do Meli (array de mapas ou mapa único); itens sem dados retornam 0.

---

## Catálogo

### search_catalog — leitura

Busca produtos do catálogo (listings compartilhados com disputa de buy box).

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `query` | string | sim | — | Texto da busca, ex. "iPhone 13 128GB" |
| `limit` | int | não | 10 | Máx. de resultados (1–50) |
| `offset` | int | não | — | Deslocamento de paginação |

- **Endpoint:** `GET /products/search?site_id={site}`
- **Retorno:** id do produto, nome, thumbnail e até 10 atributos principais.

### get_catalog_product — leitura

Detalhes de um produto de catálogo, incluindo quem vence o buy box.

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `product_id` | string | sim | — | ID do produto de catálogo, ex. "MLB15171222" |

- **Endpoint:** `GET /products/{product_id}`
- **Retorno:** nome, atributos, fotos, características principais e `buy_box_winner` (item, vendedor, preço) quando presente.

### create_catalog_listing — escrita

Vincula um anúncio existente a um produto de catálogo (opt-in para a disputa do buy box).

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `item_id` | string | sim | — | Seu anúncio, ex. "MLB123456789" |
| `catalog_product_id` | string | sim | — | Produto de catálogo (de `search_catalog`) |

- **Endpoint:** `POST /items/catalog_listings` (body `{item_id, catalog_id}`)
- **Notas:** operação real — o anúncio passa a valer pelas regras do catálogo (frete grátis e regras de preço podem mudar). O item precisa pertencer ao vendedor autenticado e corresponder ao produto.

---

## Preço & Mercado

### get_price_suggestion — leitura

Sugestão de preço competitivo do Meli para um anúncio.

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `item_id` | string | sim | — | ID do anúncio |

- **Endpoint:** `GET /suggestions/items/{item_id}/details`
- **Notas:** nem todo anúncio tem sugestão (dados insuficientes) — dados parciais são retornados como vierem.

### get_trends — leitura

Termos de busca em alta no marketplace (site inteiro ou por categoria).

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `category_id` | string | não | site inteiro | Restringe a uma categoria |
| `limit` | int | não | 20 | Máx. de termos (1–50; corte feito no cliente) |

- **Endpoint:** `GET /trends/{site}` ou `GET /trends/{site}/{category_id}`

### convert_currency — leitura

Taxa de câmbio atual entre duas moedas.

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `from` | string | sim | — | Moeda de origem, ex. "USD" |
| `to` | string | sim | — | Moeda de destino, ex. "BRL" |

- **Endpoint:** `GET /currency_conversions/search?from=...&to=...`

---

## Categorias

### get_site_categories — leitura

Categorias de primeiro nível do site. Sem parâmetros.

- **Endpoint:** `GET /sites/{site}/categories`

### get_category — leitura

Detalhes, filhos e configurações de uma categoria.

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `category_id` | string | sim | — | ID da categoria, ex. "MLB1055" |

- **Endpoint:** `GET /categories/{category_id}`
- **Notas:** categoria sem filhos é "folha" — pode ser usada como `category_id` em `create_item`. `settings` inclui `max_pictures_per_item`, `max_description_length`, `max_title_length`, `vip_subdomain`, `adult_content` e `buying_allowed`.

---

## Promoções

### get_promotions — leitura

Campanhas/promoções oferecidas ao vendedor (candidatas e ativas).

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `status` | string | não | todos | ex. `candidate` (pode participar), `started` (em andamento) |
| `promotion_type` | string | não | todos | ex. `DEAL`, `LIGHTNING` |
| `limit` | int | não | 10 | Máx. de promoções (1–50) |
| `offset` | int | não | — | Deslocamento de paginação |

- **Endpoint:** `GET /seller-promotions/promotions?seller_id={me}`
- **Notas:** pode legitimamente retornar lista vazia quando não há campanhas para a conta.

### get_promotion_items — leitura

Itens participando de uma promoção, com preço promocional e original.

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `promotion_id` | string | sim | — | ID da promoção (de `get_promotions`) |
| `limit` | int | não | 20 | Máx. de itens (1–50) |
| `offset` | int | não | — | Deslocamento de paginação |

- **Endpoint:** `GET /seller-promotions/promotions/{promotion_id}/items?seller_id={me}`

### add_item_to_promotion — escrita

Inscreve um anúncio em uma campanha com o preço oferecido.

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `item_id` | string | sim | — | Seu anúncio |
| `promotion_id` | string | sim | — | ID da promoção |
| `deal_price` | number | sim | — | Preço promocional (> 0) |
| `top_deal_price` | number | não | — | Preço ainda menor para exposição extra |

- **Endpoint:** `POST /seller-promotions/items/{item_id}?seller_id={me}`
- **Notas:** operação real — se aprovado, o item passa a ser vendido pelo preço promocional durante a campanha.

---

## Mercado Ads

### get_ads_campaigns — leitura

Campanhas de Product Ads do vendedor.

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `status` | string | não | todos | ex. `active`, `paused` |
| `limit` | int | não | 20 | Máx. de campanhas (1–50) |
| `offset` | int | não | — | Deslocamento de paginação |

- **Endpoint:** `GET /advertising/product_ads/campaigns?user_id={me}`
- **Notas:** **requer o escopo de advertising no app e uma conta de Ads ativa** — erros de escopo/permissão são retornados claramente.

### get_ads_campaign_metrics — leitura

Métricas de desempenho de uma campanha em um período (padrão: últimos 30 dias).

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `campaign_id` | number | sim | — | ID da campanha (de `get_ads_campaigns`) |
| `date_from` | string | não | 30 dias atrás | Início, YYYY-MM-DD |
| `date_to` | string | não | hoje | Fim, YYYY-MM-DD |

- **Endpoint:** `GET /advertising/product_ads/campaigns/{campaign_id}/metrics`
- **Retorno:** impressões, cliques, CTR, custo, vendas atribuídas, receita e ACOS (quando presentes).

---

## Fulfillment (Full)

### get_fulfillment_stock — leitura

Estoque armazenado nos centros de fulfillment do Mercado Livre.

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `limit` | int | não | 50 | Máx. de registros (1–100) |

- **Endpoint:** `GET /fulfillment/stock?seller_id={me}`
- **Notas:** **só funciona para contas com Full habilitado** — caso contrário o erro do Meli é retornado claramente. Retorna inventory_id, SKU, quantidade disponível, avariada e não vendável.

---

## Mercado Shops & Depósitos

### get_mercado_shop — leitura

Informações da Mercado Shop do vendedor, se a conta tiver uma. Sem parâmetros.

- **Endpoints:** `GET /users/{me}/shop` (fallback: `GET /shops/search?seller_id={me}`)
- **Notas:** contas sem loja recebem resposta graciosa `{shop: null, message: ...}` em vez de erro.

### get_warehouses — leitura

Depósitos/origens de estoque cadastrados. Sem parâmetros.

- **Endpoint:** `GET /user-warehouses?seller_id={me}`
- **Retorno:** id, descrição, cidade/estado e localização de estoque de cada depósito.
