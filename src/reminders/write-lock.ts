import { mkdir, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers/promises';

export class ReminderBusyError extends Error {}

/** A per-user lock shared by all cooperating MCP processes and installations.
 * No lease stealing: a paused writer must never overlap a replacement writer.
 * After a process crash, an operator must reconcile uncertain writes before
 * removing the orphan directory. No reminder content is stored in this lock.
 */
export class ReminderWriteLock {
  constructor(
    private readonly directory = join(
      homedir(),
      'Library',
      'Application Support',
      'mcp-server-apple-events',
      'reminder-write.lock',
    ),
    private readonly waitMs = 10_000,
  ) {}

  /** Runs the complete read/modify/write/readback section exclusively.
   * @throws ReminderBusyError if another writer holds the lock past the deadline.
   * Filesystem and operation failures propagate; the owner releases in finally.
   */
  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await mkdir(dirname(this.directory), { recursive: true, mode: 0o700 });
    const deadline = performance.now() + this.waitMs;
    for (;;) {
      signal?.throwIfAborted();
      try {
        await mkdir(this.directory, { mode: 0o700 });
        break;
      } catch (error) {
        if (
          typeof error !== 'object' ||
          error === null ||
          !('code' in error) ||
          error.code !== 'EEXIST'
        )
          throw error;
        if (performance.now() >= deadline)
          throw new ReminderBusyError(
            'Reminder writer is busy. No write was started.',
          );
        await setTimeout(
          Math.min(25, Math.max(1, deadline - performance.now())),
        );
      }
    }
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      await rmdir(this.directory);
    }
  }
}
