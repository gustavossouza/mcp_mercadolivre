import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export const ALL_TOOLS: readonly string[] = [
  "search_products",
  "get_item",
  "get_my_items",
  "get_questions",
  "get_orders",
  "predict_category",
  "get_category_attributes",
  "get_listing_types",
  "get_listing_prices",
  "create_item",
  "upload_picture",
  "upload_video",
  "update_item",
  "update_item_status",
  "answer_question",
  "manage_question_blacklist",
  "get_shipment",
  "get_shipment_label",
  "get_order_messages",
  "send_message",
  "get_claims",
  "get_claim_detail",
  "send_claim_message",
  "get_returns",
  "get_seller_reputation",
  "get_item_visits",
  "search_catalog",
  "get_catalog_product",
  "create_catalog_listing",
  "get_price_suggestion",
  "get_trends",
  "convert_currency",
  "get_site_categories",
  "get_category",
  "get_promotions",
  "get_promotion_items",
  "add_item_to_promotion",
  "get_ads_campaigns",
  "get_ads_campaign_metrics",
  "get_fulfillment_stock",
  "get_mercado_shop",
  "get_warehouses",
];

export const WRITE_TOOLS: Set<string> = new Set([
  "create_item",
  "upload_picture",
  "upload_video",
  "update_item",
  "update_item_status",
  "answer_question",
  "send_message",
  "send_claim_message",
  "create_catalog_listing",
  "add_item_to_promotion",
  "manage_question_blacklist",
]);

const READ_TOOLS = ALL_TOOLS.filter((t) => !WRITE_TOOLS.has(t));

export const PROFILES: Record<string, Set<string>> = {
  leitura: new Set(READ_TOOLS),
  vendas: new Set([
    ...READ_TOOLS,
    "answer_question",
    "send_message",
    "send_claim_message",
    "manage_question_blacklist",
  ]),
  publicacao: new Set([
    ...READ_TOOLS,
    "create_item",
    "upload_picture",
    "upload_video",
    "update_item",
    "update_item_status",
    "create_catalog_listing",
  ]),
  all: new Set(ALL_TOOLS),
};

export interface SafetyConfig {
  readOnly: boolean;
  profile: string;
}

export function resolveSafety(): SafetyConfig {
  if (!Object.hasOwn(PROFILES, config.toolProfile)) {
    throw new Error("Unknown ML_TOOL_PROFILE; refusing to expose tools");
  }
  return { readOnly: config.readOnly, profile: config.toolProfile };
}

export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name);
}

export function toolAllowed(name: string, safety: SafetyConfig): boolean {
  // Local filesystem capabilities are not exposed to MCP callers.
  if (name === "upload_video") return false;
  if (!Object.hasOwn(PROFILES, safety.profile)) return false;
  return PROFILES[safety.profile].has(name) && (!safety.readOnly || !isWriteTool(name));
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const URL_RE =
  /(https?:\/\/|www\.)\S+|\b[\w-]+\.(com|com\.br|net|org|io|app|br)\b/i;
const PHONE_RE =
  /\(\d{2}\)\s*9?\s?\d{4}-\d{4}|\b\d{2}\s*9?\s?\d{4}-?\d{4}\b|\b\d{8,}\b/;

// Meli moderation forbids contact info in buyer/claim messages.
export function containsContactInfo(text: string): boolean {
  return EMAIL_RE.test(text) || URL_RE.test(text) || PHONE_RE.test(text);
}

export const CONTACT_INFO_MESSAGE =
  "Message blocked: contains contact info (email/phone/link) which violates Mercado Livre moderation rules. Rephrase without contact details.";

export function auditLog(entry: Record<string, unknown>): void {
  try {
    fs.appendFileSync(
      path.join(path.dirname(config.tokensFile), "audit.log"),
      JSON.stringify(entry) + "\n",
      { mode: 0o600 }
    );
  } catch (err) {
    console.error("Warning: could not write to audit.log:", err);
  }
}
