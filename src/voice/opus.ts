/**
 * Opus encoder/decoder wrapper using @discordjs/opus (optional peer dependency).
 *
 * All audio is 48kHz mono, 20ms frames = 960 samples.
 * Opus is the mandatory codec for Relay voice (same as WebRTC/Discord).
 */

interface OpusEncoderInstance {
  encode(pcm: Buffer): Buffer;
  decode(opus: Buffer): Buffer;
}

const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const FRAME_DURATION_MS = 20;

/** Number of PCM samples per 20ms frame at 48kHz mono */
export const FRAME_SIZE = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 960

/** Size of one frame in bytes (Int16LE = 2 bytes per sample) */
export const FRAME_BYTES = FRAME_SIZE * 2; // 1920

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let OpusEncoderCtor: new (rate: number, channels: number) => OpusEncoderInstance;
let initialized = false;
let encoder: OpusEncoderInstance | null = null;

/** Load the native Opus library. Must be called before encode/decode. */
export async function initOpus(): Promise<void> {
  if (initialized) return;

  try {
    // @discordjs/opus is CJS — dynamic import wraps it
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import('@discordjs/opus') as any;
    OpusEncoderCtor = mod.OpusEncoder ?? mod.default?.OpusEncoder;
    if (!OpusEncoderCtor) {
      throw new Error('OpusEncoder not found in module exports');
    }
    initialized = true;
  } catch (err) {
    throw new Error(
      `Failed to load @discordjs/opus. Install it: pnpm add @discordjs/opus\n${err}`,
    );
  }
}

function getEncoder(): OpusEncoderInstance {
  if (!initialized) throw new Error('Opus not initialized. Call initOpus() first.');
  if (!encoder) {
    encoder = new OpusEncoderCtor(SAMPLE_RATE, CHANNELS);
  }
  return encoder;
}

/** Decode an Opus frame to PCM Int16LE buffer. */
export function decodeOpus(opusFrame: Buffer): Buffer {
  return getEncoder().decode(opusFrame);
}

/** Encode a PCM Int16LE buffer (960 samples) to an Opus frame. */
export function encodeOpus(pcm: Buffer): Buffer {
  return getEncoder().encode(pcm);
}

/** Convert a PCM Buffer (Int16LE) to a typed Int16Array for processing. */
export function pcmToInt16(pcm: Buffer): Int16Array {
  return new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
}

/** Convert an Int16Array back to a Buffer for encoding. */
export function int16ToPcm(samples: Int16Array): Buffer {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}
