/**
 * Deterministic unit checks for firstToEmit:
 * 1. picks the stream that emits first and forwards the rest of it
 * 2. aborts losers (onWinner) once a winner exists
 * 3. rethrows the first error when every stream fails before emitting
 * 4. all-fail ordering: first error wins, not last
 */
import { firstToEmit } from "../src/hedge.js";
import { hedgeCount } from "../src/stream.js";

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function* gen(name: string, timings: number[], failBefore?: Error) {
  for (const t of timings) {
    await delay(t);
    yield `${name}@${t}` as const;
  }
  if (failBefore) throw failBefore;
}

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// 1 + 2: winner is the fastest to emit; losers aborted
{
  const aborted = new Set<string>();
  const calls: number[] = [];
  const slow = gen("slow", [500, 100]);
  const fast = gen("fast", [30, 10, 10]);
  const out: string[] = [];
  for await (const v of firstToEmit([slow, fast], (winner) => {
    calls.push(winner);
    if (winner !== 0) aborted.add("slow"); // slow is index 0
    if (winner !== 1) aborted.add("fast"); // fast is index 1
  })) {
    out.push(v);
  }
  check("winner emits and forwards all events", out.length === 3 && out[0] === "fast@30", out.join(","));
  check("loser aborted, winner never", aborted.has("slow") && !aborted.has("fast"), `aborted=[${[...aborted]}] calls=[${calls}]`);
}

// 3: every stream fails before emitting -> first error rethrown
{
  const e1 = new Error("boom-1");
  const e2 = new Error("boom-2");
  let caught: Error | null = null;
  try {
    for await (const _ of firstToEmit(
      [
        (async function* () {
          await delay(60);
          throw e2;
        })(),
        (async function* () {
          await delay(10);
          throw e1;
        })(),
      ],
      () => {},
    )) {
      // unreachable
    }
  } catch (e) {
    caught = e as Error;
  }
  // "first" = the earliest rejection, which is e1 at 10ms
  check("all-fail rethrows earliest error", caught === e1, caught?.message ?? "");
}

// 4: consumer break (parent abort analog) -> cleanup still runs
{
  let winnerClosed = false;
  const winner = gen("w", [1, 1, 1, 1, 1]);
  const originalReturn = winner.return.bind(winner);
  winner.return = async (...args: Parameters<typeof originalReturn>) => {
    winnerClosed = true;
    return originalReturn(...args);
  };
  const seen: string[] = [];
  try {
    for await (const v of firstToEmit([gen("loser", [400]), winner], () => {})) {
      seen.push(v);
      if (seen.length === 2) break; // simulate pi aborting mid-stream
    }
  } catch {
    // ignore
  }
  await delay(30);
  check("winner closed on consumer break", winnerClosed);
}

// 5: single stream passthrough
{
  const out: string[] = [];
  for await (const v of firstToEmit([gen("only", [5, 5])], () => {})) out.push(v);
  check("single stream passthrough", out.length === 2 && out[0] === "only@5", out.join(","));
}

// 6: hedgeCount gating (default 3 for swe*, 1 otherwise; DEVIN_HEDGE overrides)
{
  const saved = process.env.DEVIN_HEDGE;
  try {
    delete process.env.DEVIN_HEDGE;
    check("swe* defaults to 3", hedgeCount("swe-2-high") === 3);
    check("swe-1.7 defaults to 3", hedgeCount("swe-1-7-medium") === 3);
    check("non-swe defaults to 1", hedgeCount("claude-opus-5-high") === 1);
    process.env.DEVIN_HEDGE = "1";
    check("DEVIN_HEDGE=1 disables on swe", hedgeCount("swe-2-high") === 1);
    process.env.DEVIN_HEDGE = "5";
    check("DEVIN_HEDGE=5 enables on non-swe", hedgeCount("claude-opus-5-high") === 5);
    process.env.DEVIN_HEDGE = "abc";
    check("invalid DEVIN_HEDGE falls back to 1", hedgeCount("swe-2-high") === 1);
  } finally {
    if (saved === undefined) delete process.env.DEVIN_HEDGE;
    else process.env.DEVIN_HEDGE = saved;
  }
}

process.exit(failures === 0 ? 0 : 1);
