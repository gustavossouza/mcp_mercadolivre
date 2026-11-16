import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

// .env is loaded from the current working directory first (npx / MCP client
// launches), falling back to the package directory (local clone). Missing
// .env is fine when env vars are provided directly by the MCP client config.
function loadDotEnv(): void {
  let content: string | undefined;
  for (const dir of [process.cwd(), rootDir]) {
    try {
      content = fs.readFileSync(path.join(dir, ".env"), "utf8");
      break;
    } catch {
      // try next location
    }
  }
  if (content === undefined) return;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

// Tokens live in the cwd (npx: where you ran the auth command; overridable
// via ML_TOKENS_FILE). A pre-existing tokens.json in the package directory
// keeps local-clone setups working when launched from another directory.
function resolveTokensFile(): string {
  if (process.env.ML_TOKENS_FILE) return process.env.ML_TOKENS_FILE;
  const cwdFile = path.join(process.cwd(), "tokens.json");
  const pkgFile = path.join(rootDir, "tokens.json");
  if (fs.existsSync(pkgFile) && !fs.existsSync(cwdFile)) return pkgFile;
  return cwdFile;
}

export function parseReadOnly(value: string | undefined): boolean {
  if (value === undefined || value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error("ML_READ_ONLY must be true, false, 1 or 0");
}

export const config = {
  clientId: process.env.ML_CLIENT_ID ?? "",
  clientSecret: process.env.ML_CLIENT_SECRET ?? "",
  siteId: process.env.ML_SITE_ID ?? "MLB",
  redirectUri: process.env.ML_REDIRECT_URI ?? "http://localhost:3333/callback",
  tokensFile: resolveTokensFile(),
  readOnly: parseReadOnly(process.env.ML_READ_ONLY),
  toolProfile: process.env.ML_TOOL_PROFILE ?? "leitura",
};
