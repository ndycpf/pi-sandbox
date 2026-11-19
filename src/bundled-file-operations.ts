import { constants } from "node:fs";
import { basename, dirname, join } from "node:path";

import { access, lstat, mkdir, open, realpath } from "node:fs/promises";

// Resolve only missing components as new names. A dangling symlink or a lookup
// error must never be treated as permission to create a new file there.
async function targetPath(path: string, allowMissing: boolean): Promise<string> {
  try {
    await lstat(path);
  } catch (error) {
    if (
      !allowMissing ||
      (error as NodeJS.ErrnoException).code !== "ENOENT" ||
      dirname(path) === path
    )
      throw error;
    return join(await targetPath(dirname(path), true), basename(path));
  }
  return realpath(path);
}

// Pi's read adapter needs a MIME hint before it handles image processing.
// Match Pi 0.80's signature checks on its first 4100 bytes.
function imageType(buffer: Buffer) {
  const b = buffer.subarray(0, 4100);
  if (b.length >= 3 && b.readUIntBE(0, 3) === 0xffd8ff && b[3] !== 0xf7) return "image/jpeg";
  if (b.toString("latin1", 0, 3) === "GIF") return "image/gif";
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP")
    return "image/webp";
  if (
    b.length >= 16 &&
    b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) &&
    b.readUInt32BE(8) === 13 &&
    b.toString("latin1", 12, 16) === "IHDR"
  ) {
    for (let i = 8; i + 8 <= b.length; i += 8 + b.readUInt32BE(i)) {
      const kind = b.toString("latin1", i + 4, i + 8);
      if (kind === "acTL") return null;
      if (kind === "IDAT") break;
    }
    return "image/png";
  }
  if (b.length >= 26 && b.toString("latin1", 0, 2) === "BM") {
    const size = b.readUInt32LE(2),
      pixels = b.readUInt32LE(10),
      header = b.readUInt32LE(14);
    const planes = header === 12 ? 22 : header >= 40 && header <= 124 && b.length >= 30 ? 26 : 0;
    if (
      planes &&
      (!size || (size >= 26 && pixels < size)) &&
      pixels >= 14 + header &&
      b.readUInt16LE(planes) === 1 &&
      [1, 4, 8, 16, 24, 32].includes(b.readUInt16LE(planes + 2))
    )
      return "image/bmp";
  }
  return null;
}

export function bundledOperations(
  kind: "read" | "write" | "edit",
  authorize: (path: string) => void,
  signal: AbortSignal,
) {
  async function checked(path: string) {
    signal.throwIfAborted();
    authorize(path);
    const target = await targetPath(path, kind === "write");
    signal.throwIfAborted();
    authorize(target);
    return target;
  }
  async function createParents(dir: string) {
    const missing: string[] = [];
    for (let current = dir; ; current = dirname(current)) {
      try {
        await lstat(current);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(current) === current)
          throw error;
      }
      await checked(current);
      missing.push(current);
    }
    for (const path of missing.reverse()) {
      const target = await checked(path);
      try {
        await mkdir(target);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "EEXIST" ||
          !(await lstat(target)).isDirectory()
        )
          throw error;
      }
    }
  }
  async function withFile<T>(
    path: string,
    flags: number,
    use: (file: Awaited<ReturnType<typeof open>>) => Promise<T>,
  ) {
    const file = await open(
      await checked(path),
      flags | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (kind !== "read" && stat.nlink !== 1)
        throw new Error("Multiply linked target: edit manually.");
      if (!stat.isFile()) throw new Error("Sandbox: expected a regular file.");
      signal.throwIfAborted();
      return await use(file);
    } finally {
      await file.close();
    }
  }
  return {
    access: async (path: string) =>
      access(
        await checked(path),
        kind === "edit" ? constants.R_OK | constants.W_OK : constants.R_OK,
      ),
    readFile: (path: string) =>
      withFile(path, constants.O_RDONLY, (file) => file.readFile({ signal })),
    detectImageMimeType: (path: string) =>
      withFile(path, constants.O_RDONLY, async (file) => {
        const bytes = Buffer.alloc(4100);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        return imageType(bytes.subarray(0, bytesRead));
      }),
    // Pi requests mkdir before writeFile supplies the actual destination.
    mkdir: async () => {},
    writeFile: async (path: string, content: string) => {
      if (kind === "write") {
        await checked(path);
        await createParents(dirname(path));
      }
      await withFile(
        path,
        constants.O_WRONLY | (kind === "write" ? constants.O_CREAT : 0),
        async (file) => {
          await file.truncate(0);
          await file.writeFile(content, { encoding: "utf8", signal });
        },
      );
    },
  };
}
