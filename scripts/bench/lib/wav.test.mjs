import { describe, expect, it } from "vitest";
import {
  buildUtterance,
  makeSilence,
  parseWav,
  resampleLinear,
  toMono,
} from "./wav.mjs";

/** Build a minimal RIFF/WAVE buffer around the given PCM16 samples. */
function makeWavBuffer({
  sampleRate = 16000,
  channels = 1,
  bitsPerSample = 16,
  samples = new Int16Array([1, 2, 3, 4]),
  audioFormat = 1,
  extraChunk = null, // { id: 'LIST', body: Buffer } inserted before data
} = {}) {
  const dataBytes = samples.length * 2;
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(audioFormat, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 16);
  fmt.writeUInt16LE((channels * bitsPerSample) / 8, 20);
  fmt.writeUInt16LE(bitsPerSample, 22);

  let extra = Buffer.alloc(0);
  if (extraChunk) {
    const header = Buffer.alloc(8);
    header.write(extraChunk.id, 0, "ascii");
    header.writeUInt32LE(extraChunk.body.length, 4);
    extra = Buffer.concat([header, extraChunk.body]);
  }

  const dataHeader = Buffer.alloc(8);
  dataHeader.write("data", 0, "ascii");
  dataHeader.writeUInt32LE(dataBytes, 4);
  const dataBody = Buffer.alloc(dataBytes);
  for (let i = 0; i < samples.length; i++) dataBody.writeInt16LE(samples[i], i * 2);

  const content = Buffer.concat([Buffer.from("WAVE", "ascii"), fmt, extra, dataHeader, dataBody]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(content.length, 4);
  return Buffer.concat([riff, content]);
}

describe("parseWav", () => {
  it("parses a 16-bit PCM mono wav", () => {
    const buf = makeWavBuffer({ samples: new Int16Array([10, -20, 30, -32768]) });
    const wav = parseWav(buf);
    expect(wav.sampleRate).toBe(16000);
    expect(wav.channels).toBe(1);
    expect(wav.bitsPerSample).toBe(16);
    expect(Array.from(wav.samples)).toEqual([10, -20, 30, -32768]);
  });

  it("parses a stereo wav and reports two channels", () => {
    const buf = makeWavBuffer({ channels: 2, samples: new Int16Array([100, 200, 300, 400]) });
    const wav = parseWav(buf);
    expect(wav.channels).toBe(2);
    expect(wav.samples.length).toBe(4);
  });

  it("skips unknown chunks (e.g. LIST) before the data chunk", () => {
    const buf = makeWavBuffer({
      samples: new Int16Array([7, 8]),
      extraChunk: { id: "LIST", body: Buffer.from("INFOsoftware") },
    });
    const wav = parseWav(buf);
    expect(Array.from(wav.samples)).toEqual([7, 8]);
  });

  it("accepts an empty data chunk", () => {
    const buf = makeWavBuffer({ samples: new Int16Array(0) });
    expect(parseWav(buf).samples.length).toBe(0);
  });

  it("rejects a non-RIFF buffer", () => {
    expect(() => parseWav(Buffer.from("not a wav file at all......"))).toThrow(/RIFF/);
  });

  it("rejects non-PCM encodings", () => {
    const buf = makeWavBuffer({ audioFormat: 3 }); // IEEE float
    expect(() => parseWav(buf)).toThrow(/PCM/);
  });

  it("rejects non-16-bit samples", () => {
    const buf = makeWavBuffer({ bitsPerSample: 8 });
    expect(() => parseWav(buf)).toThrow(/16-bit/);
  });

  it("rejects a truncated header", () => {
    expect(() => parseWav(Buffer.from("RIFF"))).toThrow();
  });
});

describe("toMono", () => {
  it("returns mono input unchanged", () => {
    const s = new Int16Array([1, 2, 3]);
    expect(toMono(s, 1)).toBe(s);
  });

  it("averages interleaved stereo frames", () => {
    const s = new Int16Array([100, 200, -100, 100]);
    expect(Array.from(toMono(s, 2))).toEqual([150, 0]);
  });
});

describe("resampleLinear", () => {
  it("is identity when rates match", () => {
    const s = new Int16Array([5, 6, 7]);
    expect(resampleLinear(s, 16000, 16000)).toBe(s);
  });

  it("halves the sample count when downsampling 32k -> 16k", () => {
    const s = new Int16Array(3200); // 100ms at 32k
    const out = resampleLinear(s, 32000, 16000);
    expect(out.length).toBe(1600); // 100ms at 16k
  });

  it("preserves a constant signal", () => {
    const s = new Int16Array(4410).fill(1000); // 100ms at 44.1k
    const out = resampleLinear(s, 44100, 16000);
    expect(out.length).toBe(1600);
    for (const v of out) expect(v).toBe(1000);
  });
});

describe("makeSilence", () => {
  it("produces the right sample count", () => {
    expect(makeSilence(50, 16000).length).toBe(800);
    expect(makeSilence(0, 16000).length).toBe(0);
  });
});

describe("buildUtterance", () => {
  const sampleRate = 16000;
  // 100ms of "speech" (non-zero so it is distinguishable from gap silence)
  const speech = new Int16Array(1600).fill(1234);

  it("truncates when the target is shorter than the sample", () => {
    const out = buildUtterance({ speech, sampleRate, targetMs: 50, gapMs: 30 });
    expect(out.length).toBe(800);
    expect(out[0]).toBe(1234);
  });

  it("returns the sample as-is when target equals the sample duration", () => {
    const out = buildUtterance({ speech, sampleRate, targetMs: 100, gapMs: 30 });
    expect(out.length).toBe(1600);
    expect(Array.from(out)).toEqual(Array.from(speech));
  });

  it("loops speech with silence gaps to reach the target duration", () => {
    // 100ms speech + 30ms gap + 100ms speech = 230ms total
    const out = buildUtterance({ speech, sampleRate, targetMs: 230, gapMs: 30 });
    expect(out.length).toBe(Math.round((230 / 1000) * sampleRate));
    expect(out[0]).toBe(1234); // first speech block
    expect(out[1600]).toBe(0); // gap
    expect(out[1600 + 480]).toBe(1234); // second speech block after 30ms gap
    expect(out[out.length - 1]).toBe(1234); // ends inside speech, not gap
  });

  it("rejects an empty speech sample", () => {
    expect(() =>
      buildUtterance({ speech: new Int16Array(0), sampleRate, targetMs: 100, gapMs: 30 }),
    ).toThrow(/empty/i);
  });
});
