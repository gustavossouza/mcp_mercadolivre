import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export function createOAuthSession(now = Date.now()) {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let consumed = false;
  return {
    state, verifier, challenge,
    consume(params: URLSearchParams, at = Date.now()): string {
      const received = params.get('state') ?? '';
      const code = params.get('code') ?? '';
      if (consumed || at - now > 300_000 || at < now ||
          params.getAll('state').length !== 1 || params.getAll('code').length !== 1 ||
          !code || code.length > 2048 || received.length !== state.length ||
          !timingSafeEqual(Buffer.from(received), Buffer.from(state))) {
        throw new Error('Invalid, expired or consumed OAuth callback');
      }
      consumed = true;
      return code;
    }
  };
}

export function localCallback(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) ||
      !url.port || url.username || url.password || url.search || url.hash) {
    throw new Error('OAuth redirect must be http://localhost:PORT/path or http://127.0.0.1:PORT/path');
  }
  return url;
}

export function validateCallbackRequest(callback: URL, method: string | undefined, host: string | undefined, target: string | undefined): URL {
  if (method !== 'GET' || host !== callback.host || !target?.startsWith('/') || target.startsWith('//')) {
    throw new Error('Invalid callback');
  }
  const url = new URL(target, callback.origin);
  if (url.origin !== callback.origin || url.pathname !== callback.pathname) throw new Error('Invalid callback');
  return url;
}
