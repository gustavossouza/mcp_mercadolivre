#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z, type ZodRawShape } from "zod";
import { config } from "./config.js";
import {
  MeliApiError,
  meliDelete,
  meliGet,
  meliGetRaw,
  meliPost,
  meliPostForm,
  meliPut,
} from "./meli-client.js";
import {
  ALL_TOOLS,
  auditLog,
  containsContactInfo,
  CONTACT_INFO_MESSAGE,
  isWriteTool,
  resolveSafety,
  toolAllowed,
} from "./safety.js";
import { enforceTokenPermissions } from "./token-store.js";

const server = new McpServer({
  name: "mcp-mercadolivre",
  version: "1.0.0",
}, { maxToolInputElements: 2048 });

const safety = resolveSafety();
enforceTokenPermissions();

// Registers a tool only when the active safety config allows it, and wraps
// write tools with audit logging (one JSON line per invocation).
type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function registerTool<Args extends ZodRawShape>(
  name: string,
  meta: { description: string; inputSchema: Args },
  handler: (
    args: z.output<z.ZodObject<Args>>
  ) => Promise<ToolResult> | ToolResult
): void {
  if (!toolAllowed(name, safety)) return;
  server.registerTool(
    name,
    meta,
    (async (args: unknown) => {
      if (!isWriteTool(name))
        return handler(args as z.output<z.ZodObject<Args>>);
      const ts = new Date().toISOString();
      const result = await handler(args as z.output<z.ZodObject<Args>>);
      auditLog({
        ts,
        tool: name,
        result: result?.isError ? "error" : "ok",
      });
      return result;
    }) as never
  );
}

const registeredCount = ALL_TOOLS.filter((t) => toolAllowed(t, safety)).length;
console.error(
  `Safety: profile=${safety.profile}, read_only=${safety.readOnly}, tools=${registeredCount}/${ALL_TOOLS.length}`
);

const SITE_CURRENCY: Record<string, string> = {
  MLB: "BRL",
  MLA: "ARS",
  MLM: "MXN",
  MLC: "CLP",
  MCO: "COP",
  MLU: "UYU",
  MPE: "PEN",
};

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function fail(err: unknown) {
  let message = err instanceof Error ? err.message : String(err);
  if (err instanceof MeliApiError && err.details !== undefined) {
    message += `\nMeli response body: ${JSON.stringify(err.details)}`;
  }
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

async function getMyUserId(): Promise<number> {
  const me = await meliGet<{ id: number }>("/users/me");
  return me.id;
}

// ---------------------------------------------------------------------------
// Busca & leitura
// ---------------------------------------------------------------------------

registerTool(
  "search_products",
  {
    description:
      "Search public listings on Mercado Livre for the configured site (ML_SITE_ID, default MLB = Brazil). Use this to research competitors, market prices, or find item/category ids by keyword — it searches the whole marketplace, NOT the seller's own listings (use get_my_items for that). Results are paginated: use limit (max 50) and offset to page through. Returns total count plus a compact list with id, title, price, currency, permalink, thumbnail, condition (new/used) and free-shipping flag.",
    inputSchema: {
      query: z
        .string()
        .describe("Search text, e.g. 'iphone 13 128gb'"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Max results per page, 1-50 (default 10)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Pagination offset; combine with limit to fetch further pages"),
      category: z
        .string()
        .optional()
        .describe("Restrict search to a category id, e.g. 'MLB1055' (get ids from predict_category)"),
      price_min: z
        .number()
        .optional()
        .describe("Minimum price filter (inclusive), combined with price_max"),
      price_max: z
        .number()
        .optional()
        .describe("Maximum price filter (inclusive), combined with price_min"),
    },
  },
  async ({ query, limit, offset, category, price_min, price_max }) => {
    try {
      let price: string | undefined;
      if (price_min !== undefined || price_max !== undefined) {
        price = `${price_min ?? "*"}-${price_max ?? "*"}`;
      }
      const data = await meliGet<{
        results?: Array<Record<string, unknown>>;
        paging?: { total?: number };
      }>(`/sites/${config.siteId}/search`, {
        q: query,
        limit,
        offset,
        category,
        price,
      });
      const results = (data.results ?? []).map((r) => {
        const shipping = (r.shipping ?? {}) as { free_shipping?: boolean };
        return {
          id: r.id,
          title: r.title,
          price: r.price,
          currency: r.currency_id,
          permalink: r.permalink,
          thumbnail: r.thumbnail,
          condition: r.condition,
          free_shipping: shipping.free_shipping ?? false,
        };
      });
      return ok({ total: data.paging?.total ?? results.length, results });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_item",
  {
    description:
      "Get full details of a single Mercado Livre listing by its item id. The id must be the complete id including the site prefix, e.g. 'MLB123456789' — bare numbers do not work. Use this to inspect a specific listing (yours or a competitor's) in depth: stock, sales count, pictures and attributes. For bulk listing of the seller's own items use get_my_items instead. Returns title, price, currency, available_quantity, sold_quantity, condition, status (active/paused/closed/...), permalink, picture URLs and attributes (id/name/value).",
    inputSchema: {
      item_id: z
        .string()
        .describe("Full item id with site prefix, e.g. 'MLB123456789'"),
    },
  },
  async ({ item_id }) => {
    try {
      const item = await meliGet<Record<string, unknown>>(`/items/${item_id}`);
      const pictures = Array.isArray(item.pictures)
        ? (item.pictures as Array<{ url?: string }>).map((p) => p.url)
        : [];
      const attributes = Array.isArray(item.attributes)
        ? (item.attributes as Array<Record<string, unknown>>).map((a) => ({
            id: a.id,
            name: a.name,
            value: a.value_name,
          }))
        : [];
      return ok({
        id: item.id,
        title: item.title,
        price: item.price,
        currency: item.currency_id,
        available_quantity: item.available_quantity,
        sold_quantity: item.sold_quantity,
        condition: item.condition,
        status: item.status,
        permalink: item.permalink,
        pictures,
        attributes,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_my_items",
  {
    description:
      "List the authenticated seller's own listings, with optional status filter. Use this whenever the user asks about 'my listings/ads/products' — for marketplace-wide search use search_products instead. Status filter values: 'active' (published and visible), 'paused' (temporarily hidden), 'closed' (finished; items with sales usually end here). Results are paginated via limit/offset; each entry is hydrated with id, title, status, price, currency and permalink. Requires authentication.",
    inputSchema: {
      status: z
        .enum(["active", "paused", "closed"])
        .optional()
        .describe("Filter by listing status: active, paused or closed. Omit to list all statuses"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(20)
        .describe("Max items to return, 1-100 (default 20)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Pagination offset"),
    },
  },
  async ({ status, limit, offset }) => {
    try {
      const userId = await getMyUserId();
      const search = await meliGet<{
        results?: string[];
        paging?: { total?: number };
      }>(`/users/${userId}/items/search`, { status, limit, offset });
      const ids = search.results ?? [];
      if (ids.length === 0) {
        return ok({ total: search.paging?.total ?? 0, items: [] });
      }
      const multi = await meliGet<
        Array<{ code: number; body?: Record<string, unknown> }>
      >("/items", { ids: ids.slice(0, 50).join(",") });
      const items = multi
        .filter((entry) => entry.code === 200 && entry.body)
        .map((entry) => ({
          id: entry.body!.id,
          title: entry.body!.title,
          status: entry.body!.status,
          price: entry.body!.price,
          currency: entry.body!.currency_id,
          permalink: entry.body!.permalink,
        }));
      return ok({ total: search.paging?.total ?? items.length, items });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_questions",
  {
    description:
      "List pre-sale questions buyers asked on the authenticated seller's listings, newest first. Use status='UNANSWERED' to find questions still waiting for a reply — that is the most common use case, since unanswered questions hurt conversion. Other status values: 'ANSWERED', 'DELETED', 'BANNED', 'DISABLED'. Use item_id to restrict to one listing. Each question comes back with its id (needed by answer_question), text, item id, status, creation date (ISO 8601), and the answer (text + date) when one exists. Requires authentication.",
    inputSchema: {
      status: z
        .string()
        .optional()
        .describe(
          "Filter by question status: 'UNANSWERED', 'ANSWERED', 'DELETED', 'BANNED' or 'DISABLED'. Omit to list all; use UNANSWERED to find pending questions"
        ),
      item_id: z
        .string()
        .optional()
        .describe("Restrict to a single item id, e.g. 'MLB123456789'"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(20)
        .describe("Max questions to return, 1-50 (default 20)"),
    },
  },
  async ({ status, item_id, limit }) => {
    try {
      const sellerId = await getMyUserId();
      const data = await meliGet<{
        questions?: Array<Record<string, unknown>>;
        total?: number;
      }>("/questions/search", {
        seller_id: sellerId,
        status,
        item: item_id,
        limit,
        sort_fields: "date_created",
        sort_types: "DESC",
      });
      const questions = (data.questions ?? []).map((q) => {
        const answer = q.answer as
          | { text?: string; date_created?: string }
          | undefined;
        return {
          id: q.id,
          item_id: q.item_id,
          status: q.status,
          text: q.text,
          date_created: q.date_created,
          answer: answer
            ? { text: answer.text, date_created: answer.date_created }
            : null,
        };
      });
      return ok({ total: data.total ?? questions.length, questions });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_orders",
  {
    description:
      "List the authenticated seller's orders (sales), newest first (sort=date_desc). Use this for questions about recent sales, revenue, or what a specific buyer purchased. The optional status filter accepts Mercado Livre order statuses such as 'confirmed', 'payment_required', 'payment_in_process', 'paid', 'shipped', 'delivered' and 'cancelled'. Each order includes id, creation date (ISO 8601), status, total amount, currency, buyer nickname, and line items with item id, title, quantity and unit price. Paginated via limit/offset. Requires authentication.",
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Max orders to return, 1-50 (default 10)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Pagination offset"),
      status: z
        .string()
        .optional()
        .describe(
          "Order status filter, e.g. 'paid', 'confirmed', 'shipped', 'delivered', 'cancelled'. Omit to list all"
        ),
    },
  },
  async ({ limit, offset, status }) => {
    try {
      const sellerId = await getMyUserId();
      const data = await meliGet<{
        results?: Array<Record<string, unknown>>;
        paging?: { total?: number };
      }>("/orders/search", {
        seller: sellerId,
        sort: "date_desc",
        limit,
        offset,
        "order.status": status,
      });
      const orders = (data.results ?? []).map((o) => {
        const buyer = (o.buyer ?? {}) as { nickname?: string };
        const orderItems = Array.isArray(o.order_items)
          ? (o.order_items as Array<Record<string, unknown>>).map((oi) => {
              const item = (oi.item ?? {}) as { id?: string; title?: string };
              return {
                id: item.id,
                title: item.title,
                quantity: oi.quantity,
                unit_price: oi.unit_price,
              };
            })
          : [];
        return {
          id: o.id,
          date_created: o.date_created,
          status: o.status,
          total_amount: o.total_amount,
          currency: o.currency_id,
          buyer_nickname: buyer.nickname ?? null,
          items: orderItems,
        };
      });
      return ok({ total: data.paging?.total ?? orders.length, orders });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Publicação (apoio à criação de anúncios)
// ---------------------------------------------------------------------------

registerTool(
  "predict_category",
  {
    description:
      "Predict the best Mercado Livre category for a product title. ALWAYS call this BEFORE create_item: create_item requires a category_id, and publishing in the wrong category hurts visibility and can be rejected. Pass the product title you intend to publish and pick the top prediction. After choosing a category, call get_category_attributes to discover which attributes are mandatory for that category. Returns a list of predicted categories with id, name and full path (e.g. 'Celulares e Telefones > Celulares e Smartphones').",
    inputSchema: {
      title: z
        .string()
        .describe("Product title to classify, e.g. 'iPhone 13 128GB Meia-noite'"),
    },
  },
  async ({ title }) => {
    try {
      const data = await meliGet<
        Array<{
          id?: string;
          name?: string;
          path_from_root?: Array<{ id?: string; name?: string }>;
          prediction_probability?: number;
        }>
      >(`/sites/${config.siteId}/category_predictor/predict`, { title });
      const predictions = (Array.isArray(data) ? data : []).map((p) => ({
        id: p.id,
        name: p.name,
        path_from_root: (p.path_from_root ?? []).map((n) => n.name),
        prediction_probability: p.prediction_probability,
      }));
      return ok({ predictions });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_category_attributes",
  {
    description:
      "Get the attributes defined for a Mercado Livre category. Call this AFTER picking a category with predict_category and BEFORE create_item, to learn which attributes are mandatory (required=true) and what values are allowed. Every attribute flagged as required MUST be included in create_item's attributes parameter or the publication will be rejected with a validation error. Returns id, name, value_type (string/number/boolean/list/...), required flag, and allowed values (id + name) when the attribute is a closed list.",
    inputSchema: {
      category_id: z
        .string()
        .describe("Category id returned by predict_category, e.g. 'MLB1055'"),
    },
  },
  async ({ category_id }) => {
    try {
      const data = await meliGet<Array<Record<string, unknown>>>(
        `/categories/${category_id}/attributes`
      );
      const attributes = (Array.isArray(data) ? data : []).map((a) => {
        const tags = a.tags;
        const required = Array.isArray(tags)
          ? tags.includes("required")
          : (tags as Record<string, unknown> | undefined)?.required === true;
        const values = Array.isArray(a.values)
          ? (a.values as Array<{ id?: string; name?: string }>)
              .slice(0, 50)
              .map((v) => ({ id: v.id, name: v.name }))
          : undefined;
        return {
          id: a.id,
          name: a.name,
          value_type: a.value_type,
          required,
          allowed_values: values,
        };
      });
      return ok({ category_id, attributes });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_listing_types",
  {
    description:
      "List the listing types (exposure plans) available on the configured site, e.g. 'gold_special' (Clássica) and 'gold_pro' (Premium). Each type has different fees and exposure; higher tiers usually charge more commission but boost visibility. Call this (optionally together with get_listing_prices) before create_item to choose the listing_type_id. Returns ids and names.",
    inputSchema: {},
  },
  async () => {
    try {
      const data = await meliGet<Array<{ id?: string; name?: string }>>(
        `/sites/${config.siteId}/listing_types`
      );
      const listing_types = (Array.isArray(data) ? data : []).map((t) => ({
        id: t.id,
        name: t.name,
      }));
      return ok({ listing_types });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_listing_prices",
  {
    description:
      "Estimate the selling fees for publishing an item at a given price, optionally for a specific category and listing type. Use this BEFORE create_item so the seller knows the commission cost of each exposure plan (Clássica vs Premium) before committing. Returns one entry per listing type with the sale fee percentage, fee amount and related flags for the given price.",
    inputSchema: {
      price: z
        .number()
        .describe("Intended sale price in the site currency (e.g. BRL for MLB)"),
      category_id: z
        .string()
        .optional()
        .describe("Category id (from predict_category) for a category-accurate fee"),
      listing_type_id: z
        .string()
        .optional()
        .describe("Listing type id (from get_listing_types), e.g. 'gold_special'. Omit to get fees for all types"),
    },
  },
  async ({ price, category_id, listing_type_id }) => {
    try {
      const data = await meliGet<Array<Record<string, unknown>>>(
        `/sites/${config.siteId}/listing_prices`,
        { price, category_id, listing_type_id }
      );
      const options = (Array.isArray(data) ? data : []).map((o) => {
        const fee = (o.sale_fee_details ?? {}) as Record<string, unknown>;
        return {
          listing_type_id: o.listing_type_id,
          listing_type_name: o.listing_type_name,
          listing_exposure: o.listing_exposure,
          sale_fee_percentage: fee.percentage,
          sale_fee_amount: fee.gross_amount,
          free_relist: fee.free_relist,
          stop_time: o.stop_time,
        };
      });
      return ok({ price, options });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Gestão de anúncios (escrita)
// ---------------------------------------------------------------------------

registerTool(
  "create_item",
  {
    description:
      "Create and PUBLISH a new listing on Mercado Livre — this is a real write operation: the item becomes public (immediately or per account settings) and selling fees apply once it sells. Confirm the details with the user before calling. Recommended flow: (1) predict_category with the title to get category_id; (2) get_category_attributes on that category and fill every attribute marked required via the attributes parameter; (3) optionally get_listing_types/get_listing_prices to choose the listing type and estimate fees; (4) call create_item. The title is limited to 60 characters. If Meli rejects the payload with a validation error, the full error body is returned — read it, fix the offending fields (usually missing required attributes) and retry. Returns the created item id, status and permalink.",
    inputSchema: {
      title: z
        .string()
        .max(60)
        .describe("Listing title, max 60 characters"),
      category_id: z
        .string()
        .describe("Category id from predict_category, e.g. 'MLB1055'"),
      price: z.number().positive().describe("Sale price in currency_id"),
      available_quantity: z
        .number()
        .int()
        .min(1)
        .describe("Stock quantity available for sale"),
      condition: z
        .enum(["new", "used"])
        .optional()
        .default("new")
        .describe("Item condition: 'new' or 'used' (default 'new')"),
      listing_type_id: z
        .string()
        .optional()
        .default("gold_special")
        .describe("Exposure plan id from get_listing_types, e.g. 'gold_special' (Clássica, default) or 'gold_pro' (Premium)"),
      buying_mode: z
        .string()
        .optional()
        .default("buy_it_now")
        .describe("Buying mode; keep 'buy_it_now' unless the user explicitly wants auction"),
      currency_id: z
        .string()
        .optional()
        .describe("ISO currency of the price. Defaults to the site currency (BRL for MLB)"),
      description: z
        .string()
        .optional()
        .describe("Plain-text listing description"),
      pictures: z
        .array(z.string())
        .optional()
        .describe("Image URLs; Meli downloads them (pictures[].source). For local files, upload first with upload_picture"),
      attributes: z
        .array(
          z.object({
            id: z.string().describe("Attribute id, e.g. 'BRAND'"),
            value_name: z
              .string()
              .describe("Attribute value as text, e.g. 'Apple'"),
          })
        )
        .optional()
        .describe("Item attributes; MUST include all attributes marked required by get_category_attributes"),
      video_id: z
        .string()
        .optional()
        .describe("Id of a video previously uploaded to the seller's account"),
      shipping: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Shipping options object, e.g. {free_shipping: true, mode: 'me2'}"),
    },
  },
  async (input) => {
    try {
      const body: Record<string, unknown> = {
        title: input.title,
        category_id: input.category_id,
        price: input.price,
        available_quantity: input.available_quantity,
        condition: input.condition,
        listing_type_id: input.listing_type_id,
        buying_mode: input.buying_mode,
        currency_id:
          input.currency_id ?? SITE_CURRENCY[config.siteId] ?? "BRL",
      };
      if (input.description !== undefined) {
        body.description = { plain_text: input.description };
      }
      if (input.pictures !== undefined) {
        body.pictures = input.pictures.map((url) => ({ source: url }));
      }
      if (input.attributes !== undefined) body.attributes = input.attributes;
      if (input.video_id !== undefined) body.video_id = input.video_id;
      if (input.shipping !== undefined) body.shipping = input.shipping;

      const created = await meliPost<Record<string, unknown>>("/items", body);
      return ok({
        id: created.id,
        title: created.title,
        status: created.status,
        permalink: created.permalink,
        warnings: created.warnings ?? [],
      });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "update_item",
  {
    description:
      "Update mutable fields of an existing listing owned by the authenticated seller: price, stock (available_quantity), title or video. Use this for price changes and stock adjustments; to change visibility (pause/activate/close) use update_item_status instead. Only the provided fields are sent. Gotcha: the title can only be changed while the item has no sales — once units are sold, Meli rejects title updates. Returns the updated item id, price, available_quantity and status.",
    inputSchema: {
      item_id: z
        .string()
        .describe("Full item id with site prefix, e.g. 'MLB123456789'"),
      price: z.number().positive().optional().describe("New sale price"),
      available_quantity: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("New stock quantity"),
      title: z
        .string()
        .max(60)
        .optional()
        .describe("New title (max 60 chars); only allowed while the item has no sales"),
      video_id: z
        .string()
        .optional()
        .describe("Id of a video previously uploaded to the seller's account"),
    },
  },
  async ({ item_id, price, available_quantity, title, video_id }) => {
    try {
      const body: Record<string, unknown> = {};
      if (price !== undefined) body.price = price;
      if (available_quantity !== undefined)
        body.available_quantity = available_quantity;
      if (title !== undefined) body.title = title;
      if (video_id !== undefined) body.video_id = video_id;
      if (Object.keys(body).length === 0) {
        return fail(new Error("Provide at least one field to update."));
      }
      const updated = await meliPut<Record<string, unknown>>(
        `/items/${item_id}`,
        body
      );
      return ok({
        id: updated.id,
        title: updated.title,
        price: updated.price,
        available_quantity: updated.available_quantity,
        status: updated.status,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "update_item_status",
  {
    description:
      "Change the visibility status of a listing: 'pause' temporarily hides it (reversible), 'activate' re-publishes a paused item, and 'close' finishes the listing. WARNING: closing is effectively irreversible for items that had sales — a closed item cannot be reactivated; a new listing would have to be created. Because of that, action='close' is refused unless confirm=true is passed explicitly. Always confirm with the user before closing. Paused items keep their history and can be reactivated at any time with 'activate'. Returns the item id and its new status.",
    inputSchema: {
      item_id: z
        .string()
        .describe("Full item id with site prefix, e.g. 'MLB123456789'"),
      action: z
        .enum(["pause", "activate", "close"])
        .describe(
          "Action to apply: 'pause' (hide, reversible), 'activate' (re-publish a paused item), 'close' (finish; irreversible when the item has sales)"
        ),
      confirm: z
        .boolean()
        .optional()
        .describe(
          "Required for action='close': must be exactly true to confirm the irreversible closing. Ignored for pause/activate"
        ),
    },
  },
  async ({ item_id, action, confirm }) => {
    try {
      if (action === "close" && confirm !== true) {
        return fail(
          new Error(
            "Closing an item is irreversible. Call again with confirm: true to proceed."
          )
        );
      }
      const statusMap = { pause: "paused", activate: "active", close: "closed" } as const;
      const updated = await meliPut<Record<string, unknown>>(
        `/items/${item_id}`,
        { status: statusMap[action] }
      );
      return ok({ id: updated.id ?? item_id, status: updated.status ?? statusMap[action] });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Perguntas (escrita)
// ---------------------------------------------------------------------------

registerTool(
  "answer_question",
  {
    description:
      "Post a public answer to a buyer's pre-sale question. The answer is visible to everyone viewing the listing and CANNOT be edited or deleted afterwards — confirm the exact text with the user before sending. Get the question_id from get_questions (typically with status='UNANSWERED'). Returns the answer id, text, status and creation date.",
    inputSchema: {
      question_id: z
        .number()
        .describe("Numeric question id from get_questions"),
      text: z
        .string()
        .describe("Answer text; public and irreversible once posted"),
    },
  },
  async ({ question_id, text }) => {
    try {
      const answer = await meliPost<Record<string, unknown>>("/answers", {
        question_id,
        text,
      });
      return ok({
        id: answer.id,
        question_id,
        text: answer.text,
        status: answer.status,
        date_created: answer.date_created,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "upload_picture",
  {
    description:
      "Upload a picture to the seller's Mercado Livre account and get back a picture id. Provide a public HTTPS image URL that Meli will download. Local file uploads are disabled. Use the returned id in create_item pictures. Returns the picture id, source URL and size variations.",
    inputSchema: {
      url: z
        .string()
        .url()
        .optional()
        .describe("Public URL of the image; Meli downloads it"),

    },
  },
  async ({ url }) => {
    try {
      if (!url) return fail(new Error("A public HTTPS image URL is required; local files are disabled"));
      const source = new URL(url);
      if (source.protocol !== "https:" || source.username || source.password) {
        return fail(new Error("Only HTTPS image URLs without credentials are permitted"));
      }
      const picture = await meliPost<Record<string, unknown>>("/pictures", { source: url });
      const variations = Array.isArray(picture.variations)
        ? (picture.variations as Array<Record<string, unknown>>).map((v) => ({
            size: v.size,
            url: v.url,
          }))
        : [];
      return ok({
        id: picture.id,
        source: picture.source ?? url,
        max_size: picture.max_size,
        variations,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Envios
// ---------------------------------------------------------------------------

registerTool(
  "get_shipment",
  {
    description:
      "Get the shipping details of a sale: status, substatus, tracking number, dates (ISO 8601), receiver address, shipped items and logistic type (e.g. 'me2', 'flex', 'self_service'). Shipment ids come from orders: each order returned by get_orders has a shipping id (order.shipping.id) — if you only have an order id, call get_orders first to find the shipment id. Status values include 'pending', 'ready_to_ship', 'shipped', 'delivered' and 'cancelled'. Use get_shipment_label to download the printable label for the shipment.",
    inputSchema: {
      shipment_id: z
        .number()
        .describe("Numeric shipment id, taken from an order's shipping.id"),
    },
  },
  async ({ shipment_id }) => {
    try {
      const s = await meliGet<Record<string, unknown>>(
        `/shipments/${shipment_id}`
      );
      const address = (s.receiver_address ?? {}) as Record<string, unknown>;
      const city = (address.city ?? {}) as { name?: string };
      const state = (address.state ?? {}) as { name?: string };
      const items = Array.isArray(s.shipping_items)
        ? (s.shipping_items as Array<Record<string, unknown>>).map((i) => ({
            id: i.id,
            title: i.description,
            quantity: i.quantity,
          }))
        : [];
      return ok({
        id: s.id,
        status: s.status,
        substatus: s.substatus,
        logistic_type: s.logistic_type,
        tracking_number: s.tracking_number,
        tracking_method: s.tracking_method,
        date_created: s.date_created,
        date_shipped: s.date_shipped,
        date_delivered: s.date_delivered,
        receiver_address: {
          receiver_name: address.receiver_name,
          address_line: address.address_line,
          city: city.name ?? address.city,
          state: state.name ?? address.state,
          zip_code: address.zip_code,
        },
        items,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_shipment_label",
  {
    description:
      "Download the Mercado Envios shipping label for a shipment and save it to a local file. Returns the absolute file path and size in bytes so the user can open/print it. The label comes back as PDF (default) or ZPL2 for thermal printers. Gotchas: the label only exists after the shipment is 'ready_to_ship', and some logistic types (e.g. flex / self-service) do not have a printable label — in those cases Meli returns an error, which is surfaced as-is. Shipment ids come from orders (order.shipping.id); call get_orders first if you only have an order id.",
    inputSchema: {
      shipment_id: z
        .number()
        .describe("Numeric shipment id, taken from an order's shipping.id"),
      response_type: z
        .enum(["pdf", "zpl2"])
        .optional()
        .default("pdf")
        .describe("Label format: 'pdf' (default) or 'zpl2' for Zebra thermal printers"),
    },
  },
  async ({ shipment_id, response_type }) => {
    try {
      const { contentType, data } = await meliGetRaw(
        "/shipment_labels",
        { shipment_ids: shipment_id, response_type },
        "application/pdf"
      );
      const ext = response_type === "zpl2" ? "zpl" : "pdf";
      const labelsDir = path.join(path.dirname(config.tokensFile), "labels");
      await mkdir(labelsDir, { recursive: true });
      const filePath = path.join(labelsDir, `label_${shipment_id}.${ext}`);
      await writeFile(filePath, data, { mode: 0o600 });
      return ok({
        file_path: filePath,
        size_bytes: data.length,
        content_type: contentType,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Mensagens (pós-venda)
// ---------------------------------------------------------------------------

registerTool(
  "get_order_messages",
  {
    description:
      "Read the post-sale message conversation with the buyer of a specific order. Use this to see what the buyer asked after the purchase (delivery questions, invoice requests, etc.). The pack id in the messaging API equals the order id. Returns each message with sender/recipient (user id + role, e.g. 'buyer'/'seller'), text, date (ISO 8601) and whether it was read. To reply, use send_message with the same order id.",
    inputSchema: {
      order_id: z
        .number()
        .describe("Numeric order id from get_orders"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(20)
        .describe("Max messages to return, 1-50 (default 20)"),
    },
  },
  async ({ order_id, limit }) => {
    try {
      const sellerId = await getMyUserId();
      const data = await meliGet<{
        paging?: { total?: number };
        messages?: Array<Record<string, unknown>>;
      }>(`/messages/packs/${order_id}/sellers/${sellerId}`, { limit });
      const messages = (data.messages ?? []).map((m) => {
        const to = m.to as
          | { user_id?: number; role?: string }
          | Array<{ user_id?: number; role?: string }>
          | undefined;
        return {
          id: m.id,
          from: m.from,
          to,
          text: m.text,
          date: m.date,
          read: Boolean(m.date_read ?? m.read),
        };
      });
      return ok({ total: data.paging?.total ?? messages.length, messages });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "send_message",
  {
    description:
      "Send a post-sale message to the buyer of a specific order — this is a REAL message delivered to the buyer, so confirm the exact text with the user before sending. Only for post-sale communication tied to an order. Important Mercado Livre moderation rules: messages are moderated and must NOT contain contact information — no links, phone numbers, e-mails or social media handles; violations can lead to sanctions on the seller's account, up to suspension. Text is limited to 350 characters. Use get_order_messages first to read the conversation context. Returns the sent message id, moderation status and date.",
    inputSchema: {
      order_id: z
        .number()
        .describe("Numeric order id from get_orders"),
      text: z
        .string()
        .max(350)
        .describe("Message text, max 350 characters; no links, phone numbers or e-mails (moderated)"),
    },
  },
  async ({ order_id, text }) => {
    try {
      if (containsContactInfo(text)) {
        return fail(new Error(CONTACT_INFO_MESSAGE));
      }
      const sellerId = await getMyUserId();
      const order = await meliGet<{ buyer?: { id?: number } }>(
        `/orders/${order_id}`
      );
      const buyerId = order.buyer?.id;
      if (!buyerId) {
        return fail(
          new Error(`Could not find the buyer of order ${order_id}.`)
        );
      }
      const sent = await meliPost<Record<string, unknown>>(
        `/messages/packs/${order_id}/sellers/${sellerId}`,
        { from: { user_id: sellerId }, to: { user_id: buyerId }, text }
      );
      return ok({
        id: sent.id,
        order_id,
        status: sent.status,
        moderation_status: sent.moderation_status,
        date: sent.date,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Reclamações & Devoluções
// ---------------------------------------------------------------------------

registerTool(
  "get_claims",
  {
    description:
      "Search the authenticated seller's claims (reclamações) — buyer complaints opened against sales. Open claims hurt seller reputation and have response deadlines, so use this to find claims needing attention (e.g. status 'opened'). Optional status filter and date range (ISO 8601); results are paginated with limit/offset. Returns a compact list with claim id, type (e.g. 'claim', 'return'), status, stage (e.g. 'claim', 'mediation'), resource_id (the related order id), reason id and creation date. Call get_claim_detail on a claim id for the full picture.",
    inputSchema: {
      status: z
        .string()
        .optional()
        .describe("Claim status filter, e.g. 'opened', 'closed'. Omit to list all"),
      date_from: z
        .string()
        .optional()
        .describe("Only claims created on/after this date (ISO 8601, e.g. '2026-01-01T00:00:00.000-03:00')"),
      date_to: z
        .string()
        .optional()
        .describe("Only claims created on/before this date (ISO 8601)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Max claims to return, 1-50 (default 10)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Pagination offset"),
    },
  },
  async ({ status, date_from, date_to, limit, offset }) => {
    try {
      const sellerId = await getMyUserId();
      const data = await meliGet<{
        paging?: { total?: number };
        data?: Array<Record<string, unknown>>;
        results?: Array<Record<string, unknown>>;
      }>("/post-purchase/claims/search", {
        seller_id: sellerId,
        status,
        "date_created.from": date_from,
        "date_created.to": date_to,
        limit,
        offset,
      });
      const raw = data.data ?? data.results ?? [];
      const claims = raw.map((c) => ({
        id: c.id,
        type: c.type,
        status: c.status,
        stage: c.stage,
        resource_id: c.resource_id,
        reason_id: c.reason_id,
        date_created: c.date_created,
      }));
      return ok({ total: data.paging?.total ?? claims.length, claims });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_claim_detail",
  {
    description:
      "Get the full details of a single claim (reclamação), including its type, status, stage, reason, related order id, the parties involved (complainant = buyer, respondent = seller), the resolution when the claim is closed, and the recent messages in the claim thread. Use this after get_claims to understand a specific claim before replying with send_claim_message. If the messages endpoint is unavailable, messages are simply omitted — the rest of the detail is still returned.",
    inputSchema: {
      claim_id: z
        .number()
        .describe("Numeric claim id from get_claims"),
    },
  },
  async ({ claim_id }) => {
    try {
      const c = await meliGet<Record<string, unknown>>(
        `/post-purchase/claims/${claim_id}`
      );
      const players = Array.isArray(c.players)
        ? (c.players as Array<Record<string, unknown>>).map((p) => ({
            role: p.role,
            user_id: p.user_id,
            type: p.type,
          }))
        : [];
      const resolution = (c.resolution ?? null) as Record<string, unknown> | null;

      let messages: Array<Record<string, unknown>> | undefined;
      try {
        const raw = await meliGet<unknown>(
          `/post-purchase/claims/${claim_id}/messages`
        );
        const list = Array.isArray(raw)
          ? raw
          : ((raw as { data?: Array<Record<string, unknown>> }).data ?? []);
        messages = (list as Array<Record<string, unknown>>).map((m) => ({
          from: m.sender_role,
          text: m.message,
          date: m.date_created,
        }));
      } catch {
        messages = undefined;
      }

      return ok({
        id: c.id,
        type: c.type,
        status: c.status,
        stage: c.stage,
        reason_id: c.reason_id,
        resource_id: c.resource_id,
        players,
        resolution,
        date_created: c.date_created,
        last_updated: c.last_updated,
        ...(messages !== undefined ? { messages } : {}),
      });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "send_claim_message",
  {
    description:
      "Send a message inside a claim (reclamação) thread as the seller. This is a REAL message visible to the buyer AND to Mercado Livre's mediation team — it becomes part of the claim record, so confirm the exact text with the user before sending. The same moderation rules as buyer messaging apply: no contact information, links, phone numbers or e-mails, under risk of sanctions. Use get_claim_detail first to read the thread context. Returns the created message id and date.",
    inputSchema: {
      claim_id: z
        .number()
        .describe("Numeric claim id from get_claims"),
      text: z
        .string()
        .describe("Message text; visible to buyer and Meli mediation, no contact info or links"),
    },
  },
  async ({ claim_id, text }) => {
    try {
      if (containsContactInfo(text)) {
        return fail(new Error(CONTACT_INFO_MESSAGE));
      }
      const sent = await meliPost<Record<string, unknown>>(
        `/post-purchase/claims/${claim_id}/messages`,
        { sender_role: "respondent", message: text }
      );
      return ok({
        id: sent.id,
        claim_id,
        date_created: sent.date_created,
        status: sent.status,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_returns",
  {
    description:
      "List the authenticated seller's product returns (devoluções) — items buyers sent back, usually linked to a claim. Use this to track return requests and their statuses; call get_claim_detail on the linked claim id for the full context and message thread. Returns a compact list with return id, claim id, order id, status and creation date, paginated with limit/offset. Accounts without returns may yield an API error — it is surfaced gracefully instead of crashing.",
    inputSchema: {
      status: z
        .string()
        .optional()
        .describe("Return status filter, e.g. 'opened', 'closed'. Omit to list all"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Max returns to return, 1-50 (default 10)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Pagination offset"),
    },
  },
  async ({ status, limit, offset }) => {
    try {
      const sellerId = await getMyUserId();
      const data = await meliGet<{
        paging?: { total?: number };
        data?: Array<Record<string, unknown>>;
        results?: Array<Record<string, unknown>>;
      }>("/post-purchase/returns/search", {
        seller_id: sellerId,
        status,
        limit,
        offset,
      });
      const raw = data.data ?? data.results ?? [];
      const returns = raw.map((r) => ({
        id: r.id,
        claim_id: r.claim_id,
        order_id: r.order_id,
        status: r.status,
        date_created: r.date_created,
      }));
      return ok({ total: data.paging?.total ?? returns.length, returns });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Reputação & Métricas
// ---------------------------------------------------------------------------

registerTool(
  "get_seller_reputation",
  {
    description:
      "Get a seller's reputation profile on Mercado Livre — the authenticated account by default, or any seller by user_id (public data). Use this to check the seller's reputation thermometer and service metrics. The level_id is Meli's color scale: red (1_red) is worst, then orange/yellow/light_green, up to green (5_green) — plus Mercado Líder tiers in power_seller_status (e.g. 'silver', 'gold', 'platinum') for top sellers. Metrics include the rates of claims, delayed handling time and cancellations over the last period; keeping these low is what maintains a green reputation. Returns nickname, registration date, transaction totals (total/completed/canceled) and each metric with its rate and value.",
    inputSchema: {
      user_id: z
        .number()
        .optional()
        .describe("Seller user id; omit to check the authenticated account"),
    },
  },
  async ({ user_id }) => {
    try {
      const id = user_id ?? (await getMyUserId());
      const user = await meliGet<Record<string, unknown>>(`/users/${id}`);
      const rep = (user.seller_reputation ?? {}) as Record<string, unknown>;
      const transactions = (rep.transactions ?? {}) as Record<string, unknown>;
      const metrics = (rep.metrics ?? {}) as Record<string, unknown>;
      const pickMetric = (key: string) => {
        const m = (metrics[key] ?? {}) as Record<string, unknown>;
        return { rate: m.rate, value: m.value, period: m.period };
      };
      return ok({
        user_id: user.id,
        nickname: user.nickname,
        registration_date: user.registration_date,
        level_id: rep.level_id,
        power_seller_status: rep.power_seller_status,
        transactions: {
          total: transactions.total,
          completed: transactions.completed,
          canceled: transactions.canceled,
          period: transactions.period,
        },
        metrics: {
          claims: pickMetric("claims"),
          delayed_handling_time: pickMetric("delayed_handling_time"),
          cancellations: pickMetric("cancellations"),
        },
      });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_item_visits",
  {
    description:
      "Get the number of page visits per listing in a date range (defaults to the last 30 days when no dates are given). Use this to measure listing traffic — a powerful combo is get_my_items + get_item_visits to find listings with many views but few or no sales (a sign the price, pictures or listing type may need work). Accepts up to 50 item ids at once; returns one entry per item id with the total visits in the range.",
    inputSchema: {
      item_ids: z
        .array(z.string())
        .min(1)
        .max(50)
        .describe("Item ids (with site prefix, e.g. 'MLB123456789'), max 50"),
      date_from: z
        .string()
        .optional()
        .describe("Start of the range, YYYY-MM-DD. Defaults to 30 days ago"),
      date_to: z
        .string()
        .optional()
        .describe("End of the range, YYYY-MM-DD. Defaults to today"),
    },
  },
  async ({ item_ids, date_from, date_to }) => {
    try {
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      const to = date_to ?? fmt(new Date());
      const from =
        date_from ?? fmt(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000));
      const data = await meliGet<unknown>("/items/visits", {
        ids: item_ids.join(","),
        date_from: from,
        date_to: to,
      });
      // Meli may answer an array of {itemId: visits} objects or a plain map
      let visitsMap: Record<string, number> = {};
      if (Array.isArray(data)) {
        for (const entry of data) {
          if (entry && typeof entry === "object") {
            visitsMap = { ...visitsMap, ...(entry as Record<string, number>) };
          }
        }
      } else if (data && typeof data === "object") {
        visitsMap = data as Record<string, number>;
      }
      const visits = item_ids.map((id) => ({
        item_id: id,
        visits: visitsMap[id] ?? 0,
      }));
      return ok({ date_from: from, date_to: to, visits });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------

registerTool(
  "search_catalog",
  {
    description:
      "Search Mercado Livre's product catalog. Catalog products are shared listings where multiple sellers compete for the buy box on price and reputation — opt-ing into catalog can bring much more traffic than a standalone listing. Use this to find the catalog_product_id for a product you sell, then inspect it with get_catalog_product and link your listing with create_catalog_listing. Returns a compact list with product id, name, thumbnail and main attributes, paginated with limit/offset.",
    inputSchema: {
      query: z
        .string()
        .describe("Product search text, e.g. 'iPhone 13 128GB'"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Max results per page, 1-50 (default 10)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Pagination offset"),
    },
  },
  async ({ query, limit, offset }) => {
    try {
      const data = await meliGet<{
        results?: Array<Record<string, unknown>>;
        paging?: { total?: number };
      }>("/products/search", {
        site_id: config.siteId,
        q: query,
        limit,
        offset,
      });
      const products = (data.results ?? []).map((p) => {
        const attributes = Array.isArray(p.attributes)
          ? (p.attributes as Array<Record<string, unknown>>)
              .slice(0, 10)
              .map((a) => ({ id: a.id, name: a.name, value: a.value_name }))
          : [];
        return {
          id: p.id,
          name: p.name,
          thumbnail: p.thumbnail,
          attributes,
        };
      });
      return ok({ total: data.paging?.total ?? products.length, products });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_catalog_product",
  {
    description:
      "Get full details of a catalog product, including who is currently winning the buy box (buy_box_winner: price and seller id). Use this after search_catalog to study the competition before linking your listing with create_catalog_listing — the winner's price is the reference your listing must beat (along with reputation and shipping) to take the buy box. Returns name, attributes, picture URLs, main features and the buy box winner when present.",
    inputSchema: {
      product_id: z
        .string()
        .describe("Catalog product id from search_catalog, e.g. 'MLB15171222'"),
    },
  },
  async ({ product_id }) => {
    try {
      const p = await meliGet<Record<string, unknown>>(
        `/products/${product_id}`
      );
      const attributes = Array.isArray(p.attributes)
        ? (p.attributes as Array<Record<string, unknown>>).map((a) => ({
            id: a.id,
            name: a.name,
            value: a.value_name,
          }))
        : [];
      const pictures = Array.isArray(p.pictures)
        ? (p.pictures as Array<{ url?: string }>).map((pic) => pic.url)
        : [];
      const winner = (p.buy_box_winner ?? null) as Record<
        string,
        unknown
      > | null;
      const features = Array.isArray(p.main_features)
        ? (p.main_features as Array<Record<string, unknown>>).map(
            (f) => f.text
          )
        : [];
      return ok({
        id: p.id,
        name: p.name,
        attributes,
        pictures,
        main_features: features,
        buy_box_winner: winner
          ? {
              item_id: winner.item_id,
              seller_id: winner.seller_id,
              price: winner.price,
              currency: winner.currency_id,
            }
          : null,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "create_catalog_listing",
  {
    description:
      "Opt one of your EXISTING listings into catalog competition by linking it to a catalog product — this is a real write operation. The listing keeps its identity but starts competing for the buy box under catalog rules: display and sales conditions change (e.g. free-shipping and price rules may differ from a standalone listing). Confirm with the user before calling. Flow: search_catalog → get_catalog_product (check the winner's price) → create_catalog_listing. The item must belong to the authenticated seller and match the catalog product. Returns the linked item id, status and permalink.",
    inputSchema: {
      item_id: z
        .string()
        .describe("Your existing item id (with site prefix), e.g. 'MLB123456789'"),
      catalog_product_id: z
        .string()
        .describe("Catalog product id from search_catalog, e.g. 'MLB15171222'"),
    },
  },
  async ({ item_id, catalog_product_id }) => {
    try {
      const linked = await meliPost<Record<string, unknown>>(
        "/items/catalog_listings",
        { item_id, catalog_id: catalog_product_id }
      );
      return ok({
        id: linked.id ?? item_id,
        catalog_product_id: linked.catalog_product_id ?? catalog_product_id,
        status: linked.status,
        permalink: linked.permalink,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Preço e mercado
// ---------------------------------------------------------------------------

registerTool(
  "get_price_suggestion",
  {
    description:
      "Get Mercado Livre's competitive price suggestion for one of your listings — the price Meli estimates would make the listing more competitive, based on comparable sales. Use it when the user asks whether a listing is priced right or wants to undercut the competition. Gotcha: not every listing has a suggestion (insufficient data); in that case the endpoint returns partial data and whatever comes back is surfaced as-is. Returns current price, suggested price and the basis of the suggestion when present.",
    inputSchema: {
      item_id: z
        .string()
        .describe("Item id with site prefix, e.g. 'MLB123456789'"),
    },
  },
  async ({ item_id }) => {
    try {
      const data = await meliGet<Record<string, unknown>>(
        `/suggestions/items/${item_id}/details`
      );
      return ok({
        item_id,
        current_price: data.current_price ?? null,
        suggested_price: data.suggested_price ?? null,
        basis: data.basis ?? null,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_trends",
  {
    description:
      "Get the trending search terms on the marketplace (top searches buyers are making right now). Great for product research and demand discovery; pass a category_id to see niche trends within a specific category (find ids with get_site_categories or predict_category). Returns keyword + URL for each trend, trimmed to the requested limit.",
    inputSchema: {
      category_id: z
        .string()
        .optional()
        .describe("Restrict trends to a category id, e.g. 'MLB1055'. Omit for site-wide top searches"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(20)
        .describe("Max trends to return, 1-50 (default 20)"),
    },
  },
  async ({ category_id, limit }) => {
    try {
      const path = category_id
        ? `/trends/${config.siteId}/${category_id}`
        : `/trends/${config.siteId}`;
      const data = await meliGet<unknown>(path);
      const list = Array.isArray(data)
        ? data
        : ((data as { results?: Array<Record<string, unknown>> }).results ??
          []);
      const trends = (list as Array<Record<string, unknown>>)
        .slice(0, limit)
        .map((t) => ({ keyword: t.keyword, url: t.url }));
      return ok({ site: config.siteId, category_id: category_id ?? null, trends });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "convert_currency",
  {
    description:
      "Get the current Mercado Livre exchange rate between two currencies (e.g. USD → BRL). Useful for cross-border pricing or comparing prices across Meli sites. Returns the conversion ratio and both currency codes.",
    inputSchema: {
      from: z
        .string()
        .describe("Source currency ISO code, e.g. 'USD'"),
      to: z
        .string()
        .describe("Target currency ISO code, e.g. 'BRL'"),
    },
  },
  async ({ from, to }) => {
    try {
      const data = await meliGet<Record<string, unknown>>(
        "/currency_conversions/search",
        { from, to }
      );
      return ok({
        from: data.currency_from ?? from,
        to: data.currency_to ?? to,
        ratio: data.ratio,
        mercado_pago_ratio: data.mercado_pago_ratio ?? null,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Categorias (navegação pela árvore)
// ---------------------------------------------------------------------------

registerTool(
  "get_site_categories",
  {
    description:
      "List the top-level categories of the configured site (MLB by default). This is the entry point for browsing the category tree: pick a category here, then drill down with get_category to reach a leaf category usable in create_item. For a title-driven shortcut to the right leaf category, predict_category is usually faster. Returns a list of {id, name}.",
    inputSchema: {},
  },
  async () => {
    try {
      const data = await meliGet<Array<{ id?: string; name?: string }>>(
        `/sites/${config.siteId}/categories`
      );
      const categories = (Array.isArray(data) ? data : []).map((c) => ({
        id: c.id,
        name: c.name,
      }));
      return ok({ site: config.siteId, categories });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_category",
  {
    description:
      "Get details of a category: its name, full path from the root, child categories (to keep drilling down the tree) and the listing settings that apply to it — including constraints relevant BEFORE create_item such as max pictures per item and max description length. A category with no children is a leaf and can be used as category_id in create_item; then call get_category_attributes for its mandatory attributes.",
    inputSchema: {
      category_id: z
        .string()
        .describe("Category id, e.g. 'MLB1055' (from get_site_categories or predict_category)"),
    },
  },
  async ({ category_id }) => {
    try {
      const c = await meliGet<Record<string, unknown>>(
        `/categories/${category_id}`
      );
      const settings = (c.settings ?? {}) as Record<string, unknown>;
      return ok({
        id: c.id,
        name: c.name,
        path_from_root: Array.isArray(c.path_from_root)
          ? (c.path_from_root as Array<Record<string, unknown>>).map((n) => ({
              id: n.id,
              name: n.name,
            }))
          : [],
        children_categories: Array.isArray(c.children_categories)
          ? (c.children_categories as Array<Record<string, unknown>>).map(
              (n) => ({ id: n.id, name: n.name })
            )
          : [],
        total_items_in_this_category: c.total_items_in_this_category,
        settings: {
          max_pictures_per_item: settings.max_pictures_per_item,
          max_description_length: settings.max_description_length,
          max_title_length: settings.max_title_length,
          vip_subdomain: settings.vip_subdomain,
          adult_content: settings.adult_content,
          buying_allowed: settings.buying_allowed,
        },
      });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Perguntas — blacklist
// ---------------------------------------------------------------------------

registerTool(
  "manage_question_blacklist",
  {
    description:
      "Manage the seller's questions blacklist. 'list' shows the blocked users; 'block' prevents a user from asking questions on your listings; 'unblock' reverses it. Use 'block' only for abusive users — note this ONLY blocks new questions from that user; they can still buy from you, and blocking/unblocking is a real change to the account, so confirm with the user first. Get user ids from buyers' questions (get_questions) or orders.",
    inputSchema: {
      action: z
        .enum(["list", "block", "unblock"])
        .describe("What to do: 'list' (read-only), 'block' or 'unblock' a user"),
      user_id: z
        .number()
        .optional()
        .describe("User id to block/unblock (required for those actions; ignored for 'list')"),
    },
  },
  async ({ action, user_id }) => {
    try {
      if (safety.readOnly && action !== "list") {
        return fail(
          new Error(
            `Read-only mode (ML_READ_ONLY=true): action '${action}' is not allowed; only 'list' is available.`
          )
        );
      }
      const sellerId = await getMyUserId();
      if (action === "list") {
        const data = await meliGet<Record<string, unknown>>(
          `/users/${sellerId}/questions_blacklist`
        );
        const users = Array.isArray(data.users)
          ? (data.users as Array<Record<string, unknown>>).map((u) => ({
              id: u.id,
              nickname: u.nickname,
            }))
          : [];
        return ok({ blocked_users: users });
      }
      if (user_id === undefined) {
        return fail(
          new Error(`user_id is required for the '${action}' action.`)
        );
      }
      if (action === "block") {
        await meliPost<unknown>(
          `/users/${user_id}/questions_blacklist`,
          undefined,
          { seller_id: sellerId }
        );
        return ok({ action, user_id, blocked: true });
      }
      await meliDelete<unknown>(`/users/${user_id}/questions_blacklist`, {
        seller_id: sellerId,
      });
      return ok({ action, user_id, blocked: false });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Promoções
// ---------------------------------------------------------------------------

registerTool(
  "get_promotions",
  {
    description:
      "List the promotions/campaigns Mercado Livre offers to the authenticated seller (daily deals, lightning deals, etc.) — both campaigns you can join (status 'candidate') and ones already running ('started'). Use this to discover discount opportunities, then inspect participants with get_promotion_items or join with add_item_to_promotion. May legitimately return an empty list when there are no active campaigns for the account. Returns a compact list with id, type, status, title and start/finish dates, paginated with limit/offset.",
    inputSchema: {
      status: z
        .string()
        .optional()
        .describe("Promotion status filter, e.g. 'candidate' (can join) or 'started' (running). Omit to list all"),
      promotion_type: z
        .string()
        .optional()
        .describe("Promotion type filter, e.g. 'DEAL', 'LIGHTNING'. Omit to list all types"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Max promotions to return, 1-50 (default 10)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Pagination offset"),
    },
  },
  async ({ status, promotion_type, limit, offset }) => {
    try {
      const sellerId = await getMyUserId();
      const data = await meliGet<{
        paging?: { total?: number };
        results?: Array<Record<string, unknown>>;
      }>("/seller-promotions/promotions", {
        seller_id: sellerId,
        status,
        promotion_type,
        limit,
        offset,
      });
      const promotions = (data.results ?? []).map((p) => ({
        id: p.id,
        type: p.type,
        status: p.status,
        title: p.title ?? p.name,
        start_date: p.start_date,
        finish_date: p.finish_date,
      }));
      return ok({
        total: data.paging?.total ?? promotions.length,
        promotions,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_promotion_items",
  {
    description:
      "List the items already participating in a specific promotion campaign, with their promotional price, original price and status. Use this to check which of your items are in a campaign (and at what price) after adding them with add_item_to_promotion, or to audit active discounts. Get the promotion_id from get_promotions. Paginated with limit/offset.",
    inputSchema: {
      promotion_id: z
        .string()
        .describe("Promotion id from get_promotions"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(20)
        .describe("Max items to return, 1-50 (default 20)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Pagination offset"),
    },
  },
  async ({ promotion_id, limit, offset }) => {
    try {
      const sellerId = await getMyUserId();
      const data = await meliGet<{
        paging?: { total?: number };
        results?: Array<Record<string, unknown>>;
      }>(`/seller-promotions/promotions/${promotion_id}/items`, {
        seller_id: sellerId,
        limit,
        offset,
      });
      const items = (data.results ?? []).map((i) => ({
        item_id: i.item_id ?? i.id,
        price: i.price,
        original_price: i.original_price,
        status: i.status,
      }));
      return ok({ total: data.paging?.total ?? items.length, items });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "add_item_to_promotion",
  {
    description:
      "Submit one of your items to a promotion campaign with the offered deal price — this is a REAL write operation: if Meli approves, the item starts being sold at the promotional price for the campaign duration. Confirm the price with the user before calling. Flow: get_promotions (find a 'candidate' campaign) → add_item_to_promotion with the deal_price within the campaign's allowed range. Returns the submission result with item id and status.",
    inputSchema: {
      item_id: z
        .string()
        .describe("Your item id (with site prefix), e.g. 'MLB123456789'"),
      promotion_id: z
        .string()
        .describe("Promotion id from get_promotions"),
      deal_price: z
        .number()
        .positive()
        .describe("Promotional price offered for the item during the campaign"),
      top_deal_price: z
        .number()
        .positive()
        .optional()
        .describe("Optional lower price for extra exposure within the campaign (top deal)"),
    },
  },
  async ({ item_id, promotion_id, deal_price, top_deal_price }) => {
    try {
      const sellerId = await getMyUserId();
      const body: Record<string, unknown> = { promotion_id, deal_price };
      if (top_deal_price !== undefined) body.top_deal_price = top_deal_price;
      const result = await meliPost<Record<string, unknown>>(
        `/seller-promotions/items/${item_id}`,
        body,
        { seller_id: sellerId }
      );
      return ok({
        item_id: result.item_id ?? item_id,
        promotion_id,
        price: result.price ?? deal_price,
        status: result.status,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Mercado Ads (Product Ads)
// ---------------------------------------------------------------------------

registerTool(
  "get_ads_campaigns",
  {
    description:
      "List the seller's Mercado Ads (Product Ads) campaigns. Use this for advertising questions: which campaigns exist, their status, daily budget and bidding strategy. Gotcha: this requires the advertising scope granted to the app and an active ads account — if either is missing, Meli answers with a scope/permission error, which is surfaced clearly so you know the feature isn't available. Get campaign ids here, then check performance with get_ads_campaign_metrics. Returns a compact list with campaign id, name, status, budget and strategy.",
    inputSchema: {
      status: z
        .string()
        .optional()
        .describe("Campaign status filter, e.g. 'active', 'paused'. Omit to list all"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(20)
        .describe("Max campaigns to return, 1-50 (default 20)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Pagination offset"),
    },
  },
  async ({ status, limit, offset }) => {
    try {
      const sellerId = await getMyUserId();
      const data = await meliGet<{
        paging?: { total?: number };
        results?: Array<Record<string, unknown>>;
      }>("/advertising/product_ads/campaigns", {
        user_id: sellerId,
        status,
        limit,
        offset,
      });
      const campaigns = (data.results ?? []).map((c) => ({
        id: c.id,
        name: c.name ?? c.title,
        status: c.status,
        budget: c.budget ?? c.daily_budget,
        strategy: c.strategy ?? c.bidding_strategy,
      }));
      return ok({
        total: data.paging?.total ?? campaigns.length,
        campaigns,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_ads_campaign_metrics",
  {
    description:
      "Get performance metrics of a Mercado Ads campaign over a date range (defaults to the last 30 days): impressions, clicks, CTR, cost, attributed sales and ACOS when present. Use this to evaluate ad spend efficiency — a high ACOS means advertising costs eat a large share of the revenue it generates. Get campaign ids from get_ads_campaigns. Requires the advertising scope; scope errors are surfaced clearly. Date format: YYYY-MM-DD.",
    inputSchema: {
      campaign_id: z
        .number()
        .describe("Campaign id from get_ads_campaigns"),
      date_from: z
        .string()
        .optional()
        .describe("Start of the range, YYYY-MM-DD. Defaults to 30 days ago"),
      date_to: z
        .string()
        .optional()
        .describe("End of the range, YYYY-MM-DD. Defaults to today"),
    },
  },
  async ({ campaign_id, date_from, date_to }) => {
    try {
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      const to = date_to ?? fmt(new Date());
      const from =
        date_from ?? fmt(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000));
      const data = await meliGet<Record<string, unknown>>(
        `/advertising/product_ads/campaigns/${campaign_id}/metrics`,
        { date_from: from, date_to: to }
      );
      const m = ((data.metrics ?? data.summary ?? data) ?? {}) as Record<
        string,
        unknown
      >;
      return ok({
        campaign_id,
        date_from: from,
        date_to: to,
        impressions: m.impressions,
        clicks: m.clicks,
        ctr: m.ctr,
        cost: m.cost,
        sales: m.sales ?? m.sales_quantity,
        revenue: m.revenue ?? m.sales_amount,
        acos: m.acos,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Fulfillment (Full)
// ---------------------------------------------------------------------------

registerTool(
  "get_fulfillment_stock",
  {
    description:
      "List the seller's stock stored at Mercado Livre fulfillment centers (Full), with available and non-sellable (e.g. damaged) quantities. Use this for inventory questions about Full — for regular (seller-shipped) stock use get_my_items/get_item instead. Gotcha: this only works for accounts enrolled in Full; otherwise Meli answers with an error, which is surfaced clearly.",
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(50)
        .describe("Max stock entries to return, 1-100 (default 50)"),
    },
  },
  async ({ limit }) => {
    try {
      const sellerId = await getMyUserId();
      const data = await meliGet<{
        inventory?: Array<Record<string, unknown>>;
        results?: Array<Record<string, unknown>>;
      }>("/fulfillment/stock", { seller_id: sellerId, limit });
      const raw = data.inventory ?? data.results ?? [];
      const stock = raw.map((s) => ({
        inventory_id: s.inventory_id ?? s.id,
        seller_sku: s.seller_sku ?? s.sku,
        available_quantity: s.available_quantity,
        damaged_quantity: s.damaged_quantity ?? null,
        not_sellable_quantity: s.not_sellable_quantity ?? null,
      }));
      return ok({ total: stock.length, stock });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Mercado Shops & Depósitos
// ---------------------------------------------------------------------------

registerTool(
  "get_mercado_shop",
  {
    description:
      "Get the seller's Mercado Shop info (id, name, URL, status) if the account has one. Mercado Shops is an optional storefront feature — accounts without a shop get a graceful 'no shop' response instead of a hard error. Use this when the user asks about their store page or wants the shop URL.",
    inputSchema: {},
  },
  async () => {
    try {
      const sellerId = await getMyUserId();
      try {
        const shop = await meliGet<Record<string, unknown>>(
          `/users/${sellerId}/shop`
        );
        return ok({
          shop_id: shop.shop_id ?? shop.id,
          name: shop.name ?? shop.shop_name,
          url: shop.url ?? shop.permalink,
          status: shop.status,
        });
      } catch (firstErr) {
        try {
          const data = await meliGet<{
            results?: Array<Record<string, unknown>>;
          }>("/shops/search", { seller_id: sellerId });
          const shop = (data.results ?? [])[0];
          if (!shop) {
            return ok({
              shop: null,
              message: "This account does not have a Mercado Shop.",
            });
          }
          return ok({
            shop_id: shop.shop_id ?? shop.id,
            name: shop.name ?? shop.shop_name,
            url: shop.url ?? shop.permalink,
            status: shop.status,
          });
        } catch {
          return ok({
            shop: null,
            message: `This account does not appear to have a Mercado Shop (${
              firstErr instanceof Error ? firstErr.message : String(firstErr)
            }).`,
          });
        }
      }
    } catch (err) {
      return fail(err);
    }
  }
);

registerTool(
  "get_warehouses",
  {
    description:
      "List the seller's registered warehouses (multi-origin stock locations / depósitos) with their ids, descriptions and addresses. Useful for accounts shipping from multiple addresses and for setting up shipping options per origin. Accounts without registered warehouses get an empty list or a clear API error.",
    inputSchema: {},
  },
  async () => {
    try {
      const sellerId = await getMyUserId();
      const data = await meliGet<unknown>("/user-warehouses", {
        seller_id: sellerId,
      });
      const list = Array.isArray(data)
        ? data
        : ((data as { results?: Array<Record<string, unknown>> }).results ??
          []);
      const warehouses = (list as Array<Record<string, unknown>>).map((w) => {
        const address = (w.address ?? {}) as Record<string, unknown>;
        return {
          id: w.id ?? w.warehouse_id,
          description: w.description ?? w.name,
          city: address.city,
          state: address.state,
          stock_location: w.stock_location ?? null,
        };
      });
      return ok({ total: warehouses.length, warehouses });
    } catch (err) {
      return fail(err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("MCP Mercado Livre server running on stdio");
