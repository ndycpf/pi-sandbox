/**
 * Counts changes in progress (the sandbox being turned on or off) so callers
 * can wait until none is running before they read the state the changes set.
 * A change can end with a failure, which every caller waiting on it receives.
 */
export class SettleGate {
  private active = 0;
  private waiters: { failures: string[]; wake: () => void }[] = [];

  /** Mark a change as started; call the returned function, with any failure, when it ends. */
  enter(): (failure?: string) => void {
    this.active++;
    let left = false;
    return (failure) => {
      if (left) return;
      left = true;
      if (failure) for (const waiter of this.waiters) waiter.failures.push(failure);
      if (--this.active === 0) for (const waiter of this.waiters.splice(0)) waiter.wake();
    };
  }

  /**
   * Resolves once no change is in progress, with the failure of a change it
   * waited for, if any, or undefined.
   */
  async settled(): Promise<string | undefined> {
    const failures: string[] = [];
    while (this.active > 0) {
      await new Promise<void>((wake) => this.waiters.push({ failures, wake }));
    }
    return failures[0];
  }
}
