// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  classifyUpstreamFailure,
  classifyOperatorScopes,
} from "../../server/gateway-diagnostics";

describe("classifyUpstreamFailure", () => {
  it("maps socket connection errors to gateway_unreachable", () => {
    for (const errorCode of ["ECONNREFUSED", "EHOSTUNREACH", "ENOTFOUND", "ETIMEDOUT"]) {
      const diag = classifyUpstreamFailure({ kind: "socket", errorCode });
      expect(diag.code).toBe("studio.gateway_unreachable");
      expect(diag.message).toContain(errorCode);
    }
  });

  it("maps token_missing / token_mismatch close reasons to invalid_token", () => {
    for (const reason of ["token_missing", "token_mismatch", "invalid token", "unauthorized"]) {
      const diag = classifyUpstreamFailure({ kind: "close", wsCode: 1008, reason });
      expect(diag.code).toBe("studio.gateway_invalid_token");
    }
  });

  it("maps a res auth error code to invalid_token", () => {
    const diag = classifyUpstreamFailure({
      kind: "res",
      errorCode: "auth_failed",
      errorMessage: "authentication failed",
    });
    expect(diag.code).toBe("studio.gateway_invalid_token");
  });

  it("maps protocol/version signals to protocol_mismatch", () => {
    const diag = classifyUpstreamFailure({
      kind: "res",
      errorCode: "protocol_version_unsupported",
      errorMessage: "minProtocol 5 exceeds maxProtocol 4",
    });
    expect(diag.code).toBe("studio.gateway_protocol_mismatch");
  });

  it("maps pairing/approval signals to approval_required", () => {
    for (const reason of ["pairing required", "device approval pending", "awaiting approval"]) {
      const diag = classifyUpstreamFailure({ kind: "res", errorMessage: reason });
      expect(diag.code).toBe("studio.gateway_approval_required");
    }
  });

  it("maps scope signals to scope_missing", () => {
    const diag = classifyUpstreamFailure({
      kind: "res",
      errorCode: "insufficient_scope",
      errorMessage: "missing operator scope",
    });
    expect(diag.code).toBe("studio.gateway_scope_missing");
  });

  it("falls back to upstream_rejected for 1008 without a keyword", () => {
    const diag = classifyUpstreamFailure({ kind: "close", wsCode: 1008, reason: "rate limit exceeded" });
    expect(diag.code).toBe("studio.upstream_rejected");
  });

  it("falls back to upstream_closed for other close codes", () => {
    const diag = classifyUpstreamFailure({ kind: "close", wsCode: 1006, reason: "" });
    expect(diag.code).toBe("studio.upstream_closed");
  });

  it("falls back to upstream_error for unknown socket errors", () => {
    const diag = classifyUpstreamFailure({ kind: "socket", errorCode: "EWEIRD", errorMessage: "boom" });
    expect(diag.code).toBe("studio.upstream_error");
  });

  it("never leaks any token-like value in its messages", () => {
    const diag = classifyUpstreamFailure({ kind: "close", wsCode: 1008, reason: "token_mismatch" });
    expect(diag.message).not.toContain("token_mismatch value");
  });
});

describe("classifyOperatorScopes", () => {
  it("accepts a session that carries an operator scope", () => {
    expect(
      classifyOperatorScopes({ auth: { scopes: ["operator.read", "operator.admin"] } })
    ).toEqual({ ok: true });
  });

  it("accepts when scopes are absent or empty (cannot infer)", () => {
    expect(classifyOperatorScopes({})).toEqual({ ok: true });
    expect(classifyOperatorScopes({ auth: { scopes: [] } })).toEqual({ ok: true });
    expect(classifyOperatorScopes(null)).toEqual({ ok: true });
  });

  it("rejects a non-empty scope list without any operator scope", () => {
    const result = classifyOperatorScopes({ auth: { scopes: ["chat.read", "chat.write"] } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("studio.gateway_scope_missing");
    }
  });
});
