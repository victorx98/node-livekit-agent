// PCM16 WAV parsing and utterance assembly for the Gemini latency bench.
// Pure functions, no I/O — tested in wav.test.mjs.

/**
 * Parse a RIFF/WAVE buffer containing 16-bit PCM.
 * Returns { sampleRate, channels, bitsPerSample, samples: Int16Array }.
 * Fails fast with a descriptive error for anything else.
 */
export function parseWav(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("Not a WAV file: missing RIFF header");
  }
  if (buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a WAV file: missing WAVE form type");
  }

  let fmt = null;
  let data = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      if (size < 16) throw new Error("Malformed WAV: fmt chunk too small");
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = buf.subarray(body, body + size);
    }
    // chunks are word-aligned
    off = body + size + (size % 2);
  }

  if (!fmt) throw new Error("Malformed WAV: no fmt chunk");
  if (!data) throw new Error("Malformed WAV: no data chunk");
  // 0xfffe = WAVE_FORMAT_EXTENSIBLE; accept it since the bench only needs PCM16 bytes
  if (fmt.audioFormat !== 1 && fmt.audioFormat !== 0xfffe) {
    throw new Error(`Unsupported WAV encoding ${fmt.audioFormat}: only PCM is supported`);
  }
  if (fmt.bitsPerSample !== 16) {
    throw new Error(`Unsupported WAV bit depth ${fmt.bitsPerSample}: only 16-bit is supported`);
  }

  const sampleCount = Math.floor(data.length / 2);
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) samples[i] = data.readInt16LE(i * 2);

  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    samples,
  };
}

/** Average interleaved channels down to mono. Returns the input untouched when already mono. */
export function toMono(samples, channels) {
  if (channels === 1) return samples;
  const frames = Math.floor(samples.length / channels);
  const out = new Int16Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += samples[f * channels + c];
    out[f] = Math.round(sum / channels);
  }
  return out;
}

/** Linear-interpolation resampler. Fidelity is fine for speech/VAD bench purposes. */
export function resampleLinear(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const outLen = Math.round((samples.length * toRate) / fromRate);
  const out = new Int16Array(outLen);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = pos - i0;
    out[i] = Math.round(samples[i0] * (1 - frac) + samples[i1] * frac);
  }
  return out;
}

export function makeSilence(ms, sampleRate) {
  return new Int16Array(Math.round((ms / 1000) * sampleRate));
}

/**
 * Build an utterance of exactly targetMs by looping the speech sample with
 * gapMs of silence between repeats. Gaps must stay below the server VAD
 * silenceDurationMs so the turn is held open. The result always ends inside
 * a speech block (the trailing block is truncated, never a gap), so the
 * "end of speech" ground truth equals the end of the returned buffer.
 */
export function buildUtterance({ speech, sampleRate, targetMs, gapMs }) {
  if (!speech || speech.length === 0) {
    throw new Error("buildUtterance: speech sample is empty");
  }
  const target = Math.round((targetMs / 1000) * sampleRate);
  const gap = Math.round((gapMs / 1000) * sampleRate);
  const out = new Int16Array(target);

  let pos = 0;
  while (pos < target) {
    const speechTake = Math.min(speech.length, target - pos);
    out.set(speech.subarray(0, speechTake), pos);
    pos += speechTake;
    if (pos >= target) break;
    // Only insert a gap if at least one speech sample fits after it; otherwise
    // fill the remainder with speech so the utterance never ends in silence.
    if (pos + gap >= target) {
      const tail = Math.min(speech.length, target - pos);
      out.set(speech.subarray(0, tail), pos);
      pos += tail;
      break;
    }
    pos += gap; // Int16Array is zero-initialized; the gap is already silence
  }
  return out;
}
