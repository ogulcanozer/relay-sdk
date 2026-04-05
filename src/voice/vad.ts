/**
 * Voice Activity Detection — energy-based RMS.
 *
 * Detects speech segments by measuring frame energy against a configurable
 * dBFS threshold. Returns completed speech segments (concatenated PCM)
 * when silence exceeds the duration threshold.
 *
 * Simple but effective for echo/recording bots. Future: replace with
 * WebRTC VAD (libfvad) or ML-based (Silero) for production STT.
 */

export interface VADOptions {
  /** Silence threshold in dBFS. Default: -40 (fairly sensitive) */
  silenceThresholdDb?: number;
  /** Silence duration to end a segment (ms). Default: 1500 */
  silenceDurationMs?: number;
  /** Minimum speech duration to emit (ms). Default: 200 */
  minSpeechDurationMs?: number;
  /** Maximum segment duration before force-emit (ms). Default: 30000 */
  maxSegmentDurationMs?: number;
  /** Audio sample rate. Default: 48000 */
  sampleRate?: number;
}

const DEFAULTS = {
  silenceThresholdDb: -40,
  silenceDurationMs: 1500,
  minSpeechDurationMs: 200,
  maxSegmentDurationMs: 30000,
  sampleRate: 48000,
} as const;

export class VoiceActivityDetector {
  private readonly silenceThresholdLinear: number;
  private readonly silenceDurationMs: number;
  private readonly minSpeechDurationMs: number;
  private readonly maxSegmentDurationMs: number;

  private isSpeaking = false;
  private silenceStartMs = 0;
  private speechStartMs = 0;
  private frames: Int16Array[] = [];
  private totalSamples = 0;

  constructor(options?: VADOptions) {
    const o = { ...DEFAULTS, ...options };
    this.silenceThresholdLinear = Math.pow(10, o.silenceThresholdDb / 20) * 32768;
    this.silenceDurationMs = o.silenceDurationMs;
    this.minSpeechDurationMs = o.minSpeechDurationMs;
    this.maxSegmentDurationMs = o.maxSegmentDurationMs;
  }

  /**
   * Feed one PCM frame (20ms at 48kHz mono = 960 samples).
   * Returns a completed speech segment, or null if still accumulating.
   */
  feed(pcm: Int16Array, timestampMs: number): Int16Array | null {
    const energy = rmsEnergy(pcm);
    const silent = energy < this.silenceThresholdLinear;

    if (!silent) {
      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.speechStartMs = timestampMs;
        this.frames = [];
        this.totalSamples = 0;
      }
      this.silenceStartMs = 0;
      this.frames.push(new Int16Array(pcm));
      this.totalSamples += pcm.length;

      if (timestampMs - this.speechStartMs >= this.maxSegmentDurationMs) {
        return this.emit();
      }
      return null;
    }

    // Silent frame
    if (this.isSpeaking) {
      this.frames.push(new Int16Array(pcm));
      this.totalSamples += pcm.length;

      if (this.silenceStartMs === 0) {
        this.silenceStartMs = timestampMs;
      }

      if (timestampMs - this.silenceStartMs >= this.silenceDurationMs) {
        const speechDuration = this.silenceStartMs - this.speechStartMs;
        if (speechDuration >= this.minSpeechDurationMs) {
          return this.emit();
        }
        this.reset();
      }
    }

    return null;
  }

  reset(): void {
    this.isSpeaking = false;
    this.silenceStartMs = 0;
    this.speechStartMs = 0;
    this.frames = [];
    this.totalSamples = 0;
  }

  get speaking(): boolean {
    return this.isSpeaking;
  }

  private emit(): Int16Array {
    const result = new Int16Array(this.totalSamples);
    let offset = 0;
    for (const frame of this.frames) {
      result.set(frame, offset);
      offset += frame.length;
    }
    this.reset();
    return result;
  }
}

function rmsEnergy(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i]!;
    sum += s * s;
  }
  return Math.sqrt(sum / pcm.length);
}
