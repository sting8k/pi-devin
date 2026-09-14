import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { Api, Model, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { authStatus, ensureCredentials, loginWithCli, readCredentials } from "../src/credentials.js";
import { readDevinDesktopApiKey } from "../src/desktop-auth.js";
import { getCachedUserJwt } from "../src/jwt.js";
import { whichDevin, devinVersion } from "../src/cli.js";
import { FALLBACK_MODELS, loadCatalog, modelsFromCatalog } from "../src/models.js";
import { CLIENT_IDE, CLIENT_VERSION } from "../src/metadata.js";
import { streamDevin } from "../src/stream.js";

const PROVIDER_ID = "devin";
const PLACEHOLDER_BASE_URL = "https://server.codeium.com";

let _pi: ExtensionAPI | null = null;

function registerDevinProvider(pi: ExtensionAPI, models: ProviderModelConfig[]): void {
  pi.registerProvider(PROVIDER_ID, {
    name: "Devin Local",
    api: "devin-local",
    baseUrl: PLACEHOLDER_BASE_URL,
    models,
    oauth: {
      name: "Devin CLI",
      async login(_callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
        const creds = await loginWithCli();
        if (_pi) {
          try {
            const catalog = await loadCatalog(creds);
            registerDevinProvider(_pi, modelsFromCatalog(catalog));
            _catalogLoaded = true;
          } catch {
            // keep current models
          }
        }
        return {
          refresh: "",
          access: creds.apiKey,
          expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
        };
      },
      async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        const creds = readCredentials();
        if (!creds) return credentials;
        return {
          refresh: "",
          access: creds.apiKey,
          expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
        };
      },
      getApiKey(credentials: OAuthCredentials): string {
        return readCredentials()?.apiKey || credentials.access;
      },
      modifyModels(models: Model<Api>[], _credentials: OAuthCredentials): Model<Api>[] {
        return models;
      },
    },
    streamSimple: streamDevin,
  });
}

let _catalogLoaded = false;
let _catalogRefresh: Promise<void> | null = null;

/**
 * Warm the JWT cache and the TLS connection in the background so the first
 * message of a session skips the ~650ms JWT mint and ~190ms handshake.
 */
function prewarmConnection(): void {
  void (async () => {
    try {
      const creds = readCredentials();
      if (!creds) return;
      await getCachedUserJwt(creds.apiKey, creds.apiServerUrl);
      await fetch(`${creds.apiServerUrl.replace(/\/$/, "")}/`, {
        method: "HEAD",
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {});
    } catch {
      // best effort — a failed prewarm just means the first message pays it
    }
  })();
}

/**
 * Refresh the live catalog without blocking init. Spawning `devin models list`
 * can take seconds (up to its 20s timeout) on a slow CLI or network, so the
 * provider starts on FALLBACK_MODELS and is re-registered once this finishes.
 */
function refreshCatalogInBackground(): void {
  if (_catalogRefresh) return;
  _catalogRefresh = (async () => {
    try {
      const creds = await ensureCredentials();
      if (!_pi || !creds) return;
      const catalog = await loadCatalog(creds);
      if (!_pi) return;
      registerDevinProvider(_pi, modelsFromCatalog(catalog));
      _catalogLoaded = true;
    } catch {
      // keep current models
    } finally {
      _catalogRefresh = null;
    }
  })();
}

export default async function (pi: ExtensionAPI): Promise<void> {
  _pi = pi;
  registerDevinProvider(pi, FALLBACK_MODELS);
  refreshCatalogInBackground();
  prewarmConnection();

  pi.on("session_start", () => {
    // Retry only while the live catalog never loaded (e.g. credentials showed
    // up after init). Once loaded, don't re-spawn the CLI on every session.
    if (!_catalogLoaded) refreshCatalogInBackground();
    prewarmConnection();
  });

  pi.registerCommand("devin-status", {
    description: "Show Devin CLI auth + binary status",
    handler: async (_args, ctx) => {
      const bin = await whichDevin();
      const version = await devinVersion();
      const status = await authStatus();
      const creds = readCredentials();
      const desktop = creds ? null : await readDevinDesktopApiKey();
      ctx.ui.notify(
        [
          bin ? `CLI: ${bin}` : "CLI: not found",
          version ? `CLI version: ${version}` : "CLI version: unknown",
          `Client identity: ${CLIENT_IDE} ${CLIENT_VERSION}`,
          creds
            ? `Credentials: ${creds.path}`
            : desktop
              ? `Credentials: none stored yet; Devin Desktop sign-in found at ${desktop.source}`
              : "Credentials: none found (no CLI store, no Devin Desktop sign-in)",
          status.loggedIn ? "Auth: signed in via Devin CLI" : "Auth: not signed in. Run /login devin or `devin auth login`",
        ].join("\n"),
        status.loggedIn && bin ? "info" : "warning",
      );
    },
  });

  pi.registerCommand("devin-refresh", {
    description: "Refresh the Devin Local model catalog (HTTP, CLI fallback)",
    handler: async (_args, ctx) => {
      try {
        const catalog = await loadCatalog(await ensureCredentials());
        const models = modelsFromCatalog(catalog);
        registerDevinProvider(pi, models);
        ctx.ui.notify(`Devin: loaded ${models.length} families.`, "info");
      } catch (error) {
        ctx.ui.notify(
          `Devin refresh failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.on("session_shutdown", async () => {
    _pi = null;
  });
}
