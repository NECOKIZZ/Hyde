// Fast private-balance scan. The SDK's getPrivateBalance trial-decrypts every pool output with
// pure-JS X25519 (~1.6 ms each) and reads the pool again for every key. On a fraction of a CPU
// (Render's free plan) that takes minutes. Here the pool is read once, the X25519 step runs in
// Node's native crypto, and only outputs that open are handed to the SDK.
import { createPrivateKey, createPublicKey, diffieHellman, type KeyObject } from "node:crypto";
import { Keypair, POOL_ABI, Utxo, getPoolAddress, toFixedHex } from "@veil-cash/sdk";
import nacl from "tweetnacl";
import { createPublicClient, http, type Hex } from "viem";
import { base } from "viem/chains";

const SIGMA = new TextEncoder().encode("expand 32-byte k");
const ZERO16 = new Uint8Array(16);
// tweetnacl ships crypto_core_hsalsa20 at runtime but not in its typings.
const hsalsa20 = (nacl as unknown as { lowlevel: { crypto_core_hsalsa20(out: Uint8Array, inp: Uint8Array, k: Uint8Array, c: Uint8Array): void } }).lowlevel.crypto_core_hsalsa20;
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

function x25519Key(secret: Uint8Array): KeyObject {
  const pub = nacl.box.keyPair.fromSecretKey(secret).publicKey;
  return createPrivateKey({ key: { kty: "OKP", crv: "X25519", d: b64url(secret), x: b64url(pub) }, format: "jwk" });
}

/** Same check as nacl.box.open (x25519-xsalsa20-poly1305), with the scalar multiplication done natively. */
function opens(encrypted: Hex, key: KeyObject): boolean {
  const buf = Buffer.from(encrypted.slice(2), "hex");
  if (buf.length < 56 + nacl.secretbox.overheadLength) return false;
  try {
    const ephem = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: b64url(buf.subarray(24, 56)) }, format: "jwk" });
    const shared = diffieHellman({ privateKey: key, publicKey: ephem });
    const k = new Uint8Array(32);
    hsalsa20(k, ZERO16, new Uint8Array(shared), SIGMA);
    return nacl.secretbox.open(new Uint8Array(buf.subarray(56)), new Uint8Array(buf.subarray(0, 24)), k) !== null;
  } catch {
    return false;
  }
}

export interface ScanResult {
  /** Unspent USDC base units */
  unspent: bigint;
  unspentCount: number;
}

export { opens as _opens, x25519Key as _x25519Key };

/** Unspent USDC in the Veil pool for each keypair, reading the pool once. */
export async function scanBalances(keypairs: Keypair[], rpcUrl?: string): Promise<ScanResult[]> {
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const pool = getPoolAddress("usdc");
  const next = Number(await client.readContract({ address: pool, abi: POOL_ABI, functionName: "nextIndex" }));
  const outputs: Hex[] = [];
  for (let start = 0; start < next; start += 5000) {
    const end = Math.min(start + 5000, next);
    outputs.push(...((await client.readContract({ address: pool, abi: POOL_ABI, functionName: "getEncryptedOutputs", args: [BigInt(start), BigInt(end)] })) as Hex[]));
  }
  return Promise.all(
    keypairs.map(async (kp) => {
      const key = x25519Key(Buffer.from((kp.privkey as string).slice(2), "hex"));
      let unspent = 0n;
      let unspentCount = 0;
      for (let i = 0; i < outputs.length; i++) {
        if (!opens(outputs[i], key)) continue;
        const utxo = Utxo.decrypt(outputs[i], kp);
        if (utxo.amount === 0n) continue;
        utxo.index = i;
        const spent = await client.readContract({ address: pool, abi: POOL_ABI, functionName: "isSpent", args: [toFixedHex(utxo.getNullifier()) as Hex] });
        if (!spent) {
          unspent += utxo.amount;
          unspentCount++;
        }
      }
      return { unspent, unspentCount };
    }),
  );
}
