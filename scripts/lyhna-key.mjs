#!/usr/bin/env node
// Manage the local capsule-signing identity.
//
//   node scripts/lyhna-key.mjs show              print the public key (safe to share)
//   node scripts/lyhna-key.mjs export > key.json copy this machine's identity out
//   node scripts/lyhna-key.mjs import < key.json install an identity on a new machine
//
// There is no recovery. Lose the key file and future capsules carry a NEW identity; capsules
// already folded still verify against the public key embedded in them, but nothing links the old
// identity to the new one. Export is how you keep an identity across machines deliberately.
//
// The exported file contains a PRIVATE KEY. Treat it like an SSH key.

import { readFileSync } from 'node:fs';
import { exportKey, importKey, keyPath, keyProtection, loadOrCreateKeypair } from '../plugins/lyhna/src/signing.mjs';

const [command, keyId = 'default'] = process.argv.slice(2);

try {
  if (command === 'show') {
    const keypair = loadOrCreateKeypair(keyId);
    process.stdout.write(
      `key_id:     ${keypair.key_id}\n`
      + `public_key: ${keypair.public_key}\n`
      + `stored_at:  ${keyPath(keyId)}\n`
      + `protection: ${keyProtection().statement}\n`
    );
  } else if (command === 'export') {
    process.stdout.write(exportKey(keyId));
  } else if (command === 'import') {
    const installed = importKey(readFileSync(0, 'utf8'), { keyId });
    process.stdout.write(`imported ${installed.key_id} (${installed.public_key})\n`);
  } else {
    process.stderr.write('usage: node scripts/lyhna-key.mjs <show|export|import> [key_id]\n');
    process.exit(2);
  }
} catch (error) {
  process.stderr.write(`${error.code || 'ERROR'}: ${error.message}\n`);
  process.exit(1);
}
