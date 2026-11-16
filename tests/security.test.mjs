import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createOAuthSession, localCallback, validateCallbackRequest } from '../dist/oauth-session.js';
import { parseReadOnly, config } from '../dist/config.js';
import { resolveSafety, toolAllowed, ALL_TOOLS, WRITE_TOOLS } from '../dist/safety.js';
import { apiUrl } from '../dist/meli-client.js';
import { buildAuthUrl } from '../dist/auth.js';
import { saveTokens, loadTokens } from '../dist/token-store.js';

// No external API, sockets or real credentials are used by these unit tests.
test('state is unpredictable, one-use, expiring and bound to a PKCE challenge', () => {
  const s = createOAuthSession(1000);
  assert.notEqual(s.state, createOAuthSession(1000).state);
  assert.equal(s.challenge, createHash('sha256').update(s.verifier).digest('base64url'));
  for (const value of ['code=x', 'code=x&state=wrong', `code=x&state=${s.state}&state=${s.state}`, `code=x&code=y&state=${s.state}`]) {
    assert.throws(() => s.consume(new URLSearchParams(value), 1001));
  }
  const valid = new URLSearchParams({code:'test-code',state:s.state});
  assert.throws(() => s.consume(valid, 301001));
  assert.equal(s.consume(valid, 1002), 'test-code');
  assert.throws(() => s.consume(valid, 1003));
  const auth = new URL(buildAuthUrl(s.state, s.challenge));
  assert.equal(auth.searchParams.get('state'), s.state);
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
});
test('callback refuses remote hosts and URL decorations', () => {
  assert.equal(localCallback('http://localhost:3333/callback').hostname, 'localhost');
  assert.equal(localCallback('http://127.0.0.1:3333/callback').hostname, '127.0.0.1');
  for (const v of ['http://0.0.0.0:3333/callback','https://example.com:3333/callback','http://localhost/callback','http://a@localhost:3333/callback','http://localhost:3333/callback?x=1']) assert.throws(() => localCallback(v));
});
test('safe defaults and invalid booleans/profiles fail closed', () => {
  assert.equal(parseReadOnly(undefined), true);
  assert.equal(parseReadOnly('false'), false);
  for (const v of ['TRUE ','yes','off','']) assert.throws(() => parseReadOnly(v));
  const safety = resolveSafety();
  assert.equal(safety.readOnly, true); assert.equal(safety.profile, 'leitura');
  for (const name of WRITE_TOOLS) assert.equal(toolAllowed(name, safety), false);
  for (const profile of ['typo', 'constructor', '__proto__']) assert.equal(toolAllowed('get_item', {profile,readOnly:false}), false);
  assert.equal(toolAllowed('unknown_future_tool', {profile:'all',readOnly:true}), false);
  assert.equal(toolAllowed('get_item', safety), true);
  assert.equal(toolAllowed('answer_question', {profile:'vendas',readOnly:false}), true);
  assert.equal(toolAllowed('upload_video', {profile:'all',readOnly:false}), false);
});
test('path traversal/encoded controls cannot reach API URL construction', () => {
  assert.equal(apiUrl('/items/MLB123').href, 'https://api.mercadolibre.com/items/MLB123');
  for (const value of ['/items/../users/me','/items/%2e%2e/users/me','//evil.test/x','/items/x?admin=true','/items/x#y','/items/..\\users/me']) assert.throws(() => apiUrl(value));
});
test('local upload read sink removed completely', () => {
  const source = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /readFile\s*\(/);
  assert.doesNotMatch(source, /async\s*\(\{[^}]*file_path/);
});
test('token replacement is atomic with restrictive mode using fake fixtures', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ml-fixture-'));
  const previous = config.tokensFile;
  try {
    config.tokensFile = path.join(dir,'tokens.json');
    saveTokens({access_token:'FAKE-A',refresh_token:'FAKE-R',expires_at:1});
    saveTokens({access_token:'FAKE-B',refresh_token:'FAKE-S',expires_at:2});
    assert.equal(loadTokens().access_token, 'FAKE-B');
    assert.equal(fs.statSync(config.tokensFile).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ['tokens.json']);
  } finally { config.tokensFile = previous; fs.rmSync(dir, {recursive:true}); }
});

test('malformed requests are rejected without consuming OAuth session', () => {
  const callback = localCallback('http://localhost:3333/callback');
  for (const target of ['//[', '//evil.test/callback', '/other']) assert.throws(() => validateCallbackRequest(callback, 'GET', 'localhost:3333', target));
  assert.throws(() => validateCallbackRequest(callback, 'POST', 'localhost:3333', '/callback'));
  assert.throws(() => validateCallbackRequest(callback, 'GET', 'evil.test', '/callback'));
  assert.equal(validateCallbackRequest(callback, 'GET', 'localhost:3333', '/callback?code=x').pathname, '/callback');
});

test('SDK limit rejects oversized collections before tool handler', async () => {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { z } = await import('zod');
  const server = new McpServer({name:'security-fixture',version:'1'}, {maxToolInputElements:2048});
  let calls = 0;
  server.registerTool('fixture', {inputSchema:{values:z.array(z.string())}}, () => {
    calls++; return {content:[{type:'text',text:'ok'}]};
  });
  const client = new Client({name:'fixture-client',version:'1'});
  const [a,b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const good = await client.callTool({name:'fixture',arguments:{values:['safe']}});
    assert.equal(good.isError, undefined); assert.equal(calls, 1);
    const bad = await client.callTool({name:'fixture',arguments:{values:Array(2049).fill('x')}});
    assert.equal(bad.isError, true); assert.equal(calls, 1);
  } finally { await client.close(); await server.close(); }
});

test('malformed successful token responses cannot replace good tokens', async () => {
  const { exchangeCodeForTokens } = await import('../dist/auth.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ml-response-'));
  const previous = config.tokensFile;
  const realFetch = globalThis.fetch;
  try {
    config.tokensFile = path.join(dir,'tokens.json');
    saveTokens({access_token:'FAKE-GOOD',refresh_token:'FAKE-REFRESH',expires_at:123});
    const original = fs.readFileSync(config.tokensFile,'utf8');
    const valid = {access_token:'FAKE-NEW',refresh_token:'FAKE-NEW-R',expires_in:21600};
    for (const bad of [null, [], {}, {...valid, access_token:''}, {...valid,refresh_token:7}, {...valid,access_token:'bad token'}, {...valid,expires_in:'21600'}, {...valid,expires_in:0}, {...valid,expires_in:-1}, {...valid,expires_in:1.5}, {...valid,expires_in:1e100}]) {
      globalThis.fetch = async () => new Response(JSON.stringify(bad),{status:200});
      await assert.rejects(exchangeCodeForTokens('FAKE-CODE','FAKE-VERIFIER'), /Invalid token response/);
      assert.equal(fs.readFileSync(config.tokensFile,'utf8'),original);
    }
    globalThis.fetch = async () => new Response(JSON.stringify(valid), {status:200});
    await exchangeCodeForTokens('FAKE-CODE','FAKE-VERIFIER');
    assert.equal(loadTokens().access_token,'FAKE-NEW');
  } finally { globalThis.fetch = realFetch; config.tokensFile = previous; fs.rmSync(dir,{recursive:true}); }
});
