// Live Hyde run on a local Base mainnet fork, streamed to demo/dashboard.html for screen recording.
// Real: Hyde API code, wallet transactions, Veil/USDC/Circle/ExitBox contracts, ZK proofs.
// Stand-ins (labeled on screen): Veil's screener and relay, which are off-chain services.
// Usage: FORK_RPC=http://127.0.0.1:8549 node --import tsx demo/run-demo.ts   → open http://127.0.0.1:8800, GET /start
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { ENTRY_ABI, VEIL_SIGNED_MESSAGE, getAddresses, getQueueAddress } from "@veil-cash/sdk";
import { encodeAbiParameters, erc20Abi, formatUnits, keccak256, parseEther, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { acceptPending, forkClients, startRelay } from "./veil-standin.js";

const FORK = process.env.FORK_RPC ?? "http://127.0.0.1:8549";
const API = "http://127.0.0.1:8801";
const KEY = "demo-key-0123456789abcdef";
const USDC = getAddresses().usdcToken;
const POOL = getAddresses().usdcPool as Address;
const MESSENGER = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usd = (v: bigint | number | string) => Number(typeof v === "bigint" ? formatUnits(v, 6) : v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const wallet = privateKeyToAccount(keccak256(toHex(`hyde-demo-wallet-${process.env.RUN_ID ?? "1"}`)));
const relayerKey = keccak256(toHex("hyde-demo-relayer"));
const { pub, as, impersonate } = forkClients(FORK);

// ---- event stream to the dashboard (and a timeline for placing narration) ----
const clients = new Set<http.ServerResponse>();
const timeline: { t: number; kind: string; text?: string }[] = [];
let t0 = 0;
function emit(e: Record<string, unknown> & { kind: string }) {
  const line = `data: ${JSON.stringify(e)}\n\n`;
  for (const c of clients) c.write(line);
  timeline.push({ t: t0 ? (Date.now() - t0) / 1000 : 0, kind: e.kind, text: (e.text ?? e.what ?? e.title) as string | undefined });
  console.log(`[${t0 ? ((Date.now() - t0) / 1000).toFixed(1) : "0"}s] ${e.kind} ${JSON.stringify(e).slice(0, 160)}`);
}
const step = (text: string) => emit({ kind: "step", text });
let proofs = 0;
let forkBlock = 0n;

async function api(path: string, body?: object) {
  const res = await fetch(API + path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", "x-hyde-key": KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as any;
  if (res.status >= 400) throw new Error(`${path}: ${data.error}`);
  return { status: res.status, data };
}

async function publicUsdc() {
  return pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [wallet.address] });
}
async function queued() {
  const q = (await pub.readContract({ address: getQueueAddress("usdc"), abi: JSON.parse(readFileSync(new URL("./veil-abi.json", import.meta.url), "utf8")).queue, functionName: "getPendingDepositsWithData" })) as { shieldAmount: bigint; fallbackReceiver: Address }[];
  return q.filter((d) => d.fallbackReceiver.toLowerCase() === wallet.address.toLowerCase()).reduce((s, d) => s + d.shieldAmount, 0n);
}
async function stats(extra: Record<string, string> = {}) {
  emit({ kind: "stats", pub: usd(await publicUsdc()), queue: usd(await queued()), proofs: String(proofs), ...extra });
}

async function setup() {
  // Full-pool reads exceed a fork's default call gas limit.
  await pub.request({ method: "evm_setBlockGasLimit" as never, params: ["0x3B9ACA00"] as never });
  forkBlock = await pub.getBlockNumber();
  emit({ kind: "block", n: String(forkBlock) });
  // Test funds: 500 USDC and a little ETH for the demo wallet; ETH for Hyde's relayer.
  const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [wallet.address, 9n]));
  await pub.request({ method: "hardhat_setStorageAt" as never, params: [USDC, slot, toHex(500_000_000n, { size: 32 })] as never });
  await pub.request({ method: "hardhat_setBalance" as never, params: [wallet.address, toHex(parseEther("0.05"))] as never });
  await pub.request({ method: "hardhat_setBalance" as never, params: [privateKeyToAccount(relayerKey).address, toHex(parseEther("0.05"))] as never });
  if ((await publicUsdc()) !== 500_000_000n) throw new Error("could not fund the demo wallet");
}

async function waitApi() {
  for (let i = 0; i < 60; i++) {
    if (await fetch(API + "/health").then((r) => r.ok).catch(() => false)) return;
    await sleep(500);
  }
  throw new Error("Hyde API did not start");
}

async function sendFromWallet(call: { to: Address; data: Hex }) {
  const hash = await as(wallet.address).sendTransaction({ to: call.to, data: call.data, chain: base, account: wallet });
  return pub.waitForTransactionReceipt({ hash });
}

async function run() {
  const sig = await wallet.signMessage({ message: VEIL_SIGNED_MESSAGE });
  emit({ kind: "block", n: String(forkBlock) });
  await stats({ priv: "0.00" });

  emit({ kind: "card", show: true, title: "A real Hyde run on a Base mainnet fork", sub: "Real Veil Cash, USDC, Circle CCTP and Hyde contracts. Real zero-knowledge proofs. Test funds." });
  await sleep(6000);
  emit({ kind: "card", show: false });
  await sleep(800);

  // 1. Go private
  step("1 · Go private");
  emit({ kind: "user", text: "Move 500 USDC from my wallet into my private vault." });
  await sleep(1500);
  emit({ kind: "ai", html: "Using <b>Hyde · Vault</b>. Each step is a wallet transaction you approve." });
  const what = { register: "Veil Entry · register (one time)", approve: "USDC · approve Veil Entry", deposit: "Veil Entry · queueUSDC" } as const;
  for (let i = 0; i < 3; i++) {
    await sleep(1200);
    const { data } = await api("/v1/deposit", { veil_signature: sig, from_chain: "base", amount: "500" });
    emit({ kind: "tool", name: `hyde_deposit → ${data.step}`, body: data.call.description });
    await sleep(1400);
    const r = await sendFromWallet(data.call);
    const ev = data.step === "deposit" ? `Queued for screening: ${usd(await queued())} USDC (Veil keeps 0.3%)` : data.step === "register" ? "Your Veil deposit key is now on-chain" : "Allowance set for 500 USDC";
    emit({ kind: "tx", what: what[data.step as keyof typeof what], hash: r.transactionHash, block: String(r.blockNumber), status: r.status.toUpperCase(), ev });
    await stats();
    if (data.step === "deposit") break;
  }

  // 2. Screening
  await sleep(1500);
  step("2 · Compliance screening");
  emit({ kind: "note", text: "Veil's screener approves the deposit (on this fork, a stand-in plays Veil's operator)" });
  const accepted = await acceptPending(FORK, wallet.address, (m) => console.log(m));
  for (const hash of accepted) {
    const r = await pub.getTransactionReceipt({ hash });
    proofs++;
    emit({ kind: "tx", standin: true, what: "Veil Entry · acceptUSDC", hash, block: String(r.blockNumber), ev: "Deposit proof verified on-chain. Your private note enters the shielded pool." });
  }
  await stats();

  // 3. Private balance
  await sleep(1500);
  step("3 · Private balance");
  emit({ kind: "user", text: "What's my private balance?" });
  let bal: any;
  for (let i = 0; i < 60; i++) {
    bal = (await api("/v1/balance", { veil_signature: sig })).data;
    if (bal.status !== "computing") break;
    await sleep(1000);
  }
  emit({ kind: "tool", name: "hyde_balance", body: `Spendable: ${usd(bal.spendable_usdc)} USDC (found by scanning ${"2,4"}00+ encrypted notes in the pool)` });
  await stats({ priv: usd(bal.spendable_usdc) });
  let priv = Number(bal.spendable_usdc);

  // 4. Private payroll
  await sleep(1800);
  step("4 · Private payroll");
  const payees = [
    { label: "Alice (design)", to: "0x00000000000000000000000000000000000A11cE", to_chain: "base", amount: "120" },
    { label: "Bob (engineering)", to: "0x0000000000000000000000000000000000000B0b", to_chain: "arbitrum", amount: "150" },
    { label: "Chidi (ops)", to: "0x00000000000000000000000000000000000C4A01", to_chain: "optimism", amount: "100" },
  ];
  emit({ kind: "user", text: "Pay Alice 120 USDC on Base, Bob 150 on Arbitrum and Chidi 100 on Optimism. Privately." });
  const quote = (await api("/v1/payroll", { veil_signature: sig, payees })).data;
  await sleep(1200);
  emit({ kind: "tool", name: "hyde_payroll → quote", body: quote.items.map((x: any) => `${x.label.padEnd(18)} ${x.to_chain.padEnd(9)} receives ${x.receives}`).join("\n") + `\nPay ${quote.salaries_usdc} + fees ≤ ${quote.fees_at_most_usdc} = ${quote.total_at_most_usdc} USDC` });
  await sleep(3500);
  emit({ kind: "user", text: "Confirm." });
  const run = (await api("/v1/payroll", { veil_signature: sig, payees, confirm: true })).data;
  emit({ kind: "ai", html: "Paying everyone from your private balance. <b>No wallet signatures needed.</b>" });

  const seen = new Set<string>();
  let lastBox: { box?: Address; to?: string; openTx?: Hex } = {};
  for (let i = 0; i < 400; i++) {
    const job = (await api(`/v1/jobs/${run.job_id}`)).data;
    for (const p of job.payees) {
      if (!p.job_id) continue;
      const send = (await api(`/v1/jobs/${p.job_id}`)).data;
      if (send.veil_withdraw_tx && !seen.has(send.veil_withdraw_tx)) {
        seen.add(send.veil_withdraw_tx);
        proofs++;
        priv -= Number(send.amount_usdc);
        const r = await pub.getTransactionReceipt({ hash: send.veil_withdraw_tx });
        emit({ kind: "tx", standin: true, what: "Veil pool · withdrawUSDC", hash: send.veil_withdraw_tx, block: String(r.blockNumber),
          ev: send.exit_box ? `ZK proof verified. ${usd(send.amount_usdc)} USDC → ${p.label.split(" ")[0]}'s one-time ExitBox` : `ZK proof verified. ${usd(send.amount_usdc)} USDC → ${p.label.split(" ")[0]} on Base` });
        await stats({ priv: usd(Math.max(priv, 0)) });
      }
      if (send.bridge_tx && !seen.has(send.bridge_tx)) {
        seen.add(send.bridge_tx);
        const r = await pub.getTransactionReceipt({ hash: send.bridge_tx });
        const burned = r.logs.some((l) => l.address.toLowerCase() === MESSENGER.toLowerCase());
        emit({ kind: "tx", what: `ExitBox · Circle CCTP burn → ${send.to_chain[0].toUpperCase()}${send.to_chain.slice(1)}`, hash: send.bridge_tx, block: String(r.blockNumber),
          ev: `${burned ? "DepositForBurn emitted" : "burn"}: Circle mints to ${p.label.split(" ")[0]} on ${send.to_chain}` });
        lastBox = { box: send.exit_box, to: p.label, openTx: send.bridge_tx };
      }
    }
    const settled = job.payees.every((p: any) => ["bridging", "done", "failed"].includes(p.status));
    if (settled && job.status !== "checking" && job.status !== "sending") break;
    await sleep(1500);
  }

  // 5. Follow the money
  await sleep(2000);
  step("5 · Follow the money");
  if (lastBox.box) {
    const logs = await pub.getContractEvents({ address: USDC, abi: erc20Abi, eventName: "Transfer", args: { to: lastBox.box }, fromBlock: forkBlock });
    const from = logs.map((l) => l.args.from!.toLowerCase());
    const fromPool = from.includes(POOL.toLowerCase());
    const touched = [...seen].length > 0 && from.includes(wallet.address.toLowerCase());
    emit({ kind: "user", text: `Who paid ${lastBox.to?.split(" ")[0]}?` });
    await sleep(1500);
    emit({ kind: "ai", html: `${lastBox.to?.split(" ")[0]}'s ExitBox was funded by <b>${fromPool ? "the Veil pool" : "an unknown sender"}</b> (${POOL.slice(0, 6)}…${POOL.slice(-4)}). Your wallet appears in the payment: <b>${touched ? "yes" : "no"}</b>.` });
  }
  await sleep(6000);
  emit({ kind: "card", show: true, title: "Deposit from any chain. Spend on any chain. Privately.", sub: "On mainnet, Circle completes each mint on the destination chain; this fork stops at the burn. github.com/NECOKIZZ/hyde" });
  await sleep(6000);
  emit({ kind: "done" });
  writeFileSync(process.env.TIMELINE_OUT ?? "/tmp/hyde-demo-timeline.json", JSON.stringify(timeline, null, 1));
}

// ---- servers ----
startRelay(FORK, 8790, () => {});
const hyde = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: {
    ...process.env, PORT: "8801", HYDE_API_KEY: KEY, BASE_RPC_URL: FORK, VEIL_RELAY_URL: "http://127.0.0.1:8790",
    RELAYER_PRIVATE_KEY: relayerKey, EXIT_BOX_FACTORY: "0x5f0b5c773e04bb1173d7ea8e174442f4f22d53a7",
    JOBS_FILE: `/tmp/hyde-demo-jobs-${process.pid}.json`, WORKER_INTERVAL_MS: "2000", KEEPALIVE_URL: "",
  },
  stdio: ["ignore", "inherit", "inherit"],
});
process.on("exit", () => hyde.kill());

let started = false;
http
  .createServer((req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.url === "/start") {
      if (!started) {
        started = true;
        t0 = Date.now();
        run().catch((err) => { console.error(err); emit({ kind: "note", text: `error: ${err.message}` }); emit({ kind: "done" }); });
      }
      res.end("ok");
      return;
    }
    if (req.url === "/status") {
      res.end(JSON.stringify({ done: timeline.some((x) => x.kind === "done") }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(readFileSync(new URL("./dashboard.html", import.meta.url)));
  })
  .listen(8800, async () => {
    await setup();
    await waitApi();
    console.log("demo ready: http://127.0.0.1:8800  (GET /start to begin)");
  });
