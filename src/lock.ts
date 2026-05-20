/**
 * Concurrency control for settings writes.
 *
 *  - {@link SerialQueue} serialises writes *within* one Pi process so a model
 *    change and a thinking-level change can never interleave their
 *    read / modify / write cycles.
 *  - {@link withFileLock} adds a cross-process advisory lock for when several
 *    Pi sessions are open at once. It uses the same `proper-lockfile`
 *    mechanism Pi's own settings writer uses, so the two mutually exclude.
 *
 * The cross-process lock is best-effort: if it cannot be acquired the work
 * still runs, because failing to restore a default is worse than a rare race.
 */

import lockfile from "proper-lockfile";

function noop(): void {
  /* intentionally empty */
}

/**
 * Runs queued async tasks strictly one at a time, in submission order.
 *
 * A task is only started once the previous task has fully settled (resolved or
 * rejected), so back-to-back submissions can never overlap.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /** Enqueue `task`; resolves/rejects with the task's own result. */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run: Promise<T> = this.tail.then(task, task);
    // Keep the chain alive even when a task rejects.
    this.tail = run.then(noop, noop);
    return run;
  }

  /** Resolves once every currently-queued task has settled. */
  onIdle(): Promise<void> {
    return this.tail.then(noop, noop);
  }
}

const LOCK_OPTIONS = {
  // settings.json may not exist yet; do not resolve symlinks of a missing file.
  realpath: false,
  // Treat a lock older than this many ms as stale and steal it.
  stale: 15_000,
  retries: { retries: 12, factor: 1.6, minTimeout: 25, maxTimeout: 250 },
};

/**
 * Run `fn` while holding a cross-process advisory lock on `file`.
 *
 * The lock file is `<file>.lock`; the parent directory of `file` must already
 * exist. If the lock cannot be acquired, `fn` runs anyway (best-effort).
 */
export async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(file, LOCK_OPTIONS);
  } catch {
    release = undefined;
  }

  try {
    return await fn();
  } finally {
    if (release) {
      await release().catch(() => {});
    }
  }
}
