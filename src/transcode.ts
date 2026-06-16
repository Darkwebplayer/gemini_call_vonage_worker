// Gemini (24kHz PCM16) -> Vonage (16kHz PCM16) only. Inbound needs no transcode.
//
// 24000 -> 16000 is a 3:2 ratio. Linear interpolation between neighbouring
// samples is plenty for voice. Output MUST leave this re-chunked into exact
// 640-byte (320-sample, 20ms @ 16kHz) frames — partial/oversized frames risk
// Vonage disconnects. State is carried across push() calls so interpolation
// and framing stay continuous over a stream of chunks.

const OUT_SAMPLES_PER_FRAME = 320; // 20ms @ 16kHz
const OUT_FRAME_BYTES = 640; // 320 * 2
const STEP = 24000 / 16000; // 1.5 input samples per output sample

function clamp16(n: number): number {
  return n < -32768 ? -32768 : n > 32767 ? 32767 : n;
}

export class Downsampler {
  private prev = 0; // last input sample of the previous chunk
  private havePrev = false;
  private pos = 0; // fractional read position into [prev, ...input]
  private buf: number[] = []; // pending output samples awaiting a full frame

  /** Drop all buffered/in-flight output. Call on barge-in. */
  reset(): void {
    this.buf.length = 0;
    this.havePrev = false;
    this.pos = 0;
  }

  /** Feed one chunk of 24kHz PCM16 samples; get back complete 640-byte frames. */
  push(input: Int16Array): Uint8Array[] {
    const samples = this.havePrev ? input.length + 1 : input.length;
    const get = (i: number) =>
      this.havePrev ? (i === 0 ? this.prev : input[i - 1]) : input[i];

    // Emit while both interpolation neighbours exist.
    while (this.pos < samples - 1) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = get(i);
      const b = get(i + 1);
      this.buf.push(Math.round(a + (b - a) * frac));
      this.pos += STEP;
    }

    if (input.length > 0) {
      this.prev = input[input.length - 1];
      this.havePrev = true;
      this.pos -= samples - 1; // rebase position relative to the carried sample
    }

    return this.flush();
  }

  private flush(): Uint8Array[] {
    const frames: Uint8Array[] = [];
    while (this.buf.length >= OUT_SAMPLES_PER_FRAME) {
      const chunk = this.buf.splice(0, OUT_SAMPLES_PER_FRAME);
      const frame = new Uint8Array(OUT_FRAME_BYTES);
      const dv = new DataView(frame.buffer);
      for (let i = 0; i < OUT_SAMPLES_PER_FRAME; i++) {
        dv.setInt16(i * 2, clamp16(chunk[i]), true); // little-endian
      }
      frames.push(frame);
    }
    return frames;
  }
}

// --- node-only self-check: `node --experimental-strip-types src/transcode.ts`
export function selfCheck(): void {
  const N = 24000; // 1s @ 24kHz
  const input = new Int16Array(N);
  for (let i = 0; i < N; i++) input[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 24000));

  // Single chunk.
  const a = new Downsampler().push(input);
  // Split into uneven chunks — must yield the same frame count (continuity).
  const d = new Downsampler();
  const b = [...d.push(input.subarray(0, 1000)), ...d.push(input.subarray(1000, 1003)), ...d.push(input.subarray(1003))];

  const samples = a.length * OUT_SAMPLES_PER_FRAME;
  console.assert(a.every((f) => f.length === 640), "every frame must be 640 bytes");
  console.assert(Math.abs(samples - 16000) <= OUT_SAMPLES_PER_FRAME, `~16000 samples, got ${samples}`);
  console.assert(a.length === b.length, `chunked framing must match: ${a.length} vs ${b.length}`);
  console.log(`ok: ${a.length} frames, ${samples} samples @ 16kHz`);
}

// @ts-ignore -- process is node-only; absent in the Worker runtime.
if (typeof process !== "undefined" && process.argv?.[1]?.includes("transcode")) selfCheck();
