import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, Utxo } from "@veil-cash/sdk";
import type { Hex } from "viem";
import { _opens, _x25519Key } from "./scan.js";

test("native trial decryption agrees with the SDK", () => {
  const owner = new Keypair();
  const other = new Keypair();
  const key = (kp: Keypair) => _x25519Key(Buffer.from((kp.privkey as string).slice(2), "hex"));
  for (let i = 0; i < 20; i++) {
    const data = new Utxo({ amount: BigInt(1_000_000 + i), keypair: owner }).encrypt() as Hex;
    assert.equal(_opens(data, key(owner)), true);
    assert.equal(_opens(data, key(other)), false);
    assert.equal(Utxo.decrypt(data, owner).amount, BigInt(1_000_000 + i));
  }
  assert.equal(_opens("0x1234", key(owner)), false);
});
