/**
 * E2EE frame decryption for bots — DAVE protocol (AES-128-GCM).
 *
 * Bots receive encrypted Opus frames from the SFU via RTP. The server
 * distributes epoch secrets in VOICE_READY and E2EE_KEY_UPDATE events.
 * This module decrypts incoming frames so bots can decode the Opus audio.
 *
 * Frame format: [TOC byte (1B) | ciphertext | GCM tag (8B)]
 * Key derivation: HKDF-SHA256(secret, salt="relay-e2ee-v1", info="sender:{id}")
 * IV: SHA256(senderId)[:4] + frameCounter(BE64) = 12 bytes
 * Tag: 8 bytes (native tagLength: 64)
 *
 * Frame counter is monotonically increasing — never resets on epoch change.
 */

import { createHash, createHmac, createCipheriv, createDecipheriv } from 'node:crypto';

const UNENCRYPTED_BYTES = 1;
const GCM_TAG_LENGTH = 8;
const IV_LENGTH = 12;
const KEY_LENGTH = 16; // AES-128

/** Per-sender decryption state. */
export class E2EEDecryptor {
  private key: Buffer | null = null;
  private prevKey: Buffer | null = null;
  private senderHash: Buffer; // 4 bytes
  private frameCounter = 0;
  private initialized = false;

  constructor(private readonly senderId: string) {
    this.senderHash = hashSenderId(senderId);
  }

  /** Initialize with epoch secret. */
  init(epochSecret: string): void {
    this.key = deriveKey(epochSecret, this.senderId);
    this.prevKey = null;
    this.frameCounter = 0;
    this.initialized = true;
  }

  /** Update keys on epoch rotation. Previous key kept for transition window. */
  updateKeys(newSecret: string): void {
    this.prevKey = this.key;
    this.key = deriveKey(newSecret, this.senderId);
    // Frame counter is NOT reset — monotonically increasing
  }

  /** Clear all key material. */
  destroy(): void {
    if (this.key) { this.key.fill(0); this.key = null; }
    if (this.prevKey) { this.prevKey.fill(0); this.prevKey = null; }
    this.initialized = false;
    this.frameCounter = 0;
  }

  /**
   * Decrypt an E2EE Opus frame in-place.
   * Returns decrypted frame (TOC + plaintext) or null on auth failure.
   */
  decrypt(frame: Buffer): Buffer | null {
    if (!this.initialized || !this.key) return null;

    // Minimum: header(1) + at least 1 byte ciphertext + tag(8) = 10
    if (frame.length < UNENCRYPTED_BYTES + 1 + GCM_TAG_LENGTH) return null;

    const header = frame.subarray(0, UNENCRYPTED_BYTES);
    const ciphertextWithTag = frame.subarray(UNENCRYPTED_BYTES);
    const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - GCM_TAG_LENGTH);
    const tag = ciphertextWithTag.subarray(ciphertextWithTag.length - GCM_TAG_LENGTH);

    const iv = buildIV(this.senderHash, this.frameCounter++);

    // Try current key
    let plaintext = tryDecrypt(this.key, iv, header, ciphertext, tag);

    // Fallback to previous key (epoch transition window)
    if (!plaintext && this.prevKey) {
      plaintext = tryDecrypt(this.prevKey, iv, header, ciphertext, tag);
    }

    if (!plaintext) return null;

    // Reconstruct: [header | plaintext]
    return Buffer.concat([header, plaintext]);
  }
}

// ─── Outgoing Encryption ────────────────────────────────────────────

/**
 * Per-bot outgoing E2EE encryptor. Mirrors the client's
 * `createEncryptionContext` from `packages/client/src/lib/e2ee/crypto.ts`.
 *
 * Frame format matches the decrypt side exactly:
 *   output = [TOC byte (1B) | AES-128-GCM ciphertext | GCM tag (8B)]
 *   AAD    = TOC byte
 *   IV     = SHA256(senderId)[:4] + frameCounter(BE64) = 12 bytes
 *
 * Frame counter is monotonically increasing — never resets on epoch
 * change. Since the key changes with each epoch, (key, IV) uniqueness
 * is maintained.
 */
export class E2EEEncryptor {
  private key: Buffer | null = null;
  private senderHash: Buffer;
  private frameCounter = 0;
  private initialized = false;

  constructor(private readonly senderId: string) {
    this.senderHash = hashSenderId(senderId);
  }

  /** Initialize with epoch secret from VOICE_READY. */
  init(epochSecret: string): void {
    this.key = deriveKey(epochSecret, this.senderId);
    this.frameCounter = 0;
    this.initialized = true;
  }

  /** Update key on epoch rotation (E2EE_KEY_UPDATE). */
  updateKey(newSecret: string): void {
    this.key = deriveKey(newSecret, this.senderId);
    // Frame counter is NOT reset — monotonically increasing
  }

  /** Clear all key material. */
  destroy(): void {
    if (this.key) { this.key.fill(0); this.key = null; }
    this.initialized = false;
    this.frameCounter = 0;
  }

  /**
   * Encrypt an Opus frame for E2EE transmission.
   * Returns the encrypted frame: [TOC(1B) | ciphertext | tag(8B)].
   * Returns null if the encryptor is not initialized.
   */
  encrypt(frame: Buffer): Buffer | null {
    if (!this.initialized || !this.key) return null;
    if (frame.length < UNENCRYPTED_BYTES + 1) return null; // at least TOC + 1 byte payload

    const header = frame.subarray(0, UNENCRYPTED_BYTES);
    const payload = frame.subarray(UNENCRYPTED_BYTES);
    const iv = buildIV(this.senderHash, this.frameCounter++);

    try {
      const cipher = createCipheriv('aes-128-gcm', this.key, iv, { authTagLength: GCM_TAG_LENGTH });
      cipher.setAAD(header);
      const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
      const tag = cipher.getAuthTag();

      // [header | ciphertext | tag(8B)]
      return Buffer.concat([header, ciphertext, tag]);
    } catch {
      return null;
    }
  }
}

// ─── Key Management (multi-sender) ──────────────────────────────────

/** Manages per-sender E2EE decryptors for a voice channel. */
export class E2EEKeyManager {
  private decryptors = new Map<string, E2EEDecryptor>();
  private epochSecret: string | null = null;

  /** Set initial keys from VOICE_READY. */
  setKeys(epochSecret: string): void {
    this.epochSecret = epochSecret;
    // Existing decryptors get the new key
    for (const dec of this.decryptors.values()) {
      dec.init(epochSecret);
    }
  }

  /** Update keys from E2EE_KEY_UPDATE. */
  updateKeys(epochSecret: string): void {
    this.epochSecret = epochSecret;
    for (const dec of this.decryptors.values()) {
      dec.updateKeys(epochSecret);
    }
  }

  /** Get or create a decryptor for a sender. */
  getDecryptor(senderId: string): E2EEDecryptor {
    let dec = this.decryptors.get(senderId);
    if (!dec) {
      dec = new E2EEDecryptor(senderId);
      if (this.epochSecret) {
        dec.init(this.epochSecret);
      }
      this.decryptors.set(senderId, dec);
    }
    return dec;
  }

  /** Remove a sender's decryptor (user left voice). */
  removeSender(senderId: string): void {
    const dec = this.decryptors.get(senderId);
    if (dec) {
      dec.destroy();
      this.decryptors.delete(senderId);
    }
  }

  /** Clean up all decryptors. */
  destroy(): void {
    for (const dec of this.decryptors.values()) {
      dec.destroy();
    }
    this.decryptors.clear();
    this.epochSecret = null;
  }
}

// ─── Crypto Primitives ──────────────────────────────────────────────

function hexToBytes(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

function hashSenderId(senderId: string): Buffer {
  const hash = createHash('sha256').update(senderId).digest();
  return hash.subarray(0, 4);
}

/**
 * Derive a per-sender AES-128 key via HKDF-SHA256.
 * Must match crypto.ts (client) and crypto.cpp (C++ engine):
 *   salt = "relay-e2ee-v1", info = "sender:{senderId}"
 */
function deriveKey(epochSecret: string, senderId: string): Buffer {
  const secretBytes = hexToBytes(epochSecret);
  const salt = Buffer.from('relay-e2ee-v1');
  const info = Buffer.from(`sender:${senderId}`);

  // HKDF: extract then expand (RFC 5869)
  const prk = createHmac('sha256', salt).update(secretBytes).digest();
  // Expand: single round (we need 16 bytes < 32 = hash length, so T(1) suffices)
  const t1 = createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest();

  return t1.subarray(0, KEY_LENGTH);
}

function buildIV(senderHash: Buffer, frameCounter: number): Buffer {
  const iv = Buffer.alloc(IV_LENGTH);
  senderHash.copy(iv, 0, 0, 4);
  // Big-endian uint64
  iv.writeUInt32BE(Math.floor(frameCounter / 0x100000000), 4);
  iv.writeUInt32BE(frameCounter >>> 0, 8);
  return iv;
}

function tryDecrypt(
  key: Buffer,
  iv: Buffer,
  header: Buffer,
  ciphertext: Buffer,
  tag: Buffer,
): Buffer | null {
  try {
    // authTagLength: 8 tells Node.js to accept the truncated 8-byte GCM tag
    const decipher = createDecipheriv('aes-128-gcm', key, iv, { authTagLength: GCM_TAG_LENGTH });
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext;
  } catch {
    return null;
  }
}
