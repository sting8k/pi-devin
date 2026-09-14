/**
 * Latency probe for GetChatMessage (swe-2).
 *
 * Measures per-run: ttfb (response headers), first event / first thinking /
 * first text / done (ms from just before fetch), finish reason, usage, and
 * generated char counts. Reads credentials via src/credentials.js and never
 * prints them.
 *
 * Usage: npx tsx probe/latency.ts <group> [...]
 * Groups: warm jwt gzip bigprompt identity noaccept nojwt freshids ide h2
 *         ladder tokens throughput
 */
import { randomUUID } from "node:crypto";
import * as zlib from "node:zlib";
import { readCredentials } from "../src/credentials.js";
import { getCachedUserJwt } from "../src/jwt.js";
import { buildMetadata } from "../src/metadata.js";
import {
  encodeMessage,
  encodeString,
  encodeVarintField,
  encodeFixed64Field,
  frameConnectStream,
  iterFields,
} from "../src/wire.js";

const creds = readCredentials();
if (!creds) throw new Error("no credentials");
const HOST = creds.apiServerUrl.replace(/\/$/, "");
const API_KEY = creds.apiKey;

// ---------------------------------------------------------------- request ---
type Knobs = {
  modelUid: string;
  systemPrompt?: string;
  userText: string;
  maxTokens?: number;
  maxNewlines?: number;
  gzip?: boolean;            // request envelope gzip (default true)
  acceptGzip?: boolean;      // response accept-encoding (default true)
  jwt?: boolean;             // include user_jwt in Metadata (default true)
  freshIds?: boolean;        // new session/cascade/trajectory per call
  ide?: string;              // override metadata ide
  dispatcher?: unknown;      // undici dispatcher (h2 agent etc.)
  tools?: number;            // append N dummy tool defs (field 10)
  undiciFetch?: boolean;     // use external undici fetch (needed for h2 agent)
  timeoutMs?: number;
};

const stableIds = { sessionId: randomUUID(), cascadeId: randomUUID(), trajectoryId: randomUUID() };

function encodeChatPrompt(text: string, source: number): Buffer {
  return Buffer.concat([
    encodeVarintField(2, source),
    encodeString(3, text),
    encodeVarintField(4, Math.max(1, Math.floor(text.length / 4))),
    encodeVarintField(5, 1),
  ]);
}

function encodeConfig(maxTokens: number, maxNewlines: number): Buffer {
  return Buffer.concat([
    encodeVarintField(1, 1),
    encodeVarintField(2, maxTokens),
    encodeVarintField(3, maxNewlines),
    encodeFixed64Field(5, 1.0),
    encodeVarintField(7, 40),
    encodeFixed64Field(8, 0.95),
  ]);
}

function encodeTrajectory(id: string): Buffer {
  return Buffer.concat([encodeString(1, id), encodeVarintField(3, 4), encodeVarintField(4, 14)]);
}

function encodeToolDefs(n: number): Buffer[] {
  const desc = ("Reads a file from the repository and returns its contents with line numbers. " +
    "Use offset/limit for large files. Supports text and images. ").repeat(2);
  const params = JSON.stringify({
    type: "object",
    properties: { path: { type: "string", description: "file path" }, offset: { type: "number" }, limit: { type: "number" } },
    required: ["path"],
  });
  return Array.from({ length: n }, (_, i) =>
    Buffer.concat([
      encodeString(1, `tool_${i}`),
      encodeString(2, desc),
      encodeString(3, params),
    ]),
  );
}

async function buildRequest(k: Knobs): Promise<Buffer> {
  const ids = k.freshIds
    ? { sessionId: randomUUID(), cascadeId: randomUUID(), trajectoryId: randomUUID() }
    : stableIds;
  const userJwt = k.jwt === false ? undefined : await getCachedUserJwt(API_KEY, HOST);
  const metadata = buildMetadata({
    apiKey: API_KEY,
    userJwt,
    sessionId: ids.sessionId,
    requestId: BigInt(Date.now()),
    triggerId: randomUUID(),
    ...(k.ide ? { ide: k.ide } : {}),
  });
  return Buffer.concat([
    encodeMessage(1, metadata),
    ...(k.systemPrompt ? [encodeString(2, k.systemPrompt)] : []),
    encodeMessage(3, encodeChatPrompt(k.userText, 1)),
    encodeVarintField(7, 5),
    encodeMessage(8, encodeConfig(k.maxTokens ?? 128_000, k.maxNewlines ?? 400)),
    ...encodeToolDefs(k.tools ?? 0).map((t) => encodeMessage(10, t)),
    encodeMessage(15, encodeTrajectory(ids.trajectoryId)),
    encodeString(16, ids.cascadeId),
    encodeVarintField(20, 1),
    encodeString(21, k.modelUid),
  ]);
}

// ------------------------------------------------------------------- call ---
type RunResult = {
  group: string; run: number; bytes: number;
  ttfb: number; firstEvent: number; firstThink: number | null;
  firstText: number | null; done: number; finish: string;
  inTok?: number; outTok?: number; thinkChars: number; textChars: number;
  error?: string;
};

async function callOnce(group: string, run: number, k: Knobs): Promise<RunResult> {
  const r: RunResult = {
    group, run, bytes: 0, ttfb: 0, firstEvent: 0, firstThink: null,
    firstText: null, done: 0, finish: "?", thinkChars: 0, textChars: 0,
  };
  const gzip = k.gzip !== false;
  const proto = await buildRequest(k);
  r.bytes = proto.length;
  const body = frameConnectStream(proto, gzip);
  const t0 = performance.now();
  try {
    const doFetch = k.undiciFetch ? (await import("undici")).fetch : fetch;
    const resp = await doFetch(`${HOST}/exa.api_server_pb.ApiServerService/GetChatMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/connect+proto",
        "Connect-Protocol-Version": "1",
        ...(gzip ? { "Connect-Content-Encoding": "gzip" } : {}),
        ...(k.acceptGzip === false ? {} : { "Connect-Accept-Encoding": "gzip" }),
      },
      body: new Uint8Array(body),
      ...(k.dispatcher ? { dispatcher: k.dispatcher } : {}),
      signal: AbortSignal.timeout(k.timeoutMs ?? 120_000),
    } as RequestInit);
    r.ttfb = performance.now() - t0;
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    if (!resp.body) throw new Error("empty body");

    const reader = resp.body.getReader();
    void reader.closed.catch(() => {});
    let buf = Buffer.alloc(0);
    let sawEos = false;
    let trailer: string | null = null;

    const handleFrame = (payload: Buffer) => {
      for (const f of iterFields(payload)) {
        if (f.num === 3 && f.wire === 2 && Buffer.isBuffer(f.value)) {
          const t = f.value.toString("utf8");
          if (t) {
            if (r.firstEvent === 0) r.firstEvent = performance.now() - t0;
            if (r.firstText === null) r.firstText = performance.now() - t0;
            r.textChars += t.length;
          }
        } else if (f.num === 9 && f.wire === 2 && Buffer.isBuffer(f.value)) {
          const t = f.value.toString("utf8");
          if (t) {
            if (r.firstEvent === 0) r.firstEvent = performance.now() - t0;
            if (r.firstThink === null) r.firstThink = performance.now() - t0;
            r.thinkChars += t.length;
          }
        } else if (f.num === 5 && f.wire === 0) {
          const v = Number(f.value);
          r.finish = v === 10 ? "tool_calls" : v === 11 ? "content_filter" : v === 1 || v === 3 ? "length" : "stop";
        } else if (f.num === 28 && f.wire === 2 && Buffer.isBuffer(f.value)) {
          for (const outer of iterFields(f.value)) {
            if (outer.num !== 2 || !Buffer.isBuffer(outer.value)) continue;
            let metric = "", value = 0;
            for (const inner of iterFields(outer.value)) {
              if (inner.num === 5 && Buffer.isBuffer(inner.value)) metric = inner.value.toString("utf8");
              else if (inner.num === 4 && Buffer.isBuffer(inner.value))
                for (const d of iterFields(inner.value))
                  if (d.num === 2 && d.wire === 5 && Buffer.isBuffer(d.value)) value = d.value.readFloatLE(0);
            }
            if (metric === "input_tokens") r.inTok = Math.round(value);
            if (metric === "output_tokens") r.outTok = Math.round(value);
          }
        }
      }
    };

    read: while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      buf = buf.length === 0 ? Buffer.from(value) : Buffer.concat([buf, Buffer.from(value)]);
      while (buf.length >= 5) {
        const flags = buf[0];
        const len = buf.readUInt32BE(1);
        if (buf.length < 5 + len) break;
        const raw = buf.subarray(5, 5 + len);
        buf = buf.subarray(5 + len);
        let payload = raw;
        if (flags & 0x01) payload = zlib.gunzipSync(raw);
        if (flags & 0x02) {
          sawEos = true;
          const text = payload.toString("utf8");
          if (text.includes('"error"')) trailer = text.slice(0, 200);
          continue read;
        }
        handleFrame(payload);
      }
    }
    try { await resp.body.cancel(); } catch { /* ignore */ }
    r.done = performance.now() - t0;
    if (trailer) throw new Error(`trailer: ${trailer}`);
    if (!sawEos) throw new Error("no EOS trailer");
  } catch (e) {
    r.done = performance.now() - t0;
    r.error = e instanceof Error ? e.message : String(e);
    r.finish = "error";
  }
  return r;
}

// ------------------------------------------------------------------ misc ---
async function warmup(): Promise<void> {
  const t0 = performance.now();
  await getCachedUserJwt(API_KEY, HOST); // cold mint
  console.log(`# jwt mint+cold: ${Math.round(performance.now() - t0)}ms`);
  const t1 = performance.now();
  await fetch(`${HOST}/`, { method: "HEAD", signal: AbortSignal.timeout(15_000) }).catch(() => {});
  console.log(`# HEAD warm (dns+tls likely cold): ${Math.round(performance.now() - t1)}ms`);
  await callOnce("warmup", 0, { modelUid: "swe-2-high", userText: "Say pong.", maxTokens: 64 });
}

const filler = () =>
  "You are working in a large repository. Follow existing code style. Prefer small, surgical diffs. Do not reformat unrelated code. Keep functions short and single-purpose. When unsure, ask instead of guessing. Cite files and lines for every claim. Never invent APIs; verify against source. Tests must pass before finishing. ";

function bigPrompt(targetBytes: number): string {
  let s = "";
  while (s.length < targetBytes) s += filler();
  return s.slice(0, targetBytes);
}

const PING: Pick<Knobs, "userText" | "maxTokens"> = { userText: "Say pong.", maxTokens: 64 };

// ----------------------------------------------------------------- matrix ---
type Scenario = { group: string; runs: number; knobs: Knobs };

const groups: Record<string, Scenario[]> = {
  warm: [{ group: "warm", runs: 3, knobs: { modelUid: "swe-2-high", ...PING } }],
  jwt: [{ group: "jwt", runs: 3, knobs: { modelUid: "swe-2-high", ...PING, jwt: true } }],
  gzip: [
    { group: "identity_req", runs: 3, knobs: { modelUid: "swe-2-high", ...PING, gzip: false } },
    { group: "gzip_req", runs: 3, knobs: { modelUid: "swe-2-high", ...PING, gzip: true } },
  ],
  noaccept: [{ group: "no_accept_gzip", runs: 3, knobs: { modelUid: "swe-2-high", ...PING, acceptGzip: false } }],
  nojwt: [{ group: "no_jwt", runs: 3, knobs: { modelUid: "swe-2-high", ...PING, jwt: false } }],
  freshids: [{ group: "fresh_ids", runs: 3, knobs: { modelUid: "swe-2-high", ...PING, freshIds: true } }],
  ide: [{ group: "ide_windsurf", runs: 3, knobs: { modelUid: "swe-2-high", ...PING, ide: "windsurf" } }],
  h2: [{ group: "http2", runs: 3, knobs: { modelUid: "swe-2-high", ...PING, undiciFetch: true, dispatcher: await h2Dispatcher() } }],
  toolsx: [
    { group: "tools0", runs: 3, knobs: { modelUid: "swe-2-high", ...PING, tools: 0, maxTokens: 128_000 } },
    { group: "tools25", runs: 3, knobs: { modelUid: "swe-2-high", ...PING, tools: 25, maxTokens: 128_000 } },
  ],
  bigprompt: [
    { group: "big48k_gzip", runs: 3, knobs: { modelUid: "swe-2-high", ...PING, systemPrompt: bigPrompt(48_000) } },
    { group: "big48k_identity", runs: 3, knobs: { modelUid: "swe-2-high", ...PING, systemPrompt: bigPrompt(48_000), gzip: false } },
    { group: "big4k_gzip", runs: 3, knobs: { modelUid: "swe-2-high", ...PING, systemPrompt: bigPrompt(4_000) } },
  ],
  ladder: [
    { group: "swe-2-medium", runs: 3, knobs: { modelUid: "swe-2-medium", ...PING } },
    { group: "swe-2-high", runs: 3, knobs: { modelUid: "swe-2-high", ...PING } },
    { group: "swe-2-max", runs: 3, knobs: { modelUid: "swe-2-max", ...PING } },
  ],
  ab: [
    { group: "ab_mt64", runs: 1, knobs: { modelUid: "swe-2-high", userText: "Say pong.", maxTokens: 64 } },
    { group: "ab_mt128k", runs: 1, knobs: { modelUid: "swe-2-high", userText: "Say pong.", maxTokens: 128_000 } },
    { group: "ab_mt64", runs: 1, knobs: { modelUid: "swe-2-high", userText: "Say pong.", maxTokens: 64 } },
    { group: "ab_mt128k", runs: 1, knobs: { modelUid: "swe-2-high", userText: "Say pong.", maxTokens: 128_000 } },
    { group: "ab_mt64", runs: 1, knobs: { modelUid: "swe-2-high", userText: "Say pong.", maxTokens: 64 } },
    { group: "ab_mt128k", runs: 1, knobs: { modelUid: "swe-2-high", userText: "Say pong.", maxTokens: 128_000 } },
    { group: "ab_mt64", runs: 1, knobs: { modelUid: "swe-2-high", userText: "Say pong.", maxTokens: 64 } },
    { group: "ab_mt128k", runs: 1, knobs: { modelUid: "swe-2-high", userText: "Say pong.", maxTokens: 128_000 } },
  ],
  tokens: [
    { group: "mt64", runs: 3, knobs: { modelUid: "swe-2-high", userText: "Say pong.", maxTokens: 64 } },
    { group: "mt128k", runs: 3, knobs: { modelUid: "swe-2-high", userText: "Say pong.", maxTokens: 128_000 } },
  ],
  antithink: [{ group: "antithink", runs: 3, knobs: { modelUid: "swe-2-high", userText: "Reply instantly with the single word: pong. Skip all deliberation, do not reason step by step.", maxTokens: 128_000 } }],
  throughput: [
    {
      group: "gen",
      runs: 2,
      knobs: {
        modelUid: "swe-2-high",
        userText: "Write the numbers 1 to 120, one number per line, nothing else.",
        maxTokens: 8_192,
      },
    },
  ],
};

async function h2Dispatcher(): Promise<unknown> {
  try {
    const { Agent } = await import("undici") as typeof import("undici");
    return new Agent({ allowH2: true });
  } catch {
    console.error("# undici not importable; h2 group will use default fetch");
    return undefined;
  }
}

// ------------------------------------------------------------------- main ---
const wanted = process.argv.slice(2);
if (wanted.length === 0) throw new Error("pass group names, e.g.: npx tsx probe/latency.ts warm nojwt");
await warmup();

const results: RunResult[] = [];
for (const name of wanted) {
  const scen = groups[name];
  if (!scen) throw new Error(`unknown group ${name}; have ${Object.keys(groups).join(" ")}`);
  for (const s of scen) {
    for (let i = 1; i <= s.runs; i++) {
      const r = await callOnce(s.group, i, s.knobs);
      results.push(r);
      const fmt = (n: number | null) => (n === null ? "-" : String(Math.round(n)));
      console.log(
        `${r.group.padEnd(16)} #${i} bytes=${String(r.bytes).padStart(6)} ttfb=${fmt(r.ttfb).padStart(5)} ` +
        `first=${fmt(r.firstEvent).padStart(5)} think=${fmt(r.firstThink).padStart(5)} text=${fmt(r.firstText).padStart(5)} ` +
        `done=${fmt(r.done).padStart(6)} finish=${r.finish.padEnd(10)} thinkCh=${r.thinkChars} textCh=${r.textChars} ` +
        `tok=${r.inTok}/${r.outTok}${r.error ? ` ERR=${r.error}` : ""}`,
      );
      await new Promise((res) => setTimeout(res, 300));
    }
  }
}
