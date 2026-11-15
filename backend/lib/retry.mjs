// When the launcher should retry the VS Code server on its own, and when it
// should stop and wait for the user's "Restart server".
//
//  - provisioning errors (no build, a failed or bad download) never retry on
//    their own, so a broken download is not fetched again every 30 s;
//  - start failures (spawned but never ready) retry with backoff, at most
//    `maxStartFailures` in `startWindowMs`;
//  - crashes of a server that was ready retry with backoff, at most
//    `maxCrashes` in `crashWindowMs`.

export class RetryPolicy {
  constructor({
    maxStartFailures = 3,
    startWindowMs = 10 * 60_000,
    maxCrashes = 5,
    crashWindowMs = 5 * 60_000,
    now = () => Date.now(),
  } = {}) {
    Object.assign(this, { maxStartFailures, startWindowMs, maxCrashes, crashWindowMs, now });
    this.startFailures = [];
    this.crashes = [];
  }

  static backoff(n) {
    return Math.min(30_000, 1000 * 2 ** Math.max(0, Math.min(n - 1, 5)));
  }

  #window(list, ms) {
    const cutoff = this.now() - ms;
    while (list.length && list[0] < cutoff) list.shift();
    return list;
  }

  /** @returns {{retry:boolean, delayMs?:number, reason?:string}} */
  recordStartFailure(kind) {
    if (kind === 'provision') {
      return { retry: false, reason: 'the VS Code server build could not be found or downloaded' };
    }
    const list = this.#window(this.startFailures, this.startWindowMs);
    list.push(this.now());
    if (list.length >= this.maxStartFailures) {
      return { retry: false, reason: `the VS Code server failed to start ${list.length} times in a row` };
    }
    return { retry: true, delayMs: RetryPolicy.backoff(list.length) };
  }

  /** A server that had been ready exited. */
  recordCrash() {
    const list = this.#window(this.crashes, this.crashWindowMs);
    list.push(this.now());
    if (list.length >= this.maxCrashes) {
      return { retry: false, reason: `the VS Code server exited ${list.length} times within ${Math.round(this.crashWindowMs / 60_000)} minutes` };
    }
    return { retry: true, delayMs: RetryPolicy.backoff(list.length) };
  }

  recordSuccess() {
    this.startFailures = [];
  }

  /** The user asked for a restart: start counting again. */
  reset() {
    this.startFailures = [];
    this.crashes = [];
  }
}
