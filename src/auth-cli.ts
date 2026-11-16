#!/usr/bin/env node
import http from 'node:http';
import { buildAuthUrl, exchangeCodeForTokens } from './auth.js';
import { config } from './config.js';
import { createOAuthSession, localCallback, validateCallbackRequest } from './oauth-session.js';

const callback = localCallback(config.redirectUri);
if (!config.clientId || !config.clientSecret) throw new Error('ML_CLIENT_ID and ML_CLIENT_SECRET are required');
const session = createOAuthSession();
const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  let url: URL;
  try { url = validateCallbackRequest(callback, req.method, req.headers.host, req.url); }
  catch { res.writeHead(400).end('Invalid callback'); return; }
  let code: string;
  try { code = session.consume(url.searchParams); }
  catch { res.writeHead(400).end('Invalid or expired callback'); return; }
  void exchangeCodeForTokens(code, session.verifier).then(() => {
    res.end('Authentication completed. You may close this tab.');
    server.close(); clearTimeout(expiry);
  }).catch(() => {
    // Never echo token endpoint responses or credentials to browser/log.
    res.writeHead(502).end('Token exchange failed. Restart the authorization flow.');
    server.close(); clearTimeout(expiry); process.exitCode = 1;
  });
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
const expiry = setTimeout(() => { server.close(); process.exitCode = 1; }, 300_000);
server.on('error', () => { clearTimeout(expiry); process.exitCode = 1; });
server.listen(Number(callback.port), '127.0.0.1', () => {
  console.log(`Open this one-time URL manually in your trusted browser:\n${buildAuthUrl(session.state, session.challenge)}`);
});
