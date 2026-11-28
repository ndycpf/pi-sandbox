import { readFileSync } from "node:fs";
import { join } from "node:path";

import { readdir } from "node:fs/promises";

/** What one `/proc` scan saw of a process group. */
export type GroupMembers = { live: boolean; zombies: number[] };

/**
 * A group's state for deciding whether its task is over:
 * - `gone`: no process is in the group.
 * - `live`: a process other than a zombie is in it, or its members could not be seen.
 * - `zombies`: the group exists and every member seen is a zombie; `key` names them.
 */
export type GroupState = { kind: "gone" } | { kind: "live" } | { kind: "zombies"; key: string };

/** stat files read between yields to the event loop during a scan. */
const READ_BATCH = 100;

/**
 * Scans of `/proc` for process groups that yield to the event loop, shared by every caller:
 * concurrent callers wait on the same scan, and a scan finished within
 * `maxAgeMs` is reused, so many watched tasks cost one scan per period.
 */
export class ProcessCensus {
  private current?: Promise<Map<number, GroupMembers> | undefined>;
  private last?: { at: number; groups: Map<number, GroupMembers> | undefined };

  constructor(
    private readonly procDir = "/proc",
    private readonly maxAgeMs = 200,
  ) {}

  /** Members by process group, or undefined when the directory cannot be read. */
  scan(): Promise<Map<number, GroupMembers> | undefined> {
    if (this.last && performance.now() - this.last.at < this.maxAgeMs)
      return Promise.resolve(this.last.groups);
    this.current ??= this.read().then((groups) => {
      this.last = { at: performance.now(), groups };
      this.current = undefined;
      return groups;
    });
    return this.current;
  }

  private async read(): Promise<Map<number, GroupMembers> | undefined> {
    let entries: string[];
    try {
      entries = (await readdir(this.procDir)).filter((entry) => /^\d+$/.test(entry));
    } catch {
      return undefined;
    }
    const groups = new Map<number, GroupMembers>();
    for (let i = 0; i < entries.length; i += READ_BATCH) {
      // Yield between batches: each one blocks the event loop for about a
      // millisecond, where reading them all at once could take tens.
      if (i) await new Promise((resolve) => setImmediate(resolve));
      for (const entry of entries.slice(i, i + READ_BATCH)) {
        let stat: string;
        try {
          stat = readFileSync(join(this.procDir, entry, "stat"), "utf8");
        } catch {
          continue; // Gone, or hidden from us.
        }
        // "pid (comm) state ppid pgrp ..."; comm may hold spaces and parentheses.
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const pgrp = Number(fields[2]);
        if (!Number.isInteger(pgrp)) continue;
        const members = groups.get(pgrp) ?? { live: false, zombies: [] };
        if (fields[0] === "Z" || fields[0] === "X") members.zombies.push(Number(entry));
        else members.live = true;
        groups.set(pgrp, members);
      }
    }
    return groups;
  }
}

/**
 * Classify a group that `kill(-pgid, 0)` says exists from a scan. A group
 * whose members the scan missed (a worker replaced by a successor while the
 * scan ran, or processes hidden from us) counts as live, never as gone.
 */
export function classifyGroup(
  groups: Map<number, GroupMembers> | undefined,
  pgid: number,
): GroupState {
  const members = groups?.get(pgid);
  if (!members || members.live || !members.zombies.length) return { kind: "live" };
  return { kind: "zombies", key: [...members.zombies].sort((a, b) => a - b).join(",") };
}

/**
 * Tracks whether a group whose leader exited is over. It is over when no
 * process is in it, or (on Linux, where PID 1 may not reap orphans) when two
 * scans in a row saw the same zombies and nothing else: a live process that
 * one scan missed shows up in the next, or leaves a different zombie.
 */
export class GroupWatch {
  private zombies?: string;

  constructor(
    private readonly pgid: number,
    private readonly census: ProcessCensus | undefined,
  ) {}

  /** Whether the group is over now. */
  async over(): Promise<boolean> {
    const state = await this.state();
    if (state.kind === "gone") return true;
    if (state.kind === "live") {
      this.zombies = undefined;
      return false;
    }
    if (state.key === this.zombies) return true;
    this.zombies = state.key;
    return false;
  }

  private async state(): Promise<GroupState> {
    if (!groupExists(this.pgid)) return { kind: "gone" };
    if (!this.census) return { kind: "live" };
    const state = classifyGroup(await this.census.scan(), this.pgid);
    // The last member may have gone while the scan ran.
    return groupExists(this.pgid) ? state : { kind: "gone" };
  }
}

/** Whether any process, zombies included, is in process group `pgid`. Cheap: one signal. */
export function groupExists(pgid: number | undefined) {
  if (!pgid) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The census for this platform: Linux only, since only it has `/proc` stat files. */
export const systemCensus = process.platform === "linux" ? new ProcessCensus() : undefined;
