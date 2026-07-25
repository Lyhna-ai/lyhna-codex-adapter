// Capsule signing — turn a content address into an attributable citation.
//
// `capsule_ref` already answers "what was this unit of work" — it is a content hash, stable and
// collision-resistant. Signing answers a different question: "who folded it, and has it changed
// since." Together they make a capsule_ref something you can paste into notes, a job record, a PR
// comment, or a graph and still resolve years later, on a machine that never met this one.
//
// WHAT A SIGNATURE PROVES (the ceiling, unchanged): that the holder of this key folded this exact
// capsule, and that no byte has changed since. It does NOT make the observations true, and it must
// never be reported as if it did. Lyhna still only records what was observed.
//
// The two identities are deliberately separate:
//   - `capsule_ref` is derived over the capsule WITHOUT `capsule_ref` and WITHOUT `signature`, so
//     it names the work regardless of who attests it. The same fold signed by two different keys
//     has the same capsule_ref — which is what lets a second party counter-sign later.
//   - `signature` covers the capsule WITHOUT `signature`, so it commits to capsule_ref and every
//     field that produced it.
//
// Ed25519 is deterministic per RFC 8032: the same key over the same message yields the same
// signature. Re-rendering a sealed packet therefore reproduces its bytes exactly, which the
// determinism contract requires.
//
// The canonical form is `canonicalJson` — verified byte-identical to the independent `canon()` in
// `lyhna-verify`, so a capsule signed here is checkable by that zero-dependency offline verifier
// without either side importing the other.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { canonicalJson, dataRoot } from './util.mjs';

export const SIGNATURE_ALGORITHM = 'ed25519';
export const DEFAULT_KEY_ID = 'default';

// SPKI DER header for an Ed25519 public key, followed by the 32 raw key bytes. Matching
// lyhna-verify's constant exactly is what lets it consume these public keys unchanged.
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function keyPath(keyId = DEFAULT_KEY_ID) {
  return join(dataRoot(), 'keys', `${keyId}.json`);
}

function rawPublicKeyHex(publicKey) {
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return Buffer.from(der.subarray(der.length - 32)).toString('hex');
}

function publicKeyFromHex(hex) {
  const raw = Buffer.from(hex, 'hex');
  if (raw.length !== 32) throw Object.assign(new Error('INVALID_PUBLIC_KEY'), { code: 'INVALID_PUBLIC_KEY' });
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
}

/**
 * Load this machine's signing key, minting one on first use.
 *
 * The key lives beside the packets in the data root — the simplest thing that works for a local,
 * buy-once tool. There is no recovery: lose the file and future capsules carry a NEW identity while
 * old ones still verify against the public key embedded in them. That is why `exportKey` exists.
 *
 * `keyId` is parameterized now so a per-job or per-project key is a configuration change later
 * rather than a redesign. v0 only ever uses the default.
 */
export function loadOrCreateKeypair(keyId = DEFAULT_KEY_ID) {
  const path = keyPath(keyId);
  if (existsSync(path)) {
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    const privateKey = createPrivateKey({ key: stored.private_key_pem, format: 'pem', type: 'pkcs8' });
    return { key_id: stored.key_id, privateKey, public_key: stored.public_key };
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const record = {
    key_id: keyId,
    algorithm: SIGNATURE_ALGORITHM,
    public_key: rawPublicKeyHex(publicKey),
    private_key_pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  };
  mkdirSync(dirname(path), { recursive: true });
  // Written 0600 and renamed into place: the private key must never exist group/world-readable,
  // not even for the instant between create and chmod.
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flush: true });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  return { key_id: keyId, privateKey, public_key: record.public_key };
}

/** The exact bytes a signature covers: the capsule without its signature block. */
export function signingPayload(capsule) {
  const { signature: _excluded, ...rest } = capsule;
  return Buffer.from(canonicalJson(rest), 'utf8');
}

/** Attach a signature block. Returns a NEW capsule; the input is not mutated. */
export function signCapsule(capsule, keypair) {
  const signature = edSign(null, signingPayload(capsule), keypair.privateKey);
  return {
    ...capsule,
    signature: {
      algorithm: SIGNATURE_ALGORITHM,
      key_id: keypair.key_id,
      public_key: keypair.public_key,
      signature: signature.toString('hex')
    }
  };
}

/**
 * Verify a capsule's signature against the public key carried inside it.
 *
 * Trust-on-first-use by design: the embedded key says "the same holder folded every capsule that
 * carries this key," which is exactly the continuity a chain of windows needs. It does NOT say the
 * holder is anyone in particular. A caller that cares about identity must pin the key itself.
 */
export function verifyCapsuleSignature(capsule) {
  const block = capsule?.signature;
  if (!block) return { ok: false, reason: 'no signature block', key_id: null, public_key: null };
  if (block.algorithm !== SIGNATURE_ALGORITHM) {
    return { ok: false, reason: `unsupported algorithm ${block.algorithm}`, key_id: block.key_id ?? null, public_key: block.public_key ?? null };
  }
  let publicKey;
  try {
    publicKey = publicKeyFromHex(block.public_key);
  } catch {
    return { ok: false, reason: 'embedded public key is malformed', key_id: block.key_id ?? null, public_key: block.public_key ?? null };
  }
  let ok = false;
  try {
    ok = edVerify(null, signingPayload(capsule), publicKey, Buffer.from(block.signature, 'hex'));
  } catch {
    ok = false;
  }
  return {
    ok,
    reason: ok ? 'signature verifies against the embedded public key' : 'signature does not verify',
    key_id: block.key_id ?? null,
    public_key: block.public_key ?? null
  };
}

/** Portable key material, for deliberately carrying an identity to a new machine. */
export function exportKey(keyId = DEFAULT_KEY_ID) {
  const path = keyPath(keyId);
  if (!existsSync(path)) throw Object.assign(new Error('KEY_NOT_FOUND'), { code: 'KEY_NOT_FOUND' });
  return readFileSync(path, 'utf8');
}

/** Install key material exported from another machine. Refuses to overwrite an existing key. */
export function importKey(material, { keyId = DEFAULT_KEY_ID, overwrite = false } = {}) {
  const record = typeof material === 'string' ? JSON.parse(material) : material;
  if (record.algorithm !== SIGNATURE_ALGORITHM) throw Object.assign(new Error('UNSUPPORTED_KEY_ALGORITHM'), { code: 'UNSUPPORTED_KEY_ALGORITHM' });
  const privateKey = createPrivateKey({ key: record.private_key_pem, format: 'pem', type: 'pkcs8' });
  const derived = rawPublicKeyHex(createPublicKey(privateKey));
  if (derived !== record.public_key) throw Object.assign(new Error('KEY_MATERIAL_INCONSISTENT'), { code: 'KEY_MATERIAL_INCONSISTENT' });
  const path = keyPath(keyId);
  if (existsSync(path) && !overwrite) throw Object.assign(new Error('KEY_ALREADY_EXISTS'), { code: 'KEY_ALREADY_EXISTS' });
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ ...record, key_id: keyId }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flush: true });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  return { key_id: keyId, public_key: record.public_key };
}
