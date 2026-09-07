"use strict";

/**
 * Gateway connection diagnostics.
 *
 * Pure, dependency-free classifiers that translate raw upstream WebSocket
 * failures (socket errors, close frames, connect `res` rejections) into a
 * small set of actionable, operator-facing diagnostic codes.
 *
 * These functions never receive or return the gateway token — they only
 * inspect error codes / reason strings, so their output is always safe to log
 * and to forward to the browser.
 *
 * Diagnostic codes (all prefixed `studio.`):
 *   - studio.gateway_unreachable        the host could not reach the gateway
 *   - studio.gateway_invalid_token      token missing / mismatched / expired
 *   - studio.gateway_protocol_mismatch  wire-protocol version incompatibility
 *   - studio.gateway_approval_required  device/session awaiting approval
 *   - studio.gateway_scope_missing      granted session lacks operator scopes
 *   - studio.upstream_error             generic socket failure (fallback)
 *   - studio.upstream_rejected          gateway closed with policy violation
 *   - studio.upstream_closed            gateway closed for another reason
 */

const CONNECTION_ERROR_CODES = new Set([
  "econnrefused",
  "econnreset",
  "ehostunreach",
  "ehostdown",
  "enetunreach",
  "enotfound",
  "etimedout",
  "eai_again",
  "epipe",
  "econnaborted",
]);

const DIAGNOSTICS = {
  unreachable: (detail) => ({
    code: "studio.gateway_unreachable",
    message:
      `The Studio host could not reach the gateway${detail ? ` (${detail})` : ""}. ` +
      "Confirm the gateway process is running and that CLAW3D_GATEWAY_URL points to it " +
      "(for a local OpenClaw gateway this is ws://127.0.0.1:18789).",
  }),
  invalidToken: () => ({
    code: "studio.gateway_invalid_token",
    message:
      "The gateway rejected the Studio credentials (token missing, mismatched, or expired). " +
      "Set CLAW3D_GATEWAY_TOKEN (or ~/.openclaw/openclaw.json → gateway.auth.token) to the " +
      "gateway's operator token and restart Studio.",
  }),
  protocolMismatch: () => ({
    code: "studio.gateway_protocol_mismatch",
    message:
      "The gateway negotiates a different wire-protocol version than this Studio build " +
      "(minProtocol/maxProtocol). Update OpenClaw and/or the Claw3D gateway client so their " +
      "supported protocol ranges overlap.",
  }),
  approvalRequired: () => ({
    code: "studio.gateway_approval_required",
    message:
      "The gateway is waiting for this device/session to be approved. Approve the pairing " +
      "request in the OpenClaw dashboard, then reconnect.",
  }),
  scopeMissing: () => ({
    code: "studio.gateway_scope_missing",
    message:
      "The gateway did not grant the operator scopes Studio needs " +
      "(operator.read / operator.admin / operator.approvals). Reconnect with an " +
      "operator-scoped token.",
  }),
  upstreamError: () => ({
    code: "studio.upstream_error",
    message: "Failed to connect to upstream gateway WebSocket.",
  }),
};

const buildText = (...parts) =>
  parts
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .join(" ")
    .toLowerCase();

/**
 * Classify an upstream connection failure into a diagnostic {code, message}.
 *
 * @param {object} input
 * @param {"socket"|"close"|"res"} input.kind   Origin of the failure signal.
 * @param {number}  [input.wsCode]              WebSocket close code (kind "close").
 * @param {string}  [input.reason]              WebSocket close reason (kind "close").
 * @param {string}  [input.errorCode]           errno (kind "socket") or upstream error code (kind "res").
 * @param {string}  [input.errorMessage]        Human-readable error/reason text.
 * @returns {{code: string, message: string}}
 */
function classifyUpstreamFailure(input) {
  const { kind, wsCode, reason, errorCode, errorMessage } = input || {};

  // 0. Socket-level connection errors are unambiguous "unreachable" signals.
  if (
    kind === "socket" &&
    typeof errorCode === "string" &&
    CONNECTION_ERROR_CODES.has(errorCode.trim().toLowerCase())
  ) {
    return DIAGNOSTICS.unreachable(errorCode.trim().toUpperCase());
  }

  const text = buildText(reason, errorMessage, errorCode);

  // 1. Credentials / authentication.
  if (
    /token[_\s-]?(missing|mismatch|invalid|required|expired|rejected)/.test(text) ||
    /(invalid|missing|bad|expired)[_\s-]?token/.test(text) ||
    /unauthor/.test(text) ||
    /forbidden/.test(text) ||
    /auth(entication|z|orization)?[_\s-]?(failed|required|error|rejected)/.test(text) ||
    /not[_\s-]?authenticated/.test(text) ||
    /bad[_\s-]?credential/.test(text) ||
    /\b(401|403)\b/.test(text)
  ) {
    return DIAGNOSTICS.invalidToken();
  }

  // 2. Protocol / version incompatibility.
  if (
    /protocol/.test(text) ||
    /min[_\s-]?protocol|max[_\s-]?protocol/.test(text) ||
    /unsupported[_\s-]?version|version[_\s-]?(mismatch|unsupported|not[_\s-]?supported)/.test(text) ||
    /incompatible/.test(text) ||
    /too[_\s-]?(old|new)/.test(text)
  ) {
    return DIAGNOSTICS.protocolMismatch();
  }

  // 3. Approval / device pairing.
  if (
    /approval|approve|approved/.test(text) ||
    /pairing|unpaired|pair[_\s-]?(required|this|device)/.test(text) ||
    /authorize[_\s-]?(this[_\s-]?)?device|device[_\s-]?(pending|approval|not[_\s-]?approved|unauthorized)/.test(text) ||
    /awaiting[_\s-]?(approval|operator)|pending[_\s-]?approval/.test(text)
  ) {
    return DIAGNOSTICS.approvalRequired();
  }

  // 4. Operator scopes.
  if (
    /\bscope[s]?\b/.test(text) ||
    /operator\./.test(text) ||
    /insufficient/.test(text) ||
    /not[_\s-]?permitted|permission[_\s-]?denied|missing[_\s-]?operator/.test(text)
  ) {
    return DIAGNOSTICS.scopeMissing();
  }

  // 5. Fallbacks.
  if (kind === "socket") {
    return DIAGNOSTICS.upstreamError();
  }

  if (wsCode === 1008) {
    return {
      code: "studio.upstream_rejected",
      message: `Upstream gateway rejected connect (1008): ${reason || "no reason provided"}`,
    };
  }

  return {
    code: "studio.upstream_closed",
    message: `Upstream gateway closed (${typeof wsCode === "number" ? wsCode : "?"}): ${reason || ""}`.trim(),
  };
}

/**
 * Inspect a successful `hello-ok` connect payload for operator scopes.
 * Only flags a problem when the gateway returned a non-empty scope list that
 * contains no `operator.*` scope (a genuine misconfiguration). When scopes are
 * absent/empty we cannot infer anything and treat the connection as OK.
 *
 * @param {unknown} helloPayload  The `payload` of the connect `res` frame.
 * @returns {{ok: true} | {ok: false, code: string, message: string}}
 */
function classifyOperatorScopes(helloPayload) {
  const auth =
    helloPayload && typeof helloPayload === "object" && helloPayload.auth && typeof helloPayload.auth === "object"
      ? helloPayload.auth
      : null;
  const scopes = auth && Array.isArray(auth.scopes) ? auth.scopes : null;
  if (!scopes || scopes.length === 0) {
    return { ok: true };
  }
  const hasOperatorScope = scopes.some(
    (scope) => typeof scope === "string" && scope.trim().toLowerCase().startsWith("operator.")
  );
  if (hasOperatorScope) {
    return { ok: true };
  }
  return { ok: false, ...DIAGNOSTICS.scopeMissing() };
}

module.exports = {
  classifyUpstreamFailure,
  classifyOperatorScopes,
  CONNECTION_ERROR_CODES,
};
