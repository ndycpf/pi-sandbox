import { createHash, randomUUID } from "node:crypto";

type Operation = "bash" | "unsandbox_bash" | "user-bash" | "read" | "write" | "edit";
type Outcome =
  | "pending"
  | "running"
  | "exited"
  | "refused"
  | "failed"
  | "cancelled"
  | "timeout"
  | "tool-completed"
  | "tool-error";

interface Record {
  id: string;
  operation: Operation;
  contextHash: string;
  spawned: boolean;
  outcome: Outcome;
  exitCode?: number | null;
}

export class ExecutionHistory {
  private rows = new Map<string, { row: Record; timer: NodeJS.Timeout }>();

  begin(operation: Operation, context: readonly (string | number | undefined)[]) {
    const id = randomUUID();
    const contextHash = createHash("sha256").update(JSON.stringify(context)).digest("hex");
    const row: Record = { id, operation, contextHash, spawned: false, outcome: "pending" };
    const oldest = this.rows.keys().next().value;
    if (this.rows.size >= 128 && oldest) this.remove(oldest);
    const timer = setTimeout(() => this.remove(id), 600_000).unref();
    this.rows.set(id, { row, timer });
    return {
      spawned() {
        row.spawned = true;
        if (row.outcome === "pending") row.outcome = "running";
      },
      finish(outcome: Outcome, exitCode?: number | null) {
        if (row.outcome === "pending" || row.outcome === "running") {
          row.outcome = outcome;
          row.exitCode = exitCode;
        }
      },
    };
  }

  snapshot() {
    return Array.from(this.rows.values(), ({ row }) => ({ ...row }));
  }
  clear() {
    for (const id of this.rows.keys()) this.remove(id);
  }
  private remove(id: string) {
    const entry = this.rows.get(id);
    if (entry) clearTimeout(entry.timer);
    this.rows.delete(id);
  }
}
