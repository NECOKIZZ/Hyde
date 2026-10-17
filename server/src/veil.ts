import {
  Keypair,
  deriveSubaccountChildPrivateKey,
  deriveSubaccountSlot,
  getPrivateBalance,
  getQueueBalance,
  getRelayUrl,
  isSubaccountForwarderDeployed,
  mergeSubaccount,
  withdraw,
  type SubaccountSlot,
} from "@veil-cash/sdk";
import type { Address, Hex } from "viem";
import { formatUsdc, parseUsdc } from "./cctp.js";
import { rpcUrl } from "./chains.js";

/** We use one sub-account slot as every user's "go private" inbox. */
export const INBOX_SLOT = 0;
/** Veil's minimum sweep into the pool is 20 USDC net of its 0.3% fee. */
export const MIN_SHIELD_USDC = 20_100_000n;

const BASE_RPC = () => rpcUrl("base");

/**
 * How the caller proves who they are. The plugin never stores either value.
 * - veil_signature: PayBox wallet's EIP-191 signature of VEIL_SIGNED_MESSAGE (same key as veil.cash)
 * - veil_key: a Veil private key kept in the user's PayBox Secrets vault
 */
export interface VeilAuth {
  veil_signature?: Hex;
  veil_key?: Hex;
}

export function keypairFrom(auth: VeilAuth): Keypair {
  if (auth.veil_key) return new Keypair(auth.veil_key);
  if (auth.veil_signature) return Keypair.fromSignature(auth.veil_signature);
  throw new Error("Provide veil_signature (preferred) or veil_key");
}

export function rootKey(kp: Keypair): Hex {
  return kp.privkey as Hex;
}

/** Public facts about the user's inbox forwarder: safe to keep in a job record. */
export type InboxSlot = Pick<SubaccountSlot, "slot" | "salt" | "childDepositKey" | "childOwner" | "forwarderAddress">;

export async function inboxSlot(kp: Keypair): Promise<InboxSlot> {
  const s = await deriveSubaccountSlot({ rootPrivateKey: rootKey(kp), slot: INBOX_SLOT, rpcUrl: BASE_RPC() });
  return { slot: s.slot, salt: s.salt, childDepositKey: s.childDepositKey, childOwner: s.childOwner, forwarderAddress: s.forwarderAddress };
}

async function relayPost<T>(endpoint: string, body: unknown): Promise<T> {
  const res = await fetch(`${process.env.VEIL_RELAY_URL ?? getRelayUrl()}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) throw new Error(`Veil relay ${endpoint}: ${data.error ?? data.message ?? res.status}`);
  return data;
}

/** Deploy (if needed) and sweep the inbox forwarder into Veil's deposit queue. Needs no secrets. */
export async function sweepInbox(slot: InboxSlot): Promise<{ deployTx?: string; sweepTx: string }> {
  let deployTx: string | undefined;
  if (!(await isSubaccountForwarderDeployed({ forwarderAddress: slot.forwarderAddress, rpcUrl: BASE_RPC() }))) {
    const r = await relayPost<{ transactionHash: string }>("/stealth/deploy", {
      salt: slot.salt,
      childDepositKey: slot.childDepositKey,
      childOwner: slot.childOwner,
      expectedForwarder: slot.forwarderAddress,
    });
    deployTx = r.transactionHash;
  }
  const r = await relayPost<{ transactionHash: string }>("/stealth/sweep", { forwarder: slot.forwarderAddress, asset: "usdc" });
  return { deployTx, sweepTx: r.transactionHash };
}

export async function inboxQueue(slot: InboxSlot) {
  return getQueueBalance({ address: slot.forwarderAddress, pool: "usdc", rpcUrl: BASE_RPC() });
}

export interface PrivateBalances {
  /** Spendable now */
  shielded: string;
  /** In the inbox, accepted into the pool, waiting to be merged into the main balance */
  inbox: string;
  /** Swept, waiting on Veil's compliance screening / queue processing */
  screening: string;
}

export async function balances(kp: Keypair, slot: InboxSlot): Promise<PrivateBalances> {
  const child = new Keypair(deriveSubaccountChildPrivateKey(rootKey(kp), INBOX_SLOT));
  const [main, inbox, queue] = await Promise.all([
    getPrivateBalance({ keypair: kp, pool: "usdc", rpcUrl: BASE_RPC() }),
    getPrivateBalance({ keypair: child, pool: "usdc", rpcUrl: BASE_RPC() }),
    inboxQueue(slot).catch(() => ({ queueBalance: "0" })),
  ]);
  return { shielded: main.privateBalance, inbox: inbox.privateBalance, screening: queue.queueBalance };
}

/** Moves anything that cleared screening from the inbox into the main shielded balance. */
export async function mergeInbox(kp: Keypair): Promise<string | null> {
  const child = new Keypair(deriveSubaccountChildPrivateKey(rootKey(kp), INBOX_SLOT));
  const inbox = await getPrivateBalance({ keypair: child, pool: "usdc", rpcUrl: BASE_RPC() });
  if (parseUsdc(inbox.privateBalance) === 0n) return null;
  const r = await mergeSubaccount({ rootPrivateKey: rootKey(kp), slot: INBOX_SLOT, pool: "usdc", rpcUrl: BASE_RPC() });
  return r.transactionHash;
}

/** Private withdrawal (ZK proof + Veil relayer). The withdrawing wallet never appears on-chain. */
export async function privateWithdraw(kp: Keypair, amount: bigint, recipient: Address): Promise<Hex> {
  const r = await withdraw({ amount: formatUsdc(amount), recipient, keypair: kp, pool: "usdc", rpcUrl: BASE_RPC() });
  if (!r.success) throw new Error("Veil relay rejected the withdrawal");
  return r.transactionHash as Hex;
}
