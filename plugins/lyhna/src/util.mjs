import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const ORIGINS = new Set([
  'mcp_routed',
  'runtime_hook',
  'agent_reported',
  'evaluator_reported',
  'github_observed',
  'imported',
  'unobserved',
  'registered_probe',
  'mock_or_test'
]);

export function dataRoot() {
  // Loader adapters normalize their own persistent directory into LYHNA_CODEX_DATA: OpenAI forwards
  // that variable through `.mcp.json`, while the Agent Plugins hook extension and root `mcp.json`
  // map PLUGIN_DATA to it. Keep one resolver and one ledger after that loader-specific bootstrap.
  return process.env.LYHNA_CODEX_DATA || process.env.PLUGIN_DATA || join(homedir(), '.lyhna', 'codex-adapter');
}

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value, pretty = false) {
  return `${JSON.stringify(canonicalize(value), null, pretty ? 2 : 0)}${pretty ? '\n' : ''}`;
}

export function readJson(path, fallback = undefined) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (fallback !== undefined && error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

export function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, canonicalJson(value, true), { encoding: 'utf8', flush: true });
  renameSync(temp, path);
}

export function atomicWriteText(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, value, { encoding: 'utf8', flush: true });
  renameSync(temp, path);
}

function readLockOwner(path) {
  const ownerPath = join(path, 'owner.json');
  try {
    return existsSync(ownerPath) ? readJson(ownerPath, null) : readJson(path, null);
  } catch (error) {
    if (error instanceof SyntaxError || ['EISDIR', 'EPERM'].includes(error?.code)) return null;
    throw error;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

function ownerlessLockIsStale(path) {
  try {
    return Date.now() - statSync(path).mtimeMs > 30_000;
  } catch {
    return false;
  }
}

function recoveryIntentPaths(path) {
  const directory = dirname(path);
  const fixedName = `${basename(path)}.recovery`;
  try {
    return readdirSync(directory)
      .filter((name) => name === fixedName || name.startsWith(`${fixedName}.`))
      .filter((name) => !name.startsWith(`${fixedName}-retired.`))
      .map((name) => join(directory, name));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function hasLiveRecoveryIntent(path) {
  let live = false;
  for (const intentPath of recoveryIntentPaths(path)) {
    const intentOwner = readLockOwner(intentPath);
    if ((intentOwner && processIsAlive(intentOwner.pid)) || (!intentOwner && !ownerlessLockIsStale(intentPath))) {
      live = true;
      continue;
    }
    const retiredPath = `${path}.recovery-retired.${process.pid}.${randomUUID()}`;
    try {
      renameSync(intentPath, retiredPath);
    } catch (error) {
      if (['ENOENT', 'EEXIST', 'EPERM'].includes(error?.code)) {
        live = true;
        continue;
      }
      throw error;
    }
    const retiredOwner = readLockOwner(retiredPath);
    if (intentOwner) assert(sha256(retiredOwner) === sha256(intentOwner), 'STORE_RECOVERY_INTENT_MISMATCH');
    rmSync(retiredPath, { recursive: true, force: true });
  }
  return live;
}

function retireOwnedLock(path, ownerToken) {
  const currentOwner = readLockOwner(path);
  if (currentOwner?.token !== ownerToken) return false;
  const retiredPath = `${path}.released.${process.pid}.${randomUUID()}`;
  try {
    renameSync(path, retiredPath);
  } catch (error) {
    if (['ENOENT', 'EEXIST', 'EPERM'].includes(error?.code)) return false;
    throw error;
  }
  const retiredOwner = readLockOwner(retiredPath);
  assert(retiredOwner?.token === ownerToken, 'STORE_LOCK_RETIREMENT_MISMATCH');
  rmSync(retiredPath, { recursive: true, force: true });
  return true;
}

export function withLock(path, fn) {
  mkdirSync(dirname(path), { recursive: true });
  let acquired = false;
  const ownerToken = `${process.pid}:${randomUUID()}`;
  const owner = { pid: process.pid, token: ownerToken, acquired_at: new Date().toISOString() };
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (hasLiveRecoveryIntent(path)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      continue;
    }
    const candidatePath = `${path}.candidate.${process.pid}.${randomUUID()}`;
    writeFileSync(candidatePath, canonicalJson(owner), { encoding: 'utf8', flush: true, flag: 'wx' });
    try {
      linkSync(candidatePath, path);
      if (hasLiveRecoveryIntent(path)) {
        retireOwnedLock(path, ownerToken);
        continue;
      }
      acquired = true;
      break;
    } catch (error) {
      if (!existsSync(path)) {
        if (error?.code === 'EEXIST') continue;
        throw error;
      }
      const currentOwner = readLockOwner(path);
      const ownerlessStale = !currentOwner && ownerlessLockIsStale(path);
      if (!currentOwner && !ownerlessStale) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        continue;
      }
      if (currentOwner) assert(currentOwner?.token || currentOwner?.pid, 'STORE_LOCK_CORRUPT');
      if (ownerlessStale || !processIsAlive(currentOwner.pid)) {
        const recoveryToken = randomUUID();
        const recoveryPath = `${path}.recovery.${process.pid}.${recoveryToken}`;
        const recoveryCandidatePath = `${recoveryPath}.candidate`;
        writeFileSync(recoveryCandidatePath, canonicalJson({ pid: process.pid, token: recoveryToken, acquired_at: new Date().toISOString() }), { encoding: 'utf8', flush: true, flag: 'wx' });
        renameSync(recoveryCandidatePath, recoveryPath);
        try {
          const observedOwner = readLockOwner(path);
          const sameDeadOwner = currentOwner && observedOwner
            && sha256(observedOwner) === sha256(currentOwner)
            && !processIsAlive(observedOwner.pid);
          const sameOwnerlessLegacy = ownerlessStale && !observedOwner && ownerlessLockIsStale(path);
          if (sameDeadOwner || sameOwnerlessLegacy) {
            const stalePath = `${path}.stale.${process.pid}.${randomUUID()}`;
            try {
              renameSync(path, stalePath);
            } catch (error) {
              if (!['ENOENT', 'EEXIST', 'EPERM'].includes(error?.code)) throw error;
            }
            if (existsSync(stalePath)) {
              // A competing recovery may have retired a successor, but recovery
              // intents prevent that successor from entering its critical section.
              rmSync(stalePath, { recursive: true, force: true });
            }
          }
        } finally {
          const retiredRecoveryPath = `${path}.recovery-retired.${process.pid}.${randomUUID()}`;
          assert(readLockOwner(recoveryPath)?.token === recoveryToken, 'STORE_RECOVERY_OWNERSHIP_LOST');
          renameSync(recoveryPath, retiredRecoveryPath);
          rmSync(retiredRecoveryPath, { force: true });
        }
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    } finally {
      rmSync(candidatePath, { force: true });
    }
  }
  if (!acquired) throw new Error(`STORE_BUSY:${path}`);
  try {
    return fn();
  } finally {
    assert(retireOwnedLock(path, ownerToken), 'STORE_LOCK_OWNERSHIP_LOST');
  }
}

export function assert(condition, code, details = '') {
  if (!condition) {
    const error = new Error(details ? `${code}: ${details}` : code);
    error.code = code;
    throw error;
  }
}
