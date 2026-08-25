// scripts/fireproof-decode.test.ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base58btc } from 'multiformats/bases/base58';
import { decode as cborDecode } from 'cborg';
import {
  buildEncryptedCar, decryptEnvelope, decryptLedger, importKeys, keyFingerprint, readDocs,
} from './lib/fireproof-decode';

const rawKey = () => crypto.getRandomValues(new Uint8Array(16));
const docs = [
  { _id: 'msg-a', type: 'message', text: 'hello', role: 'user', createdAt: '2026-02-20T10:00:00.000Z' },
  { _id: 'agent-1', type: 'agent-identity', name: 'Fixture' },
];

describe('fireproof decode', () => {
  test('envelope round-trips: keyId is SHA-256 of the raw key, AES-GCM-128 opens it, docs come back', async () => {
    const key = rawKey();
    const bytes = await buildEncryptedCar(docs, key);
    const env = cborDecode(bytes) as { iv: Uint8Array; data: Uint8Array; keyId: Uint8Array };
    expect(env.iv.length).toBe(12);
    expect(Buffer.from(env.keyId).toString('hex')).toBe(await keyFingerprint(key));
    const keys = await importKeys([base58btc.encode(key)]);
    const plain = await decryptEnvelope(bytes, keys);
    expect(await readDocs(plain)).toEqual(docs);
  });

  test('a key with the wrong fingerprint is refused before any decrypt attempt', async () => {
    const bytes = await buildEncryptedCar(docs, rawKey());
    const keys = await importKeys([base58btc.encode(rawKey())]);
    await expect(decryptEnvelope(bytes, keys)).rejects.toThrow(/no escrowed key matches keyId/);
  });

  test('a block whose bytes do not hash to its CID throws', async () => {
    const key = rawKey();
    const bytes = await buildEncryptedCar(docs, key);
    const plain = await decryptEnvelope(bytes, await importKeys([base58btc.encode(key)]));
    const corrupted = new Uint8Array(plain);
    corrupted[corrupted.length - 3] ^= 0xff; // flip a byte inside the last block's payload
    await expect(readDocs(corrupted)).rejects.toThrow(/CID mismatch/);
  });

  test('decryptLedger reads every blob in a directory and tags docs with ledger, blobId, uploaded', async () => {
    const key = rawKey();
    const dir = mkdtempSync(join(tmpdir(), 'fp-decode-'));
    writeFileSync(join(dir, 'blob1'), await buildEncryptedCar([docs[0]], key));
    writeFileSync(join(dir, 'blob2'), await buildEncryptedCar([docs[1]], key));
    const ledger = { ledgerId: 'zLedger', name: 'clerk-julian-chat-v9-zT', tenantId: 'zT' };
    const out = await decryptLedger({
      blobsDir: dir,
      blobs: [{ blobId: 'blob1', uploaded: 100 }, { blobId: 'blob2', uploaded: 200 }],
      keys: await importKeys([base58btc.encode(key)]),
      ledger,
    });
    expect(out.map((d) => [d.doc._id, d.blobId, d.uploaded, d.ledger.ledgerId])).toEqual([
      ['msg-a', 'blob1', 100, 'zLedger'], ['agent-1', 'blob2', 200, 'zLedger'],
    ]);
  });

  test('decryptLedger reports a runt blob (truncated envelope) as a skipped id, not a crash', async () => {
    const key = rawKey();
    const dir = mkdtempSync(join(tmpdir(), 'fp-decode-'));
    writeFileSync(join(dir, 'runt'), (await buildEncryptedCar([docs[0]], key)).slice(0, 40));
    // Collect the callback rather than asserting inside it: an assertion that only runs
    // from within onSkip is verified by accident — it passes vacuously if onSkip never fires.
    const skips: Array<[string, string]> = [];
    const out = await decryptLedger({
      blobsDir: dir, blobs: [{ blobId: 'runt', uploaded: 1 }],
      keys: await importKeys([base58btc.encode(key)]),
      ledger: { ledgerId: 'z', name: 'n', tenantId: 't' },
      onSkip: (blobId, reason) => { skips.push([blobId, reason]); },
    });
    expect(out).toEqual([]);
    expect(skips.length).toBe(1);
    expect(skips[0][0]).toBe('runt');
    // cborg's truncation message, observed rather than assumed (the plan guessed
    // "Unexpected end of data"); asserted exactly so a reworded upstream is not silently absorbed.
    expect(skips[0][1]).toBe('CBOR decode error: not enough data for type');
  });
});
