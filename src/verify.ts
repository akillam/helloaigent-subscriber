// Independent envelope verification for the reference subscriber.
// Deliberately does NOT share code with the Hello Aigent server: this package
// re-implements RFC 8785 JCS canonicalization + Ed25519 verification so it
// independently checks what publishers actually serve.

export function jcsCanonicalize(value: unknown): string {
  if (value === undefined) throw new Error('cannot canonicalize undefined');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('cannot canonicalize non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => jcsCanonicalize(v === undefined ? null : v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + jcsCanonicalize(obj[k])).join(',') + '}';
  }
  throw new Error(`cannot canonicalize value of type ${typeof value}`);
}

function b64ToBytes(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, 'base64'));
}

/** Verify a signed envelope against a discovery-file `ed25519:<base64>` public key. */
export async function verifyEnvelope(
  envelope: Record<string, unknown>,
  publicKey: string,
): Promise<boolean> {
  const { signature, ...rest } = envelope;
  if (typeof signature !== 'string' || !signature.startsWith('ed25519:')) return false;
  try {
    const sigBytes = b64ToBytes(signature.slice('ed25519:'.length));
    const key = await crypto.subtle.importKey(
      'raw',
      b64ToBytes(publicKey.replace(/^ed25519:/, '')).buffer as ArrayBuffer,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      'Ed25519',
      key,
      sigBytes.buffer as ArrayBuffer,
      new TextEncoder().encode(jcsCanonicalize(rest)),
    );
  } catch {
    return false;
  }
}
