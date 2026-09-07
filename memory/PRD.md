# Lumioos Agent Office — PRD / Working Notes

Repo: alberbehar/Lumioos-Agent-Office (Next.js 3D office "Claw3D" + custom Node server + gateway proxy).

## Original problem statement (Phase: OpenClaw connection fix)
The 3D office at `/office` works with the Demo backend, but cannot connect through its
OpenClaw backend to a real local OpenClaw gateway (`ws://127.0.0.1:18789`, OpenClaw
2026.9.2, real agent id `ceo`). Symptoms: "Gateway closed (1012): upstream closed",
"Timed out connecting to the gateway", "No local gateway found", gateway logs
`token_missing` / `token_mismatch`. Architecture: browser → `/api/gateway/ws` → server-side
upstream WebSocket (server/gateway-proxy.js).

## Architecture (connection path)
- Browser client: `src/lib/gateway/openclaw/GatewayBrowserClient.ts` — waits for
  `connect.challenge` nonce, sends `connect` frame (minProtocol 3 / maxProtocol 4, ed25519
  device-auth signature, optional `auth.token`). Token is NEVER sent to the browser.
- Server proxy: `server/gateway-proxy.js` — relays browser⇄upstream, injects the
  server-side token into the connect frame.
- Upstream settings resolver (proxy path): `server/studio-settings.js`
  (`loadUpstreamGatewaySettings`). Used by `server/index.js`.
- UI settings resolver (Next API path): `src/lib/studio/settings-store.ts`.

## Root cause (fixed 2026-06)
1. `server/studio-settings.js` (the resolver the WS proxy actually uses) ignored the
   documented `CLAW3D_GATEWAY_URL` / `CLAW3D_GATEWAY_TOKEN` / `CLAW3D_GATEWAY_ADAPTER_TYPE`
   env vars — only the TS UI path read them. So a token configured via env never reached
   the proxy → `token_missing` / falls back to default URL with empty token.
2. `server/gateway-proxy.js` treated a fresh device-auth signature as "browser already has
   auth" and therefore skipped injecting the server-side shared token. On first pairing
   OpenClaw needs BOTH the device signature AND the shared bootstrap token → `token_mismatch`
   / `token_missing` and the socket closed.

## What was implemented
- `server/studio-settings.js`: reads CLAW3D_GATEWAY_* env (+ loads local `.env`/`.env.local`),
  precedence settings.json → env → openclaw.json → default. Added `readEnvGatewayDefaults`,
  `normalizeAdapterType` exports.
- `server/gateway-proxy.js`: injects the server token even when only a device signature is
  present (device signature still allowed for already-paired devices, so `token_missing`
  guard only fires when the browser sends NO auth at all). Wired in diagnostics.
- `server/gateway-diagnostics.js` (new): pure classifiers → `studio.gateway_unreachable`,
  `_invalid_token`, `_protocol_mismatch`, `_approval_required`, `_scope_missing`
  (+ existing `upstream_rejected`/`upstream_closed`). Token-safe (never sees the token).
- `src/lib/gateway/GatewayClient.ts`: new terminal codes added to
  NON_RETRYABLE_CONNECT_ERROR_CODES (approval_required stays retryable).
- Tests: `tests/unit/gatewayDiagnostics.test.ts`, `serverStudioSettings.test.ts`,
  `gatewayProxyDiagnostics.test.ts` (proxy ⇄ mock OpenClaw 2026.9.2 upstream: token
  injection with device auth, ceo roster, chat round-trip, all diagnostic categories).
  Updated one assertion in existing `gatewayProxy.test.ts` (pairing close → approval_required).

## Local run / verify (on the Mac with the real gateway)
```
cp .env.example .env      # then set CLAW3D_GATEWAY_URL/_TOKEN/_ADAPTER_TYPE (or rely on ~/.openclaw/openclaw.json)
npm ci
npm run lint && npm run typecheck && npm test -- --run && npm run build
npm run dev               # open http://localhost:3000/office
```
Verify: office roster shows the real `ceo`; sending a text task to `ceo` returns its reply.

## Test/build status (sandbox)
- New/affected adapter tests: 37/37 pass. typecheck: pass. build: pass.
- Full suite: 1097 pass / 7 fail. All 7 failures are PRE-EXISTING (present before this work)
  in unrelated UI/hook tests: agentChatPanel-controls, agentEditorModal, agentFleetHydration,
  useAgentSettingsMutationController, useGatewayConnection. `npm run lint` has 9 PRE-EXISTING
  errors in untouched files (RetroOffice3D, AgentBrainPanel, OfficeFloorNav, useOnboardingState).

## Constraints / not done this phase
- No Electron/DMG/EXE, Gmail, extra agents, rebranding, or visual redesign.
- Real connection not mocked; Demo backend untouched.
- Cloud sandbox cannot reach the user's Mac gateway → live `ceo` verification is done locally.

## Backlog / next
- P1: Optionally surface the new diagnostic codes with tailored UI hints in the connect panel.
- P2: Address pre-existing lint errors + flaky UI/hook tests (separate cleanup task).
