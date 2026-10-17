import assert from "node:assert/strict";
import { test } from "node:test";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { SOLANA, isSolanaAddress, toBytes32, usdcTokenAccount } from "./solana.js";

test("USDC token account derivation matches @solana/spl-token", () => {
  const mint = new PublicKey(SOLANA.usdcMint);
  for (let i = 0; i < 25; i++) {
    const owner = Keypair.generate().publicKey;
    assert.equal(usdcTokenAccount(owner.toBase58()).toBase58(), getAssociatedTokenAddressSync(mint, owner).toBase58());
  }
});

test("Solana address validation and bytes32 encoding", () => {
  const owner = Keypair.generate().publicKey;
  assert.ok(isSolanaAddress(owner.toBase58()));
  assert.ok(!isSolanaAddress("0x000000000000000000000000000000000000bEEF"));
  assert.ok(!isSolanaAddress("not-a-key"));
  assert.equal(toBytes32(owner), `0x${Buffer.from(owner.toBytes()).toString("hex")}`);
});
