/**
 * 1) no_jwt latency parity in a fast window (swe-2-high ping, mt128k).
 * 2) connection warmth: HEAD requests with growing idle gaps — how long does
 *    undici's keep-alive actually hold the TLS connection to server.codeium.com?
 */
import { readCredentials } from "../src/credentials.js";

const creds = readCredentials();
if (!creds) throw new Error("no credentials");
const HOST = creds.apiServerUrl.replace(/\/$/, "");

const head = async (label: string) => {
  const t0 = performance.now();
  await fetch(`${HOST}/`, { method: "HEAD", signal: AbortSignal.timeout(15_000) }).catch(() => {});
  console.log(`${label.padEnd(18)} ${Math.round(performance.now() - t0)}ms`);
};

console.log("# keep-alive probe (default undici global agent)");
await head("head#1 cold");
await head("head#2 +0s");
await new Promise((r) => setTimeout(r, 3_000));
await head("head#3 +3s");
await new Promise((r) => setTimeout(r, 5_000));
await head("head#4 +5s");
await new Promise((r) => setTimeout(r, 10_000));
await head("head#5 +10s");
await new Promise((r) => setTimeout(r, 20_000));
await head("head#6 +20s");
await new Promise((r) => setTimeout(r, 60_000));
await head("head#7 +60s");

// 2nd wave: pinned custom agent with long keepAliveTimeout
const { Agent, setGlobalDispatcher } = await import("undici");
setGlobalDispatcher(new Agent({ keepAliveTimeout: 600_000, keepAliveMaxTimeout: 600_000 }));
console.log("# keep-alive probe (custom agent keepAliveTimeout=600s)");
await head("head#1 cold");
await new Promise((r) => setTimeout(r, 30_000));
await head("head#2 +30s");
