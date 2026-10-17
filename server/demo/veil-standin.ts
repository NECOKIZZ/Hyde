// Stand-ins for Veil's two off-chain services, for recording Hyde against a local Base mainnet fork.
// On the fork, Veil's real contracts are present but their screener (0xbow) and relay are not:
// - acceptPending(): plays Veil's operator. Builds a real deposit proof for each queued deposit and
//   calls Entry.acceptUSDC, exactly what the screener does after a deposit is approved.
// - startRelay(): plays Veil's relay. Takes the withdrawal proof Hyde builds and submits it to the
//   pool's permissionless withdrawUSDC.
// Never point these at mainnet: they impersonate accounts, which only a local fork allows.
import http from "node:http";
import { readFileSync } from "node:fs";
import { Keypair, Utxo, getAddresses, getPoolAddress, getQueueAddress, prepareTransaction } from "@veil-cash/sdk";
import { createPublicClient, createWalletClient, http as transport, parseEther, type Address, type Hex } from "viem";
import { base } from "viem/chains";

const ABI = JSON.parse(readFileSync(new URL("./veil-abi.json", import.meta.url), "utf8"));
const ENTRY_ACCEPT = [
  { type: "function", name: "operator", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "acceptUSDC",
    stateMutability: "nonpayable",
    inputs: [{ type: "uint256", name: "_nonce" }, ...ABI.pool.find((x: { name: string }) => x.name === "withdrawUSDC").inputs],
    outputs: [],
  },
] as const;

export function forkClients(rpc: string) {
  const pub = createPublicClient({ chain: base, transport: transport(rpc) });
  const as = (account: Address) => createWalletClient({ chain: base, transport: transport(rpc), account });
  const impersonate = async (account: Address) => {
    await pub.request({ method: "hardhat_impersonateAccount" as never, params: [account] as never });
    await pub.request({ method: "hardhat_setBalance" as never, params: [account, `0x${parseEther("1").toString(16)}`] as never });
  };
  return { pub, as, impersonate };
}

async function allCommitments(pub: ReturnType<typeof forkClients>["pub"]): Promise<Hex[]> {
  const pool = getPoolAddress("usdc");
  const n = (await pub.readContract({ address: pool, abi: ABI.pool, functionName: "nextIndex" })) as number;
  const out: Hex[] = [];
  for (let s = 0; s < Number(n); s += 5000) {
    out.push(...((await pub.readContract({ address: pool, abi: ABI.pool, functionName: "getCommitments", args: [BigInt(s), BigInt(Math.min(s + 5000, Number(n)))] })) as Hex[]));
  }
  return out;
}

const toArgs = (a: { proof: string; root: string; inputNullifiers: string[]; outputCommitments: string[]; publicAmount: string; extDataHash: string }) => ({
  proof: a.proof as Hex,
  root: a.root as Hex,
  inputNullifiers: a.inputNullifiers as Hex[],
  outputCommitments: a.outputCommitments as [Hex, Hex],
  publicAmount: BigInt(a.publicAmount),
  extDataHash: a.extDataHash as Hex,
});
const toExt = (e: { recipient: string; extAmount: string; relayer: string; fee: string; encryptedOutput1: string; encryptedOutput2: string }) => ({
  recipient: e.recipient as Address,
  extAmount: BigInt(e.extAmount),
  relayer: e.relayer as Address,
  fee: BigInt(e.fee),
  encryptedOutput1: e.encryptedOutput1 as Hex,
  encryptedOutput2: e.encryptedOutput2 as Hex,
});

/** Accepts every pending USDC deposit the way Veil's operator does. Returns the accept tx hashes. */
export async function acceptPending(rpc: string, log: (m: string) => void = console.log): Promise<Hex[]> {
  const { pub, as, impersonate } = forkClients(rpc);
  const queue = getQueueAddress("usdc");
  const entry = getAddresses().entry;
  const pending = (await pub.readContract({ address: queue, abi: ABI.queue, functionName: "getPendingDepositsWithData" })) as {
    nonce: bigint; shieldAmount: bigint; depositKey: Hex; fallbackReceiver: Address;
  }[];
  const operator = (await pub.readContract({ address: entry, abi: ENTRY_ACCEPT, functionName: "operator" })) as Address;
  await impersonate(operator);
  const hashes: Hex[] = [];
  for (const d of pending) {
    log(`screener: building deposit proof for nonce ${d.nonce} (${Number(d.shieldAmount) / 1e6} USDC)`);
    const owner = Keypair.fromString(d.depositKey);
    const tx = await prepareTransaction({ commitments: await allCommitments(pub), outputs: [new Utxo({ amount: d.shieldAmount, keypair: owner })] });
    const hash = await as(operator).writeContract({
      address: entry, abi: ENTRY_ACCEPT, functionName: "acceptUSDC", args: [d.nonce, toArgs(tx.args), toExt(tx.extData)], chain: base,
    });
    const r = await pub.waitForTransactionReceipt({ hash });
    log(`screener: acceptUSDC(${d.nonce}) ${r.status} ${hash}`);
    hashes.push(hash);
  }
  return hashes;
}

/** A local Veil relay: POST /relay/usdc submits the proof to the pool on the fork. */
export function startRelay(rpc: string, port: number, onTx: (e: { type: string; hash: Hex; recipient: string; amount: string }) => void = () => {}) {
  const { pub, as, impersonate } = forkClients(rpc);
  const relayer = "0x2ECE7a70bFFDc8aE68153142F8dE81067f74b7B3" as Address; // Veil's relayer address on Base
  const ready = impersonate(relayer);
  return http
    .createServer(async (req, res) => {
      const send = (code: number, body: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET") return send(200, { service: "Veil Relay stand-in (local fork)", network: "base" });
      let raw = "";
      for await (const c of req) raw += c;
      try {
        await ready;
        const { type, proofArgs, extData } = JSON.parse(raw);
        const fn = type === "withdraw" ? "withdrawUSDC" : "transactUSDC";
        const hash = await as(relayer).writeContract({ address: getPoolAddress("usdc"), abi: ABI.pool, functionName: fn, args: [toArgs(proofArgs), toExt(extData)], chain: base });
        const r = await pub.waitForTransactionReceipt({ hash });
        onTx({ type, hash, recipient: extData.recipient, amount: (Number(-BigInt(extData.extAmount)) / 1e6).toString() });
        send(200, { success: r.status === "success", transactionHash: hash, blockNumber: Number(r.blockNumber) });
      } catch (err) {
        send(500, { error: (err as Error).message.slice(0, 500) });
      }
    })
    .listen(port);
}
