/** Keeps the last `limit` bytes written to it. */
export class OutputTail {
  private chunks: Buffer[] = [];
  private kept = 0;
  total = 0;
  constructor(readonly limit: number) {}
  push(chunk: Buffer) {
    this.total += chunk.length;
    this.chunks.push(chunk);
    this.kept += chunk.length;
    while (this.chunks.length > 1 && this.kept - this.chunks[0]!.length >= this.limit) {
      this.kept -= this.chunks.shift()!.length;
    }
  }
  /** The last `bytes` bytes (at most `limit`), decoded as UTF-8. */
  text(bytes = this.limit) {
    const all = Buffer.concat(this.chunks);
    const shown = Math.min(bytes, this.limit, all.length);
    return new TextDecoder("utf-8").decode(all.subarray(all.length - shown));
  }
}
