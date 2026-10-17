import {
  ENTRY_ABI,
  Keypair,
  VEIL_SIGNED_MESSAGE,
  buildApproveUSDCTx,
  buildDepositUSDCTx,
  buildRegisterTx,
  deriveSubaccountSlot,
  getAddresses,
  getQueueAddress,
  getQueueBalance,
  withdraw,
  type SubaccountSlot,
} from "@veil-cash/sdk";
import { erc20Abi, recoverMessageAddress, type Address, type Hex } from "viem";
import { formatUsdc } from "./cctp.js";
import { rpcUrl } from "./chains.js";
import { publicClient } from "./clients.js";
import { scanBalances } from "./scan.js";

/** We use one sub-account slot as every user's "go private" inbox. */
export const INBOX_SLOT = 0;
/** Veil's minimum deposit is 20 USDC net of its 0.3% fee. */
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

/** The PayBox wallet that signed the Veil message: it owns the deposit registration. */
export async function ownerFromSignature(signature: Hex): Promise<Address> {
  return recoverMessageAddress({ message: VEIL_SIGNED_MESSAGE, signature });
}

export type DepositStep = "register" | "approve" | "deposit";

/**
 * The next wallet transaction for a direct deposit from `owner` on Base, read from chain state:
 * register the Veil deposit key once, approve Veil's entry contract, then queue the deposit.
 */
export async function nextDepositStep(owner: Address, kp: Keypair, amount: bigint): Promise<{ step: DepositStep; to: Address; data: Hex }> {
  const client = publicClient("base");
  const { entry, usdcToken } = getAddresses();
  const depositKey = kp.depositKey();
  const registered = (await client.readContract({ address: entry, abi: ENTRY_ABI, functionName: "depositKeys", args: [owner] })) as Hex;
  if (registered === "0x") return { step: "register", ...buildRegisterTx(depositKey, owner) };
  if (registered.toLowerCase() !== depositKey.toLowerCase()) {
    throw new Error("This wallet is registered with Veil under a different key. Sign the Veil message with the same wallet you used on veil.cash.");
  }
  const allowance = await client.readContract({ address: usdcToken, abi: erc20Abi, functionName: "allowance", args: [owner, entry] });
  if (allowance < amount) return { step: "approve", ...buildApproveUSDCTx({ amount: formatUsdc(amount) }) };
  return { step: "deposit", ...buildDepositUSDCTx({ depositKey, amount: formatUsdc(amount) }) };
}

const QUEUE_PENDING_ABI = [
  {
    type: "function",
    name: "getPendingDepositsWithData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "nonce", type: "uint256" },
          { name: "fallbackReceiver", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint256" },
          { name: "shieldAmount", type: "uint256" },
          { name: "timestamp", type: "uint256" },
          { name: "status", type: "uint8" },
          { name: "depositKey", type: "bytes" },
        ],
      },
    ],
  },
] as const;

/** USDC this wallet has queued with Veil that is still waiting on screening (base units, after Veil's fee). */
export async function pendingDepositOf(owner: Address): Promise<bigint> {
  const pending = await publicClient("base").readContract({ address: getQueueAddress("usdc"), abi: QUEUE_PENDING_ABI, functionName: "getPendingDepositsWithData" });
  return pending.filter((d) => d.fallbackReceiver.toLowerCase() === owner.toLowerCase()).reduce((sum, d) => sum + d.shieldAmount, 0n);
}

export interface PrivateBalances {
  /** Spendable now */
  shielded: string;
  /** Deposited, waiting on Veil's compliance screening */
  screening: string;
}

export async function balances(kp: Keypair, owner?: Address): Promise<PrivateBalances> {
  const [[main], queue] = await Promise.all([
    scanBalances([kp], BASE_RPC()),
    owner ? getQueueBalance({ address: owner, pool: "usdc", rpcUrl: BASE_RPC() }) : { queueBalance: "0" },
  ]);
  return { shielded: formatUsdc(main.unspent), screening: queue.queueBalance };
}

/** Private withdrawal (ZK proof + Veil relayer). The withdrawing wallet never appears on-chain. */
export async function privateWithdraw(kp: Keypair, amount: bigint, recipient: Address): Promise<Hex> {
  const r = await withdraw({ amount: formatUsdc(amount), recipient, keypair: kp, pool: "usdc", rpcUrl: BASE_RPC(), relayUrl: process.env.VEIL_RELAY_URL });
  if (!r.success) throw new Error("Veil relay rejected the withdrawal");
  return r.transactionHash as Hex;
}
