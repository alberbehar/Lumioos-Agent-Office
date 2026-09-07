// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadUpstreamGatewaySettings } from "../../server/studio-settings";

const makeTempDir = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));

type Env = Record<string, string | undefined>;

const baseEnv = (stateDir: string, extra: Env = {}): Env => ({
  OPENCLAW_STATE_DIR: stateDir,
  ...extra,
});

describe("server loadUpstreamGatewaySettings", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("reads runtime defaults from CLAW3D_GATEWAY_* env vars", () => {
    tempDir = makeTempDir("studio-env-only");
    const settings = loadUpstreamGatewaySettings(
      baseEnv(tempDir, {
        CLAW3D_GATEWAY_URL: "ws://127.0.0.1:18789",
        CLAW3D_GATEWAY_TOKEN: "env-secret-token",
        CLAW3D_GATEWAY_ADAPTER_TYPE: "openclaw",
      }) as NodeJS.ProcessEnv
    );

    expect(settings.url).toBe("ws://127.0.0.1:18789");
    expect(settings.token).toBe("env-secret-token");
    expect(settings.adapterType).toBe("openclaw");
  });

  it("normalizes an invalid adapter type env value back to openclaw", () => {
    tempDir = makeTempDir("studio-env-bad-adapter");
    const settings = loadUpstreamGatewaySettings(
      baseEnv(tempDir, {
        CLAW3D_GATEWAY_URL: "ws://127.0.0.1:18789",
        CLAW3D_GATEWAY_ADAPTER_TYPE: "not-a-real-adapter",
      }) as NodeJS.ProcessEnv
    );
    expect(settings.adapterType).toBe("openclaw");
  });

  it("lets settings.json override env defaults", () => {
    tempDir = makeTempDir("studio-file-wins");
    fs.mkdirSync(path.join(tempDir, "claw3d"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "claw3d", "settings.json"),
      JSON.stringify({
        gateway: { url: "ws://file-host:2222", token: "file-token", adapterType: "hermes" },
      }),
      "utf8"
    );

    const settings = loadUpstreamGatewaySettings(
      baseEnv(tempDir, {
        CLAW3D_GATEWAY_URL: "ws://env-host:1111",
        CLAW3D_GATEWAY_TOKEN: "env-token",
      }) as NodeJS.ProcessEnv
    );

    expect(settings.url).toBe("ws://file-host:2222");
    expect(settings.token).toBe("file-token");
    expect(settings.adapterType).toBe("hermes");
  });

  it("falls back to ~/.openclaw/openclaw.json for the token when env has none", () => {
    tempDir = makeTempDir("studio-openclaw-json");
    fs.writeFileSync(
      path.join(tempDir, "openclaw.json"),
      JSON.stringify({ gateway: { port: 18789, auth: { token: "local-config-token" } } }),
      "utf8"
    );

    const settings = loadUpstreamGatewaySettings(
      baseEnv(tempDir, {
        CLAW3D_GATEWAY_URL: "ws://127.0.0.1:18789",
        CLAW3D_GATEWAY_ADAPTER_TYPE: "openclaw",
      }) as NodeJS.ProcessEnv
    );

    expect(settings.url).toBe("ws://127.0.0.1:18789");
    expect(settings.token).toBe("local-config-token");
    expect(settings.adapterType).toBe("openclaw");
  });

  it("returns the built-in default url with no token when nothing is configured", () => {
    tempDir = makeTempDir("studio-empty");
    const settings = loadUpstreamGatewaySettings(baseEnv(tempDir) as NodeJS.ProcessEnv);
    expect(settings.url).toBe("ws://localhost:18789");
    expect(settings.token).toBe("");
    expect(settings.adapterType).toBe("openclaw");
  });
});
