/**
 * E2E: run the real streamDevin path (GetChatMessage → pi event stream) with
 * DEVIN_HEDGE=3 and print per-event timing. Run as:
 *   DEVIN_HEDGE=3 npx tsx probe/e2e.ts
 */
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { readCredentials } from "../src/credentials.js";
import { streamDevin } from "../src/stream.js";

const creds = readCredentials();
if (!creds) throw new Error("no credentials");

const model = {
  id: "swe-2",
  name: "SWE-2",
  api: "devin-local",
  provider: "devin",
  baseUrl: "https://server.codeium.com",
  reasoning: true,
  thinkingLevelMap: { high: "swe-2-high" },
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 262_000,
  maxTokens: 128_000,
} as unknown as Model<Api>;

const context: Context = {
  systemPrompt: "You are a latency probe. Answer with a single word.",
  messages: [{ role: "user", content: "Say pong." }],
  tools: [],
};

const runs = Number(process.env.E2E_RUNS ?? 3);
for (let i = 1; i <= runs; i++) {
  const t0 = performance.now();
  let first = 0;
  let text = "";
  let thinking = "";
  let done = 0;
  let stop = "?";
  let error: string | undefined;
  const stream = streamDevin(model, context, { apiKey: creds.apiKey, reasoning: "high" });
  try {
    for await (const ev of stream) {
      if (first === 0 && ev.type !== "start") first = performance.now() - t0;
      if (ev.type === "text_delta") text += ev.delta;
      if (ev.type === "thinking_delta") thinking += ev.delta;
      if (ev.type === "done") {
        done = performance.now() - t0;
        stop = ev.reason;
      }
      if (ev.type === "error") {
        done = performance.now() - t0;
        error = ev.error.errorMessage;
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    done = performance.now() - t0;
  }
  console.log(
    `run#${i} first=${Math.round(first)}ms done=${Math.round(done)}ms stop=${stop} ` +
    `thinking="${thinking.slice(0, 60)}" text="${text}"${error ? ` ERROR=${error}` : ""}`,
  );
  await new Promise((r) => setTimeout(r, 400));
}
