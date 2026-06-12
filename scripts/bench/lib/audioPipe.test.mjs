import { describe, expect, it } from "vitest";
import { chunkInt16, int16FromBase64, int16ToBase64 } from "./audioPipe.mjs";

describe("chunkInt16", () => {
  it("splits an exact multiple into equal chunks", () => {
    const chunks = [...chunkInt16(new Int16Array(2400), 800)];
    expect(chunks.map((c) => c.length)).toEqual([800, 800, 800]);
  });

  it("emits a final partial chunk for remainders", () => {
    const chunks = [...chunkInt16(new Int16Array(1000), 800)];
    expect(chunks.map((c) => c.length)).toEqual([800, 200]);
  });

  it("yields nothing for empty input", () => {
    expect([...chunkInt16(new Int16Array(0), 800)]).toEqual([]);
  });

  it("preserves sample values across chunk boundaries", () => {
    const samples = Int16Array.from({ length: 1000 }, (_, i) => i - 500);
    const chunks = [...chunkInt16(samples, 800)];
    expect(chunks[0][799]).toBe(299);
    expect(chunks[1][0]).toBe(300);
  });
});

describe("int16 base64 round-trip", () => {
  it("round-trips sample data, including negative values", () => {
    const samples = new Int16Array([0, 1, -1, 32767, -32768]);
    const back = int16FromBase64(int16ToBase64(samples));
    expect(Array.from(back)).toEqual(Array.from(samples));
  });

  it("encodes little-endian PCM16 bytes", () => {
    const b64 = int16ToBase64(new Int16Array([258])); // 0x0102 -> bytes 02 01
    expect(Buffer.from(b64, "base64")).toEqual(Buffer.from([0x02, 0x01]));
  });
});
