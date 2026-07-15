import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const ORIGINS = new Set([
  'mcp_routed',
  'runtime_hook',
  'agent_reported',
  'evaluator_reported',
  'github_observed',
  'imported',
  'unobserved'
]);

export function dataRoot() {
  return process.env.LYHNA_CODEX_DATA || join(homedir(), '.lyhna', 'codex-adapter');
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

export function withLock(path, fn) {
  mkdirSync(dirname(path), { recursive: true });
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      mkdirSync(path);
      writeFileSync(join(path, 'owner.json'), canonicalJson({ pid: process.pid, acquired_at: new Date().toISOString() }), { encoding: 'utf8', flush: true });
      acquired = true;
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const owner = readJson(join(path, 'owner.json'), null);
        if (Number.isInteger(owner?.pid) && owner.pid > 0) {
          try {
            process.kill(owner.pid, 0);
          } catch (ownerError) {
            stale = ownerError?.code === 'ESRCH';
          }
        } else {
          stale = Date.now() - statSync(path).mtimeMs > 30_000;
        }
      } catch {
        try {
          stale = Date.now() - statSync(path).mtimeMs > 30_000;
        } catch {
          stale = true;
        }
      }
      if (stale) {
        const stalePath = `${path}.stale.${process.pid}.${attempt}`;
        try {
          renameSync(path, stalePath);
          rmSync(stalePath, { recursive: true, force: true });
          continue;
        } catch (recoveryError) {
          if (!['ENOENT', 'EEXIST'].includes(recoveryError?.code)) throw recoveryError;
        }
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  if (!acquired) throw new Error(`STORE_BUSY:${path}`);
  try {
    return fn();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

export function assert(condition, code, details = '') {
  if (!condition) {
    const error = new Error(details ? `${code}: ${details}` : code);
    error.code = code;
    throw error;
  }
}
