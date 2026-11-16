# Security hardening candidate (2026-11-15)

Base: `16d39313ac3fa0450e0971ddf665d05150e59a29`.
This is a **local, un-deployed candidate**, not a security certification or approval to expose an HTTP MCP.

## Implemented boundaries

- OAuth uses random single-use state with a five-minute expiration, S256 PKCE, exact Host/method/path validation and loopback-only callback. Invalid callbacks do not consume valid state. Browser auto-opening via shell was removed. Token exchange errors are not echoed. PKCE must be enabled on the Mercado Livre developer application; official documentation: https://developers.mercadolivre.com.br/en_us/authentication-and-authorization . No real authorization was performed.
- Defaults are `ML_READ_ONLY=true`, `ML_TOOL_PROFILE=leitura`. Unknown profiles and malformed boolean values fail closed. Unknown tool names are denied. Explicit writes require both an explicit write profile and read-only disabled. These controls do not replace independent human approval for consequential actions.
- Local filesystem uploads, including video, were deliberately removed rather than trying to make arbitrary local paths safe. Public HTTPS image upload is retained. This is a breaking migration: clients must use public HTTPS image sources; never publish credentials or private files to work around this restriction.
- API path construction rejects dot-segments, percent escapes, backslashes, query/fragment injection, control characters and different origins. Fetch redirects are refused and requests have timeouts.
- Token HTTP success payloads are validated before persistence; malformed token/expiry fields never replace good credentials. Endpoint error bodies are not echoed.
- Token replacement uses a unique exclusive temporary file and atomic rename with 0600 mode. Single-process refresh dedup remains; multiple processes must NOT share rotating credentials.
- Audit omits request content. Labels and audit now use the directory containing `ML_TOKENS_FILE`, writable by the non-root Docker user. Existing deployments must protect that directory and review existing file permissions.
- SDK pinned to 1.32.2, Zod to 4.6.7; vulnerable transitive versions refreshed in lockfile. `maxToolInputElements=2048` enabled. `npm ci --ignore-scripts` used for Docker; container runs as `node` on the supported Node 24 line. Image digest pinning remains a deployment gate.

## Migration and limits

The Docker OAuth service was removed because a listener bound only to container loopback is not safely reachable through ordinary port publishing. Run authorization on a trusted local host, using the exact redirect registered with Mercado Livre. Default remains `http://localhost:3333/callback`; service binds IPv4 loopback. IPv6-only browser localhost behavior was not tested. Transfer tokens only via an approved secure administrative workflow. Do not expose port 3333 publicly.

Only stdio remains implemented. Production HTTP needs a separately reviewed authorization server/issuer/audience, authentication before parsing/dispatch, per-client scoping/session isolation, strict Host/Origin, body byte limits, concurrency and timeout limits, and inaccessible direct origin. A DNS entry or TLS proxy is not authentication. No HTTP endpoint, Cloudflare resource or VPS deployment was created by this patch.

Read-only refers to marketplace business writes, not OAuth refresh or local label/audit filesystem writes. Blacklist listing is no longer exposed in read-only because the mixed mutation tool was removed from that mode; this intentional restriction is safer than permitting a mixed write interface by default.

## Verification

- TypeScript type check and build passed.
- Nine focused tests passed: OAuth invalid/missing/duplicate/expired/replayed state, PKCE challenge, callback policy/malformed requests, profiles/defaults, API traversal, removed local read sink, atomic 0600 fake-token replacement, and actual SDK in-memory collection limit with legitimate control.
- Independent static candidate review identified malformed callback URL crash and Docker writable-directory regressions; both were corrected and related checks rerun.
- `npm audit fix --ignore-scripts`: 0 known vulnerabilities after updating six transitive packages. This is a registry-advisory check, not proof of safety.
- No real credentials, API account calls, browser authorization, external sockets, Docker image execution, VPS change, publication or deployment. Real OAuth interoperability and all 42 upstream marketplace workflows remain untested. There is no lint configuration or upstream test suite.

Overall outcome: hardening prepared, **production verification blocked** pending remote-auth architecture, real-provider/account validation, isolated deployment and integration tests. Do not treat this candidate as production-approved.

Docker image version pinned to node:24.22.3-alpine3.24 from the official docker-node 24/alpine3.24 Dockerfile. Tests ran under installed Node v24.22.1, not inside that image; image pull/build/digest verification remain unperformed.
