import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

const limit = 64 * 1024;

// Captured at session startup. The caller retains both success and failure.
export function loadReviewPrompt(path: unknown, cwd: string): string | null {
  if (typeof path !== "string" || !isAbsolute(path)) return null;
  let fd: number | undefined;
  try {
    const canonical = realpathSync(path);
    const rel = relative(realpathSync(cwd), canonical);
    if (canonical !== path || (rel !== ".." && !rel.startsWith(".." + sep))) return null;
    if (!lstatSync(path).isFile()) return null;
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      (info.uid !== 0 && info.uid !== process.geteuid?.()) ||
      (info.mode & 0o022) !== 0 ||
      info.size < 1 ||
      info.size > limit
    )
      return null;
    const data = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < data.length) {
      const n = readSync(fd, data, size, data.length - size, null);
      if (!n) break;
      size += n;
    }
    if (size !== info.size || size > limit) return null;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, size));
    return text.trim() && !text.includes("\0") ? text : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
