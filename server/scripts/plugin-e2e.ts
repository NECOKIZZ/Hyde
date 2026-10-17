// End-to-end: bundled plugin.mjs (fresh process per call, like PayBox's sandbox) → broker proxy that
// injects x-hyde-key (like PayBox brokered secrets) → Hyde API → live Base / Circle / Veil.
// Moves no money. Usage: tsx scripts/plugin-e2e.ts (needs Node 24 at NODE24 for the plugin).
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { createInterface } from "node:readline";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { VEIL_SIGNED_MESSAGE } from "@veil-cash/sdk";

const NODE24 = process.env.NODE24 ?? "/opt/node24/bin/node";
const PLUGIN = new URL("../../plugin/dist/plugin.mjs", import.meta.url).pathname;
const API_PORT = 8797;
const BROKER_PORT = 8798;
const KEY = "e2e-test-key-0123456789abcdef";

function startApi(): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(API_PORT),
      HYDE_API_KEY: KEY,
      // Never funded: only used to compute addresses in quotes.
      RELAYER_PRIVATE_KEY: generatePrivateKey(),
      EXIT_BOX_FACTORY: "0x000000000000000000000000000000000000dEaD",
      JOBS_FILE: `/tmp/hyde-e2e-jobs-${process.pid}.json`,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
}

function startBroker(): http.Server {
  return http
    .createServer((req, res) => {
      const upstream = http.request(
        { host: "127.0.0.1", port: API_PORT, path: req.url, method: req.method, headers: { ...req.headers, "x-hyde-key": KEY } },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        },
      );
      req.pipe(upstream);
    })
    .listen(BROKER_PORT);
}

async function callTool(name: string, args: Record<string, unknown>) {
  const started = Date.now();
  const child = spawn(NODE24, [PLUGIN], { env: { ...process.env, HYDE_API_URL: `http://127.0.0.1:${BROKER_PORT}` }, stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout! });
  child.stdin!.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "e2e", version: "0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }) + "\n",
  );
  for await (const line of lines) {
    const msg = JSON.parse(line);
    if (msg.id !== 1) continue;
    child.kill();
    const ms = Date.now() - started;
    assert.ok(ms < 10_000, `${name} took ${ms}ms (PayBox limit is 10s)`);
    if (msg.error) throw new Error(`${name}: JSON-RPC error ${JSON.stringify(msg.error)}`);
    console.log(`  ${name} ${JSON.stringify(args.step ?? args.confirm ?? args.hide_timing ?? (Array.isArray(args.payees) ? `${args.payees.length} payees` : ""))} → ${msg.result.isError ? `isError (${String(msg.result.content?.[0]?.text).slice(0, 90)})` : "ok"} in ${ms}ms`);
    return msg.result;
  }
  throw new Error(`${name}: plugin exited without a response`);
}

const proposal = (r: any) => r.structuredContent["io.paybox/transactionProposal"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const api = startApi();
const broker = startBroker();
try {
  for (let i = 0; i < 40; i++) {
    const ok = await fetch(`http://127.0.0.1:${API_PORT}/health`).then((r) => r.ok).catch(() => false);
    if (ok) break;
    await sleep(500);
  }
  // A throwaway wallet stands in for the user's PayBox EVM wallet.
  const wallet = privateKeyToAccount(generatePrivateKey());
  const veil_signature = await wallet.signMessage({ message: VEIL_SIGNED_MESSAGE });

  const setup = await callTool("hyde_setup", {});
  assert.equal(setup.structuredContent.message_to_sign, VEIL_SIGNED_MESSAGE);

  // Hyde Instant: MagicBlock private transfer on Solana, one PayBox proposal, no backend.
  const SENDER = "3rXKwQ1kpjBd5tdcco32qsvqUh1BnZjcYnS5kYrP7AYE";
  const RECIPIENT = "Bt9oNR5cCtnfuMmXgWELd6q5i974PdEMQDUE55nBC57L";
  for (const hide_timing of [false, true]) {
    const instant = proposal(await callTool("hyde_instant_send", { sender: SENDER, to: RECIPIENT, amount: "2.5", hide_timing }));
    assert.equal(instant.kind, "solana");
    assert.equal(instant.chain, "solana:mainnet");
    const raw = Buffer.from(instant.transaction.transactionBase64, "base64");
    assert.ok(raw.length <= 1232, "fits a Solana packet");
    assert.equal(raw[0], 1, "one signature slot");
    assert.ok(raw.subarray(1, 65).every((b) => b === 0), "unsigned");
    assert.equal(raw[66], 1, "exactly one required signer (the sender, also fee payer)");
  }
  assert.equal((await callTool("hyde_instant_send", { sender: SENDER, to: SENDER, amount: "1" })).isError, true);
  assert.equal((await callTool("hyde_instant_send", { sender: "not-a-key", to: RECIPIENT, amount: "1" })).isError, true);

  // The test wallet holds no USDC: every deposit route must refuse before proposing anything.
  // (The proposal shapes are exercised against real contracts by demo/run-demo.ts on a Base fork.)
  for (const args of [
    { from_chain: "base", amount: "25" },
    { from_chain: "arbitrum", amount: "25", step: "approve" },
    { from_chain: "arbitrum", amount: "25", step: "bridge" },
  ]) {
    const refused = await callTool("hyde_deposit", { veil_signature, ...args });
    assert.equal(refused.isError, true, `unfunded ${args.from_chain} deposit is refused`);
    assert.match(refused.content[0].text, /Nothing was proposed/);
  }

  const tooSmall = await callTool("hyde_deposit", { veil_signature, from_chain: "base", amount: "5" });
  assert.equal(tooSmall.isError, true);

  const badSig = await callTool("hyde_balance", { veil_signature: "0x1234" });
  assert.equal(badSig.isError, true, "schema rejects malformed signatures");

  let balance;
  for (let i = 0; i < 20; i++) {
    balance = await callTool("hyde_balance", { veil_signature });
    if (balance.structuredContent?.status !== "computing") break;
    await sleep(3000);
  }
  assert.equal(balance.structuredContent.status, "ready");
  assert.equal(balance.structuredContent.spendable_usdc, "0");

  // Solana in: instructions for PayBox's own bridge to the user's Base wallet, then the Base deposit steps.
  const solIn = await callTool("hyde_deposit_solana", { veil_signature, amount: "25" });
  assert.equal(solIn.structuredContent.paybox_tool, "request_swap");
  assert.equal(solIn.structuredContent.arguments.recipient.toLowerCase(), wallet.address.toLowerCase(), "Solana deposits bridge to the user's own Base wallet");
  assert.equal(solIn.structuredContent.arguments.src_chain, "solana");
  assert.equal((await callTool("hyde_deposit_solana", { veil_signature, amount: "5" })).isError, true);

  // Solana out: quote to a wallet that has a USDC account; refuse wallets without one, and missing fallbacks.
  const SOL_WITH_USDC = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const solQuote = await callTool("hyde_send", { veil_signature, to: SOL_WITH_USDC, to_chain: "solana", amount: "20", fallback_address: wallet.address });
  assert.equal(solQuote.structuredContent.status, "quote");
  assert.match(solQuote.structuredContent.route, /Solana/);
  assert.ok(Number(solQuote.structuredContent.recipient_receives_at_least) > 19.6);
  assert.equal((await callTool("hyde_send", { veil_signature, to: SOL_WITH_USDC, to_chain: "solana", amount: "20" })).isError, true);
  assert.equal((await callTool("hyde_send", { veil_signature, to: "Bt9oNR5cCtnfuMmXgWELd6q5i974PdEMQDUE55nBC57L", to_chain: "solana", amount: "20", fallback_address: wallet.address })).isError, true);

  // Payroll across chains: each payee nets their exact amount; fees are added on top.
  const payees = [
    { label: "Ada (design)", to: "0x000000000000000000000000000000000000bEEF", to_chain: "base", amount: "300" },
    { label: "Tunde (eng)", to: "0x000000000000000000000000000000000000cafe", to_chain: "arbitrum", amount: "450.5" },
    { label: "Chidi (ops)", to: SOL_WITH_USDC, to_chain: "solana", amount: "200", fallback_address: wallet.address },
  ];
  const payQuote = (await callTool("hyde_payroll", { veil_signature, payees })).structuredContent;
  assert.equal(payQuote.status, "quote");
  assert.equal(payQuote.payees, 3);
  assert.equal(payQuote.salaries_usdc, "950.5");
  for (const item of payQuote.items) assert.ok(Number(item.costs) >= Number(item.receives), "fees are on top");
  assert.equal(payQuote.items[0].costs, "300", "Base payees cost exactly their pay");
  const sumCosts = payQuote.items.reduce((t: number, i: any) => t + Number(i.costs), 0);
  assert.ok(Math.abs(sumCosts - Number(payQuote.total_at_most_usdc)) < 1e-6);
  console.log(`  payroll quote: ${payQuote.salaries_usdc} pay + ${payQuote.fees_at_most_usdc} fees = ${payQuote.total_at_most_usdc}`);

  const badPayee = await callTool("hyde_payroll", { veil_signature, payees: [payees[0], { ...payees[2], fallback_address: undefined }] });
  assert.equal(badPayee.isError, true);
  assert.match(badPayee.content[0].text, /Payee 2/);

  // Cross-chain payees need Hyde's relayer to have gas; this test relayer has none, so nothing may start.
  const noGas = await callTool("hyde_payroll", { veil_signature, payees, confirm: true });
  assert.equal(noGas.isError, true);
  assert.match(noGas.content[0].text, /relayer is low on gas/);

  // Base-only payroll needs no relayer: it must stop on the short private balance with nobody paid.
  const basePayees = payees.filter((p) => p.to_chain === "base");
  const run = await callTool("hyde_payroll", { veil_signature, payees: basePayees, confirm: true });
  assert.equal(run.structuredContent.status, "sending");
  let runStatus;
  for (let i = 0; i < 30; i++) {
    runStatus = (await callTool("hyde_status", { job_id: run.structuredContent.job_id })).structuredContent;
    if (["failed", "done", "partial"].includes(runStatus.status)) break;
    await sleep(3000);
  }
  assert.equal(runStatus.status, "failed");
  assert.match(runStatus.error, /Nobody was paid/);
  assert.ok(runStatus.payees.every((p: any) => p.status === "queued" && !p.job_id), "no payee was attempted");
  console.log(`  short balance stopped payroll safely: ${runStatus.error}`);

  const quote = await callTool("hyde_send", { veil_signature, to: "0x000000000000000000000000000000000000bEEF", to_chain: "arbitrum", amount: "20" });
  assert.equal(quote.structuredContent.status, "quote");
  assert.ok(Number(quote.structuredContent.recipient_receives_at_least) > 19.8);

  const sent = await callTool("hyde_send", { veil_signature, to: "0x000000000000000000000000000000000000bEEF", to_chain: "base", amount: "1", confirm: true });
  assert.equal(sent.structuredContent.status, "sending");
  let status;
  for (let i = 0; i < 30; i++) {
    status = await callTool("hyde_status", { job_id: sent.structuredContent.job_id });
    if (status.structuredContent.status === "failed") break;
    await sleep(3000);
  }
  assert.equal(status.structuredContent.status, "failed", "an empty private balance cannot send");
  console.log(`  empty-balance send failed safely: ${status.structuredContent.error}`);

  const unknown = await callTool("hyde_status", { job_id: "00000000-0000-4000-8000-000000000000" });
  assert.equal(unknown.isError, true);

  console.log("plugin e2e: all checks passed");
} finally {
  broker.close();
  api.kill();
}
