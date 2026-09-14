/**
 * Hedging probe: fire N identical GetChatMessage requests in parallel, keep
 * the first completed response, abort the rest. Reports each stream's finish
 * time to show the spread under the same load window.
 */
import { readCredentials } from "../src/credentials.js";
import { getCachedUserJwt } from "../src/jwt.js";
import { buildMetadata } from "../src/metadata.js";
import { encodeMessage, encodeString, encodeVarintField, encodeFixed64Field, frameConnectStream, iterFields } from "../src/wire.js";
import { randomUUID } from "node:crypto";

const creds = readCredentials();
if (!creds) throw new Error("no credentials");
const HOST = creds.apiServerUrl.replace(/\/$/, "");

function encodeChatPrompt(text: string, source: number): Buffer {
  return Buffer.concat([
    encodeVarintField(2, source),
    encodeString(3, text),
    encodeVarintField(4, Math.max(1, Math.floor(text.length / 4))),
    encodeVarintField(5, 1),
  ]);
}

async function onePing(label: string): Promise<{ label: string; first: number; done: number }> {
  const userJwt = await getCachedUserJwt(creds!.apiKey, HOST);
  const ids = { sessionId: randomUUID(), cascadeId: randomUUID(), trajectoryId: randomUUID() };
  const proto = Buffer.concat([
    encodeMessage(1, buildMetadata({ apiKey: creds!.apiKey, userJwt, sessionId: ids.sessionId, requestId: BigInt(Date.now()), triggerId: randomUUID() })),
    encodeMessage(3, encodeChatPrompt("Say pong.", 1)),
    encodeVarintField(7, 5),
    encodeMessage(8, Buffer.concat([encodeVarintField(1, 1), encodeVarintField(2, 64), encodeVarintField(3, 400), encodeFixed64Field(5, 1.0), encodeVarintField(7, 40), encodeFixed64Field(8, 0.95)])),
    encodeMessage(15, Buffer.concat([encodeString(1, ids.trajectoryId), encodeVarintField(3, 4), encodeVarintField(4, 14)])),
    encodeString(16, ids.cascadeId),
    encodeVarintField(20, 1),
    encodeString(21, "swe-2-high"),
  ]);
  const ctrl = new AbortController();
  const t0 = performance.now();
  let first = 0;
  const resp = await fetch(`${HOST}/exa.api_server_pb.ApiServerService/GetChatMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/connect+proto", "Connect-Protocol-Version": "1", "Connect-Content-Encoding": "gzip", "Connect-Accept-Encoding": "gzip" },
    body: new Uint8Array(frameConnectStream(proto, true)),
    signal: ctrl.signal,
  });
  const reader = resp.body!.getReader();
  void reader.closed.catch(() => {});
  let buf = Buffer.alloc(0);
  let done = 0;
  try {
    while (true) {
      const { value, done: rd } = await reader.read();
      if (rd) break;
      if (!value) continue;
      buf = Buffer.concat([buf, Buffer.from(value)]);
      while (buf.length >= 5) {
        const flags = buf[0];
        const len = buf.readUInt32BE(1);
        if (buf.length < 5 + len) break;
        const raw = buf.subarray(5, 5 + len);
        buf = buf.subarray(5 + len);
        if (flags & 0x01) {
          if (first === 0) first = performance.now() - t0;
          zlib_gunzip(raw);
        } else if (first === 0 && !(flags & 0x02)) {
          first = performance.now() - t0;
        }
        if (flags & 0x02) { done = performance.now() - t0; }
      }
      if (done) break;
    }
  } finally {
    ctrl.abort();
    try { await resp.body!.cancel(); } catch { /* ignore */ }
  }
  if (!done) done = performance.now() - t0;
  return { label, first, done };
}

function zlib_gunzip(_raw: Buffer): void { /* payload not needed for timing */ }

await onePing("warmup"); // jwt + tls + one scheduling sample

for (const round of [1, 2, 3]) {
  const t0 = performance.now();
  const promises = [1, 2, 3].map((i) => onePing(`r${round}#${i}`));
  const all: Awaited<Promise<{ label: string; first: number; done: number }>>[] = await Promise.all(promises.map(async (p) => {
    // resolve each when it finishes; we log all, plus wall-clock winner below
    return p.catch(() => ({ label: "?", first: -1, done: -1 }));
  }));
  const wall = Math.round(performance.now() - t0);
  const lines = all.map((r) => `${r.label}: first=${Math.round(r.first)}ms done=${Math.round(r.done)}ms`);
  const winner = Math.min(...all.map((r) => r.done));
  console.log(`round ${round} (parallel x3, winner=${Math.round(winner)}ms)\n  ${lines.join("\n  ")}`);
  await new Promise((r) => setTimeout(r, 500));
}
