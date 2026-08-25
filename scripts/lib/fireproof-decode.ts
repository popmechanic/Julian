// scripts/lib/fireproof-decode.ts — the recipe for reading the condemned Fireproof archive.
// Envelope (proven Aug 25, 2026): CBOR {iv(12), data, keyId(32)}; keyId = SHA-256(rawKey);
// AES-GCM-128; plaintext = CARv1; dag-cbor blocks with a `doc` field are documents.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decode as cborDecode, encode as cborEncode } from 'cborg';
import { base58btc } from 'multiformats/bases/base58';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { CarReader, CarWriter } from '@ipld/car';
import * as dagCbor from '@ipld/dag-cbor';
import type { DecodedDoc, FireproofDoc, LedgerInfo } from './fireproof-types';

export async function keyFingerprint(raw: Uint8Array): Promise<string> {
  return Buffer.from(await crypto.subtle.digest('SHA-256', raw)).toString('hex');
}

export async function importKeys(base58Keys: string[]): Promise<Map<string, CryptoKey>> {
  const out = new Map<string, CryptoKey>();
  for (const k of base58Keys) {
    const raw = base58btc.decode(k.trim());
    out.set(await keyFingerprint(raw), await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']));
  }
  return out;
}

export async function decryptEnvelope(bytes: Uint8Array, keys: Map<string, CryptoKey>): Promise<Uint8Array> {
  const env = cborDecode(bytes) as { iv: Uint8Array; data: Uint8Array; keyId: Uint8Array };
  const fp = Buffer.from(env.keyId).toString('hex');
  const key = keys.get(fp);
  if (!key) throw new Error(`no escrowed key matches keyId ${fp.slice(0, 12)}…`);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: env.iv }, key, env.data));
}

export async function readDocs(carBytes: Uint8Array): Promise<FireproofDoc[]> {
  const reader = await CarReader.fromBytes(carBytes);
  await reader.getRoots();
  const docs: FireproofDoc[] = [];
  for await (const { cid, bytes } of reader.blocks()) {
    const digest = await sha256.digest(bytes);
    if (!CID.createV1(cid.code, digest).equals(cid)) throw new Error(`CID mismatch for ${cid}`);
    if (cid.code !== dagCbor.code) continue;
    const v = dagCbor.decode(bytes) as { doc?: FireproofDoc };
    if (v && typeof v === 'object' && v.doc && typeof v.doc === 'object') docs.push(v.doc);
  }
  return docs;
}

export async function decryptLedger(opts: {
  blobsDir: string;
  blobs: Array<{ blobId: string; uploaded: number }>;
  keys: Map<string, CryptoKey>;
  ledger: LedgerInfo;
  onSkip?: (blobId: string, reason: string) => void;
}): Promise<DecodedDoc[]> {
  const out: DecodedDoc[] = [];
  for (const b of opts.blobs) {
    try {
      const plain = await decryptEnvelope(readFileSync(join(opts.blobsDir, b.blobId)), opts.keys);
      for (const doc of await readDocs(plain)) out.push({ doc, ledger: opts.ledger, blobId: b.blobId, uploaded: b.uploaded });
    } catch (e) {
      opts.onSkip?.(b.blobId, String((e as Error).message ?? e));
    }
  }
  return out;
}

// Test fixture builder — the same shape the Feb app wrote, so the recipe is proven by construction.
export async function buildEncryptedCar(docs: FireproofDoc[], rawKey: Uint8Array): Promise<Uint8Array> {
  const blocks = await Promise.all(docs.map(async (doc) => {
    const bytes = dagCbor.encode({ doc });
    return { cid: CID.createV1(dagCbor.code, await sha256.digest(bytes)), bytes };
  }));
  const { writer, out } = CarWriter.create([blocks[0].cid]);
  const chunks: Uint8Array[] = [];
  const collect = (async () => { for await (const c of out) chunks.push(c); })();
  for (const b of blocks) await writer.put(b);
  await writer.close();
  await collect;
  const car = Buffer.concat(chunks);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, car));
  const keyId = new Uint8Array(await crypto.subtle.digest('SHA-256', rawKey));
  return cborEncode({ iv, data, keyId });
}
