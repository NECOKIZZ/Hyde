import { encodeFunctionData, erc20Abi, pad, parseAbi, type Address, type Hex } from "viem";
import { CCTP_FAST, TOKEN_MESSENGER_V2, chainInfo, type ChainKey } from "./chains.js";

const IRIS = process.env.CCTP_IRIS_URL ?? "https://iris-api.circle.com";

/** Circle Forwarding Service hook: "cctp-forward", version 0, no extra data. Circle mints on the destination. */
export const FORWARD_HOOK: Hex = "0x636374702d666f72776172640000000000000000000000000000000000000000";

export const tokenMessengerAbi = parseAbi([
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
]);

/** One unsigned EVM call for the user's PayBox wallet (PayBox proposals carry exactly one call). */
export interface UnsignedCall {
  chain: ChainKey;
  chainId: number;
  to: Address;
  value: "0";
  data: Hex;
  description: string;
}

export interface FeeQuote {
  /** CCTP fast-transfer protocol fee, in bps */
  protocolBps: number;
  /** Circle forwarding fee (high tier), USDC base units */
  forwardFee: bigint;
}

/** Fee quote between two CCTP domains (Solana is domain 5). */
export async function quoteFees(srcDomain: number, dstDomain: number): Promise<FeeQuote> {
  const url = `${IRIS}/v2/burn/USDC/fees/${srcDomain}/${dstDomain}?forward=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`CCTP fee quote failed: ${res.status}`);
  const tiers = (await res.json()) as { finalityThreshold: number; minimumFee: number; forwardFee?: { high: number } }[];
  const fast = tiers.find((t) => t.finalityThreshold === CCTP_FAST);
  if (!fast?.forwardFee) throw new Error("CCTP fast transfer with forwarding is unavailable for this route");
  return { protocolBps: fast.minimumFee, forwardFee: BigInt(fast.forwardFee.high) };
}

/** Fee cap: protocol fee with 50% headroom + forwarding fee with 25% headroom, rounded up. */
export function maxFeeFor(amount: bigint, q: FeeQuote): bigint {
  const capBps = BigInt(Math.ceil(q.protocolBps * 1.5 * 100)); // hundredths of a bp
  const protocol = (amount * capBps + 999_999n) / 1_000_000n;
  return protocol + (q.forwardFee * 5n + 3n) / 4n;
}

export function approveCall(src: ChainKey, amount: bigint): UnsignedCall {
  const c = chainInfo(src);
  return {
    chain: src,
    chainId: c.chain.id,
    to: c.usdc,
    value: "0",
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [TOKEN_MESSENGER_V2, amount] }),
    description: `Approve ${formatUsdc(amount)} USDC for Circle CCTP on ${c.name}`,
  };
}

/** Burn on `src`; Circle's Forwarding Service mints `amount - fees` to `recipient` on `dst`. */
export function burnCall(opts: { src: ChainKey; dst: ChainKey; amount: bigint; recipient: Address; maxFee: bigint }): UnsignedCall {
  const src = chainInfo(opts.src);
  const dst = chainInfo(opts.dst);
  return {
    chain: opts.src,
    chainId: src.chain.id,
    to: TOKEN_MESSENGER_V2,
    value: "0",
    data: encodeFunctionData({
      abi: tokenMessengerAbi,
      functionName: "depositForBurnWithHook",
      args: [opts.amount, dst.domain, pad(opts.recipient), src.usdc, pad("0x0", { size: 32 }), opts.maxFee, CCTP_FAST, FORWARD_HOOK],
    }),
    description: `Bridge ${formatUsdc(opts.amount)} USDC from ${src.name} to ${dst.name} (Circle CCTP fast, auto-delivered)`,
  };
}

export function transferCall(chain: ChainKey, to: Address, amount: bigint, description: string): UnsignedCall {
  const c = chainInfo(chain);
  return {
    chain,
    chainId: c.chain.id,
    to: c.usdc,
    value: "0",
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }),
    description,
  };
}

export interface BurnStatus {
  status: "pending" | "attested";
  /** Destination mint tx (EVM hash or Solana signature) submitted by Circle's Forwarding Service */
  forwardTxHash?: string;
}

export async function burnStatus(src: ChainKey, burnTxHash: Hex): Promise<BurnStatus> {
  const res = await fetch(`${IRIS}/v2/messages/${chainInfo(src).domain}?transactionHash=${burnTxHash}`, {
    signal: AbortSignal.timeout(4000),
  });
  if (res.status === 404) return { status: "pending" };
  if (!res.ok) throw new Error(`CCTP attestation lookup failed: ${res.status}`);
  const body = (await res.json()) as { messages?: { status: string; forwardTxHash?: string }[] };
  const msg = body.messages?.[0];
  if (!msg || msg.status !== "complete") return { status: "pending" };
  return { status: "attested", forwardTxHash: msg.forwardTxHash || undefined };
}

export function formatUsdc(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const frac = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function parseUsdc(amount: string | number): bigint {
  const s = String(amount).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`Invalid USDC amount: ${amount}`);
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
}
