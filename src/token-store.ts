import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
}

export function loadTokens(): StoredTokens | null {
  try {
    const raw = fs.readFileSync(config.tokensFile, "utf8");
    const parsed = JSON.parse(raw) as StoredTokens;
    if (!parsed.access_token || !parsed.refresh_token) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveTokens(tokens: StoredTokens): void {
  fs.mkdirSync(path.dirname(config.tokensFile), { recursive: true });
  const temp = `${config.tokensFile}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(tokens, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, config.tokensFile);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* renamed or not created */ }
  }
}

// The token file holds account credentials; it must not be group/other
// readable. Warns and fixes the mode when it is too permissive.
export function enforceTokenPermissions(): void {
  try {
    const st = fs.statSync(config.tokensFile);
    if (st.mode & 0o077) {
      console.error(
        `Warning: ${config.tokensFile} has permissive mode ${(
          st.mode & 0o777
        ).toString(8)}; restricting to 0600.`
      );
      fs.chmodSync(config.tokensFile, 0o600);
    }
  } catch {
    // token file may not exist yet
  }
}
