const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LEGACY_STATE_DIRNAMES = [".clawdbot", ".moltbot"];
const NEW_STATE_DIRNAME = ".openclaw";

// ---------------------------------------------------------------------------
// Minimal .env loader (non-overriding) so the custom Node server resolves the
// same CLAW3D_GATEWAY_* runtime defaults that the Next.js runtime reads. Values
// already present in process.env always win, and existing keys are never
// clobbered. Loaded once, from the working directory, on module import.
// ---------------------------------------------------------------------------

const loadDotenvFile = (filePath) => {
  try {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;
      let value = rawValue.trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch {
    // best-effort: a malformed .env must never crash gateway settings resolution.
  }
};

let dotenvLoaded = false;
const ensureRuntimeEnvLoaded = () => {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  const cwd = process.cwd();
  loadDotenvFile(path.join(cwd, ".env.local"));
  loadDotenvFile(path.join(cwd, ".env"));
};

ensureRuntimeEnvLoaded();

const resolveUserPath = (input) => {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("~")) {
    const expanded = trimmed.replace(/^~(?=$|[\\/])/, os.homedir());
    return path.resolve(expanded);
  }
  return path.resolve(trimmed);
};

const resolveDefaultHomeDir = () => {
  const home = os.homedir();
  if (home) {
    try {
      if (fs.existsSync(home)) return home;
    } catch {}
  }
  return os.tmpdir();
};

const resolveStateDir = (env = process.env) => {
  const override =
    env.OPENCLAW_STATE_DIR?.trim() ||
    env.MOLTBOT_STATE_DIR?.trim() ||
    env.CLAWDBOT_STATE_DIR?.trim();
  if (override) return resolveUserPath(override);

  const home = resolveDefaultHomeDir();
  const newDir = path.join(home, NEW_STATE_DIRNAME);
  const legacyDirs = LEGACY_STATE_DIRNAMES.map((dir) => path.join(home, dir));
  try {
    if (fs.existsSync(newDir)) return newDir;
  } catch {}
  for (const dir of legacyDirs) {
    try {
      if (fs.existsSync(dir)) return dir;
    } catch {}
  }
  return newDir;
};

const resolveStudioSettingsPath = (env = process.env) => {
  return path.join(resolveStateDir(env), "claw3d", "settings.json");
};

const readJsonFile = (filePath) => {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
};

const DEFAULT_GATEWAY_URL = "ws://localhost:18789";
const OPENCLAW_CONFIG_FILENAME = "openclaw.json";
const VALID_ADAPTER_TYPES = new Set(["openclaw", "hermes", "demo", "local", "claw3d", "custom"]);

const isRecord = (value) => Boolean(value && typeof value === "object");

const normalizeAdapterType = (value) => {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return VALID_ADAPTER_TYPES.has(normalized) ? normalized : "";
};

// Runtime env defaults (CLAW3D_GATEWAY_URL / _TOKEN / _ADAPTER_TYPE). These let
// operators point Studio at a gateway without editing settings.json — matching
// the documented behaviour in .env.example and src/lib/studio/settings-store.ts.
const readEnvGatewayDefaults = (env = process.env) => {
  const url = env.CLAW3D_GATEWAY_URL?.trim() || "";
  const token = env.CLAW3D_GATEWAY_TOKEN?.trim() || "";
  const adapterType = normalizeAdapterType(env.CLAW3D_GATEWAY_ADAPTER_TYPE);
  if (!url && !token && !adapterType) return null;
  return { url, token, adapterType };
};

const readOpenclawGatewayDefaults = (env = process.env) => {
  try {
    const stateDir = resolveStateDir(env);
    const configPath = path.join(stateDir, OPENCLAW_CONFIG_FILENAME);
    const parsed = readJsonFile(configPath);
    if (!isRecord(parsed)) return null;
    const gateway = isRecord(parsed.gateway) ? parsed.gateway : null;
    if (!gateway) return null;
    const auth = isRecord(gateway.auth) ? gateway.auth : null;
    const token = typeof auth?.token === "string" ? auth.token.trim() : "";
    const port =
      typeof gateway.port === "number" && Number.isFinite(gateway.port) ? gateway.port : null;
    if (!token) return null;
    const url = port ? `ws://localhost:${port}` : "";
    if (!url) return null;
    return { url, token, adapterType: "openclaw" };
  } catch {
    return null;
  }
};

/**
 * Resolve the upstream gateway the Studio WebSocket proxy should connect to.
 *
 * Precedence (per field, first non-empty wins):
 *   1. claw3d/settings.json  (explicit choice made in the Studio UI)
 *   2. CLAW3D_GATEWAY_* env   (runtime defaults for headless / scripted setups)
 *   3. ~/.openclaw/openclaw.json (the local OpenClaw gateway's own config)
 *   4. built-in default URL   (ws://localhost:18789)
 *
 * The returned token stays server-side; callers must never leak it to the
 * browser (the proxy injects it into connect frames).
 */
const loadUpstreamGatewaySettings = (env = process.env) => {
  ensureRuntimeEnvLoaded();
  const settingsPath = resolveStudioSettingsPath(env);

  let fileUrl = "";
  let fileToken = "";
  let fileAdapterType = "";
  try {
    const parsed = readJsonFile(settingsPath);
    const gateway = isRecord(parsed) ? parsed.gateway : null;
    fileUrl = typeof gateway?.url === "string" ? gateway.url.trim() : "";
    fileToken = typeof gateway?.token === "string" ? gateway.token.trim() : "";
    fileAdapterType = normalizeAdapterType(gateway?.adapterType);
  } catch {
    // Corrupt settings.json must fall back to env / local defaults rather than
    // taking down the whole connection path.
  }

  const envDefaults = readEnvGatewayDefaults(env);
  const openclawDefaults = readOpenclawGatewayDefaults(env);

  const adapterType =
    fileAdapterType ||
    envDefaults?.adapterType ||
    openclawDefaults?.adapterType ||
    "openclaw";

  const url =
    fileUrl ||
    envDefaults?.url ||
    openclawDefaults?.url ||
    DEFAULT_GATEWAY_URL;

  // The OpenClaw config token only applies to the OpenClaw adapter.
  const openclawToken = adapterType === "openclaw" ? openclawDefaults?.token || "" : "";
  const token = fileToken || envDefaults?.token || openclawToken;

  return {
    url,
    token,
    adapterType,
    settingsPath,
  };
};

module.exports = {
  resolveStateDir,
  resolveStudioSettingsPath,
  loadUpstreamGatewaySettings,
  readEnvGatewayDefaults,
  normalizeAdapterType,
};
