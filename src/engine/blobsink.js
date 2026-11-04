/* =====================================================================
   Output sink: collects the muxer's positioned writes into disk-backable Blobs,
   so long 4K exports don't need one giant ArrayBuffer in memory.
   ===================================================================== */
export class BlobSink {
  static FLUSH = 32 * 1024 * 1024;
  parts = []; flushed = 0; tail = []; tailLen = 0; patches = [];
  get size() { return this.flushed + this.tailLen; }
  write(pos, data) {
    data = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (pos > this.size) this.#append(new Uint8Array(pos - this.size));
    let off = 0;
    if (pos < this.flushed) { // lands in already-flushed data: apply as a patch at the end
      const n = Math.min(data.length, this.flushed - pos);
      this.patches.push({ pos, data: data.slice(0, n) }); off = n;
    }
    while (off < data.length && pos + off < this.size) { // overwrite in-memory tail
      let p = pos + off - this.flushed, i = 0;
      while (p >= this.tail[i].length) p -= this.tail[i++].length;
      const n = Math.min(this.tail[i].length - p, data.length - off);
      this.tail[i].set(data.subarray(off, off + n), p); off += n;
    }
    if (off < data.length) this.#append(data.slice(off));
  }
  #append(d) { this.tail.push(d); this.tailLen += d.length; if (this.tailLen >= BlobSink.FLUSH) this.flush(); }
  flush() { if (!this.tailLen) return; this.parts.push(new Blob(this.tail)); this.flushed += this.tailLen; this.tail = []; this.tailLen = 0; }
  blob(type) {
    this.flush();
    let b = new Blob(this.parts);
    for (const { pos, data } of this.patches) b = new Blob([b.slice(0, pos), data, b.slice(pos + data.length)]);
    return new Blob([b], { type });
  }
  writable() { return new WritableStream({ write: (c) => this.write(c.position, c.data) }); }
}

