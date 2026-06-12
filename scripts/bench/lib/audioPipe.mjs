// Chunking, encoding, and real-time pacing of PCM16 audio for the bench.
// chunkInt16 / base64 helpers are pure (tested); Pacer does timing I/O.

export function* chunkInt16(samples, samplesPerChunk) {
  for (let off = 0; off < samples.length; off += samplesPerChunk) {
    yield samples.subarray(off, Math.min(off + samplesPerChunk, samples.length));
  }
}

export function int16ToBase64(samples) {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString("base64");
}

export function int16FromBase64(b64) {
  const buf = Buffer.from(b64, "base64");
  const out = new Int16Array(buf.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Continuously emits 16k mono PCM in real time, mimicking a live microphone:
 * silence by default, with utterances queued on top. The production path
 * streams mic audio (including silence) nonstop, so the bench must too —
 * server-side VAD needs the trailing silence to detect end of speech.
 *
 * onChunk(samples, meta) is called once per chunkMs with meta.isSpeech and,
 * on the last speech-bearing chunk of an utterance, meta.speechEnd = true.
 */
export class Pacer {
  constructor({ sampleRate = 16000, chunkMs = 50, onChunk }) {
    this.sampleRate = sampleRate;
    this.chunkMs = chunkMs;
    this.samplesPerChunk = Math.round((sampleRate * chunkMs) / 1000);
    this.onChunk = onChunk;
    this.queue = []; // pending speech chunks (Int16Array each)
    this.silence = new Int16Array(this.samplesPerChunk);
    this.running = false;
    this.utteranceDone = null; // resolver for the in-flight utterance
  }

  /** Queue an utterance; resolves with the wall-clock ms when its last chunk was emitted. */
  enqueueUtterance(samples) {
    if (this.utteranceDone) {
      throw new Error("Pacer: an utterance is already in flight");
    }
    this.queue = [...chunkInt16(samples, this.samplesPerChunk)];
    if (this.queue.length === 0) throw new Error("Pacer: utterance is empty");
    return new Promise((resolve) => {
      this.utteranceDone = resolve;
    });
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      // Drift-corrected pacing: schedule against the ideal timeline, not the
      // previous tick, so a slow onChunk does not slow the audio clock.
      const startedAt = Date.now();
      let tick = 0;
      while (this.running) {
        const speech = this.queue.shift();
        const isLastSpeechChunk = speech !== undefined && this.queue.length === 0;
        this.onChunk(speech ?? this.silence, {
          isSpeech: speech !== undefined,
          speechEnd: isLastSpeechChunk,
        });
        if (isLastSpeechChunk && this.utteranceDone) {
          const resolve = this.utteranceDone;
          this.utteranceDone = null;
          resolve(Date.now());
        }
        tick += 1;
        const nextAt = startedAt + tick * this.chunkMs;
        const wait = nextAt - Date.now();
        if (wait > 0) await sleep(wait);
      }
    })();
  }

  async stop() {
    this.running = false;
    await this.loop;
  }
}
