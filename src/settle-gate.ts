/**
 * Counts changes in progress (the sandbox being turned on or off) so callers
 * can wait until none is running before they read the state the change sets.
 */
export class SettleGate {
  private active = 0;
  private waiters: (() => void)[] = [];

  /** Mark a change as started; call the returned function when it ends. */
  enter(): () => void {
    this.active++;
    let left = false;
    return () => {
      if (left) return;
      left = true;
      if (--this.active === 0) for (const wake of this.waiters.splice(0)) wake();
    };
  }

  /** Resolves once no change is in progress. */
  async settled(): Promise<void> {
    while (this.active > 0) await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
}
