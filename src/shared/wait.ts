/** TVAgent — one poll helper for everything that waits on the host. */

export interface PollOptions {
  attempts: number;
  intervalMs: number;
}

/**
 * Calls `check` until it returns something truthy. The first call happens
 * before any sleep, so a condition that already holds costs no waiting.
 *
 * @returns the first truthy value, or null if it never came
 */
export async function poll<T>(
  check: () => T | Promise<T>,
  { attempts, intervalMs }: PollOptions,
): Promise<T | null> {
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, intervalMs));
    const value = await check();
    if (value) return value;
  }
  return null;
}
