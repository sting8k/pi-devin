/**
 * Hedging race for request streams: fire N identical GetChatMessage requests,
 * keep the first stream that emits an event, abort the rest.
 *
 * Why "first event wins" and not "first completed": pi forwards events as they
 * stream, so the winner has to be picked before anything is forwarded. Across
 * the probe rounds the first-event ordering always matched the completed
 * ordering (queue wait dominates; generation is a short tail), and picking at
 * first event keeps incremental streaming.
 *
 * If every stream fails before emitting, the first error is rethrown. If the
 * winner fails mid-stream, the error surfaces exactly like the single-request
 * path — there is no fallback once events have been forwarded.
 */

export async function* firstToEmit<T>(
  streams: AsyncGenerator<T>[],
  onWinner: (winnerIndex: number) => void,
): AsyncGenerator<T> {
  if (streams.length === 0) throw new Error("firstToEmit: no streams");

  let winner: { it: AsyncGenerator<T>; value: T };
  let firstError: { error: unknown } | null = null;
  const starters = streams.map(async (it) => {
    try {
      const result = await it.next();
      if (result.done) throw new Error("stream ended before any event");
      return { it, value: result.value };
    } catch (error) {
      if (!firstError) firstError = { error }; // earliest rejection by time
      throw error;
    }
  });

  try {
    winner = await Promise.any(starters);
  } catch (error) {
    throw (firstError as { error: unknown } | null)?.error ?? error;
  }

  const winnerIndex = streams.indexOf(winner.it);
  try {
    onWinner(winnerIndex);
    yield winner.value;
    while (true) {
      const result = await winner.it.next();
      if (result.done) break;
      yield result.value;
    }
  } finally {
    // idempotent: also fires when the consumer breaks or the winner errors
    onWinner(winnerIndex);
    try {
      await winner.it.return(undefined as never);
    } catch {
      // ignore
    }
  }
}
