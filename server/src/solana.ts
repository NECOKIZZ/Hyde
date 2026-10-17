import { Connection, PublicKey } from "@solana/web3.js";
import { toHex, type Hex } from "viem";

/** Solana as a CCTP endpoint. CCTP mints to a USDC token account, not to the wallet itself. */
export const SOLANA = {
  key: "solana" as const,
  name: "Solana",
  domain: 5,
  usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export function isSolanaAddress(value: string): boolean {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

/** The owner's associated USDC token account (where CCTP must mint). */
export function usdcTokenAccount(owner: string): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), TOKEN_PROGRAM.toBuffer(), new PublicKey(SOLANA.usdcMint).toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM,
  );
  return ata;
}

export function toBytes32(key: PublicKey): Hex {
  return toHex(key.toBytes());
}

let connection: Connection | undefined;
function solanaConnection(): Connection {
  connection ??= new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
  return connection;
}

/** CCTP can only mint into a token account that already exists. */
export async function usdcAccountExists(owner: string): Promise<boolean> {
  const info = await Promise.race([
    solanaConnection().getAccountInfo(usdcTokenAccount(owner)),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Solana RPC timed out")), 4000)),
  ]);
  return info !== null && info.owner.equals(TOKEN_PROGRAM);
}
