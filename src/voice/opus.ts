/**
 * Opus encoder/decoder wrapper using @discordjs/opus (optional peer dependency).
 *
 * 48kHz STEREO, 20ms frames.
 *
 * The mediasoup router on the Rust signaling server is pinned to Opus@2ch
 * (see `crates/signaling-server/src/media/workers.rs:240`). mediasoup-rust's
 * codec matcher at `mediasoup-0.20.0/src/ortc.rs:1055` does strict equality
 * on the `channels` field — a mono producer is rejected as "Unsupported
 * codec". Bots therefore encode and decode stereo Opus, and feed stereo
 * interleaved Int16LE PCM to `encodeOpus`.
 *
 * Frame math:
 *   48000 Hz × 0.020 s = 960 samples per channel per 20ms frame
 *   960 samples × 2 channels = 1920 interleaved samples per frame
 *   1920 samples × 2 bytes   = 3840 bytes per frame (Int16LE)
 */

interface OpusEncoderInstance {
  encode(pcm: Buffer): Buffer;
  decode(opus: Buffer): Buffer;
}

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_DURATION_MS = 20;

/** Number of PCM samples per 20ms frame PER CHANNEL at 48kHz. */
export const FRAME_SAMPLES_PER_CHANNEL = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 960

/**
 * Legacy alias — kept for back-compat with existing bot code. Has the same
 * value as `FRAME_SAMPLES_PER_CHANNEL` because that was the meaning in the
 * mono-only v1 of this module.
 */
export const FRAME_SIZE = FRAME_SAMPLES_PER_CHANNEL;

/** Size of one 20ms frame in bytes (Int16LE, stereo interleaved). */
export const FRAME_BYTES = FRAME_SAMPLES_PER_CHANNEL * CHANNELS * 2; // 3840

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

/** Decode an Opus frame to PCM Int16LE buffer (stereo interleaved, 3840 bytes). */
export function decodeOpus(opusFrame: Buffer): Buffer {
  return getEncoder().decode(opusFrame);
}

/**
 * Encode a PCM Int16LE stereo-interleaved buffer (3840 bytes, 960 frames per
 * channel) to an Opus frame.
 */
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
