/**
 * RTP packet parsing and construction (RFC 3550).
 *
 * mediasoup PlainTransport sends/receives raw RTP over UDP.
 * These utilities extract Opus payloads from incoming packets
 * and construct RTP packets for outgoing Opus frames.
 */

export interface RtpHeader {
  payloadType: number;
  sequenceNumber: number;
  timestamp: number;
  ssrc: number;
  marker: boolean;
}

export interface RtpPacket {
  header: RtpHeader;
  payload: Buffer;
}

/** Parse an RTP packet from a raw UDP buffer. Returns null if malformed. */
export function parseRtpPacket(buf: Buffer): RtpPacket | null {
  if (buf.length < 12) return null;

  const firstByte = buf[0]!;
  const version = (firstByte >> 6) & 0x03;
  if (version !== 2) return null;

  const hasPadding = (firstByte >> 5) & 0x01;
  const hasExtension = (firstByte >> 4) & 0x01;
  const csrcCount = firstByte & 0x0f;

  const secondByte = buf[1]!;
  const marker = ((secondByte >> 7) & 0x01) === 1;
  const payloadType = secondByte & 0x7f;

  const sequenceNumber = buf.readUInt16BE(2);
  const timestamp = buf.readUInt32BE(4);
  const ssrc = buf.readUInt32BE(8);

  let headerLength = 12 + csrcCount * 4;

  if (hasExtension && buf.length >= headerLength + 4) {
    const extensionLength = buf.readUInt16BE(headerLength + 2);
    headerLength += 4 + extensionLength * 4;
  }

  if (buf.length <= headerLength) return null;

  let payloadLength = buf.length - headerLength;

  if (hasPadding && payloadLength > 0) {
    const paddingLength = buf[buf.length - 1]!;
    payloadLength -= paddingLength;
    if (payloadLength < 0) return null;
  }

  return {
    header: { payloadType, sequenceNumber, timestamp, ssrc, marker },
    payload: Buffer.from(buf.subarray(headerLength, headerLength + payloadLength)),
  };
}

/** Build an RTP packet from a header and Opus payload. */
export function buildRtpPacket(header: RtpHeader, payload: Buffer): Buffer {
  const buf = Buffer.alloc(12 + payload.length);

  buf[0] = 0x80; // Version 2, no padding, no extension, no CSRC
  buf[1] = (header.marker ? 0x80 : 0x00) | (header.payloadType & 0x7f);
  buf.writeUInt16BE(header.sequenceNumber & 0xffff, 2);
  buf.writeUInt32BE(header.timestamp >>> 0, 4);
  buf.writeUInt32BE(header.ssrc >>> 0, 8);

  payload.copy(buf, 12);
  return buf;
}

/**
 * Stateful RTP sender — auto-increments sequence number and timestamp.
 * Randomizes initial state per RFC 3550.
 */
export class RtpSender {
  private sequenceNumber: number;
  private timestamp: number;
  private lastPackWallMs: number | null = null;

  constructor(
    public readonly ssrc: number,
    public readonly payloadType: number,
    public readonly clockRate: number = 48000,
  ) {
    this.sequenceNumber = Math.floor(Math.random() * 0xffff);
    this.timestamp = Math.floor(Math.random() * 0xffffffff);
  }

  /**
   * Create an RTP packet, advancing sequence and timestamp automatically.
   *
   * Steady streaming: timestamp advances by exactly one frame
   * (`clockRate * frameDurationMs / 1000`) per pack — e.g. +960 at
   * 48kHz/20ms. When the sender has been dormant (gap between calls
   * > 2.5 × frameDurationMs, i.e. ~50ms at 20ms frames), the timestamp
   * fast-forwards to match the wall-clock gap so the resumed packet's
   * timestamp reflects real elapsed time. Without this, an intermittent
   * producer (bot that only sends while echoing utterances) emits
   * packets whose timestamps imply they should play back-to-back even
   * though they arrive seconds apart — receivers' NetEq reads that as
   * extreme jitter and inflates the target buffer depth by the dormancy
   * window, delaying playback by that same amount. The SFU eventually
   * times out the producer.
   */
  pack(opusFrame: Buffer, frameDurationMs = 20): Buffer {
    const frameSamples = Math.floor((this.clockRate * frameDurationMs) / 1000);
    const now = Date.now();

    if (this.lastPackWallMs !== null) {
      const gapMs = now - this.lastPackWallMs;
      if (gapMs > frameDurationMs * 2.5) {
        // Dormant. Fast-forward timestamp to match wall-clock, leaving
        // one frame so the end-of-pack increment below keeps cadence.
        const skipMs = gapMs - frameDurationMs;
        const skipSamples = Math.floor((this.clockRate * skipMs) / 1000);
        this.timestamp = (this.timestamp + skipSamples) >>> 0;
      }
    }
    this.lastPackWallMs = now;

    const header: RtpHeader = {
      payloadType: this.payloadType,
      sequenceNumber: this.sequenceNumber,
      timestamp: this.timestamp,
      ssrc: this.ssrc,
      marker: false,
    };

    const packet = buildRtpPacket(header, opusFrame);

    this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
    this.timestamp = (this.timestamp + frameSamples) >>> 0;

    return packet;
  }
}
