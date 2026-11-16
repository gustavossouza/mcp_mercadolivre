import { getValidAccessToken, refreshTokens } from "./auth.js";

const BASE_URL = "https://api.mercadolibre.com";

export function apiUrl(path: string): URL {
  if (!path.startsWith('/') || path.startsWith('//') || /[%\\?#\x00-\x20]/.test(path) ||
      path.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('Invalid API path');
  }
  const url = new URL(BASE_URL + path);
  if (url.origin !== BASE_URL) throw new Error('Invalid API origin');
  return url;
}

export class MeliApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown
  ) {
    super(`Meli API error (HTTP ${status}): ${message}`);
    this.name = "MeliApiError";
  }
}

type QueryParams = Record<string, string | number | undefined>;

interface RequestOptions {
  params?: QueryParams;
  body?: unknown;
  formData?: FormData;
}

async function request<T>(
  method: string,
  path: string,
  opts: RequestOptions = {},
  retried = false
): Promise<T> {
  const token = await getValidAccessToken();

  const url = apiUrl(path);
  for (const [key, value] of Object.entries(opts.params ?? {})) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  let body: BodyInit | undefined;
  if (opts.formData) {
    // fetch sets the multipart boundary itself
    body = opts.formData;
  } else {
    headers["Content-Type"] = "application/json";
    body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  }

  const res = await fetch(url, { method, headers, body, redirect: "error", signal: AbortSignal.timeout(30_000) });

  if (res.status === 401 && !retried) {
    await refreshTokens();
    return request<T>(method, path, opts, true);
  }

  if (!res.ok) {
    let message = res.statusText;
    let details: unknown;
    try {
      const data = (await res.json()) as { message?: string; error?: string };
      details = data;
      message = data.message ?? data.error ?? message;
    } catch {
      // keep statusText
    }
    throw new MeliApiError(res.status, message, details);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const meliGet = <T>(path: string, params?: QueryParams): Promise<T> =>
  request<T>("GET", path, { params });

export const meliPost = <T>(
  path: string,
  body?: unknown,
  params?: QueryParams
): Promise<T> => request<T>("POST", path, { body, params });

export const meliPut = <T>(
  path: string,
  body?: unknown,
  params?: QueryParams
): Promise<T> => request<T>("PUT", path, { body, params });

export const meliDelete = <T>(
  path: string,
  params?: QueryParams
): Promise<T> => request<T>("DELETE", path, { params });

export const meliPostForm = <T>(
  path: string,
  formData: FormData,
  params?: QueryParams
): Promise<T> => request<T>("POST", path, { formData, params });

// For endpoints that return binary content (e.g. shipping labels).
export async function meliGetRaw(
  path: string,
  params?: QueryParams,
  accept = "application/octet-stream",
  retried = false
): Promise<{ contentType: string; data: Buffer }> {
  const token = await getValidAccessToken();
  const url = apiUrl(path);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const res = await fetch(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}`, Accept: accept },
  });
  if (res.status === 401 && !retried) {
    await refreshTokens();
    return meliGetRaw(path, params, accept, true);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!res.ok || contentType.includes("application/json")) {
    // Meli reports label errors as a JSON body
    let message = res.statusText;
    let details: unknown;
    try {
      const data = (await res.json()) as { message?: string; error?: string };
      details = data;
      message = data.message ?? data.error ?? message;
    } catch {
      // keep statusText
    }
    throw new MeliApiError(res.status, message, details);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return { contentType, data: buffer };
}
