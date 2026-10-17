import { arbitrum, avalanche, base, mainnet, optimism, polygon, type Chain } from "viem/chains";
import type { Address } from "viem";

/** CCTP V2 contracts share one address on every EVM chain we support. */
export const TOKEN_MESSENGER_V2: Address = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
export const MESSAGE_TRANSMITTER_V2: Address = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";

export const CCTP_FAST = 1000;
export const CCTP_STANDARD = 2000;

export interface ChainInfo {
  key: ChainKey;
  name: string;
  chain: Chain;
  /** CCTP domain id */
  domain: number;
  /** Native USDC */
  usdc: Address;
  rpcEnv: string;
}

export const CHAINS = {
  ethereum: { name: "Ethereum", chain: mainnet, domain: 0, usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", rpcEnv: "ETHEREUM_RPC_URL" },
  avalanche: { name: "Avalanche", chain: avalanche, domain: 1, usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", rpcEnv: "AVALANCHE_RPC_URL" },
  optimism: { name: "OP Mainnet", chain: optimism, domain: 2, usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", rpcEnv: "OPTIMISM_RPC_URL" },
  arbitrum: { name: "Arbitrum", chain: arbitrum, domain: 3, usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", rpcEnv: "ARBITRUM_RPC_URL" },
  base: { name: "Base", chain: base, domain: 6, usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", rpcEnv: "BASE_RPC_URL" },
  polygon: { name: "Polygon PoS", chain: polygon, domain: 7, usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", rpcEnv: "POLYGON_RPC_URL" },
} as const satisfies Record<string, Omit<ChainInfo, "key">>;

export type ChainKey = keyof typeof CHAINS;
export const CHAIN_KEYS = Object.keys(CHAINS) as [ChainKey, ...ChainKey[]];

export function chainInfo(key: ChainKey): ChainInfo {
  return { key, ...CHAINS[key] };
}

export function chainByDomain(domain: number): ChainInfo {
  const key = CHAIN_KEYS.find((k) => CHAINS[k].domain === domain);
  if (!key) throw new Error(`Unsupported CCTP domain ${domain}`);
  return chainInfo(key);
}

export function rpcUrl(key: ChainKey): string | undefined {
  return process.env[CHAINS[key].rpcEnv] || undefined;
}
