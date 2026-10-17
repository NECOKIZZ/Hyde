import { createPublicClient, createWalletClient, http, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { chainInfo, rpcUrl, type ChainKey } from "./chains.js";

const publicClients = new Map<ChainKey, PublicClient>();

export function publicClient(key: ChainKey): PublicClient {
  let client = publicClients.get(key);
  if (!client) {
    client = createPublicClient({ chain: chainInfo(key).chain, transport: http(rpcUrl(key)) }) as PublicClient;
    publicClients.set(key, client);
  }
  return client;
}

/** Our relayer: opens exit boxes on Base and completes CCTP mints. Never holds user funds. */
export function relayerAccount(): PrivateKeyAccount {
  const key = process.env.RELAYER_PRIVATE_KEY as `0x${string}` | undefined;
  if (!key) throw new Error("RELAYER_PRIVATE_KEY is not set");
  return privateKeyToAccount(key);
}

export function relayerWallet(key: ChainKey): WalletClient {
  return createWalletClient({ account: relayerAccount(), chain: chainInfo(key).chain, transport: http(rpcUrl(key)) });
}
