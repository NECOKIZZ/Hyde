import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { atomicAmount, evmOutputSchema, proposeEvm, proposeSolana, solanaOutputSchema } from "./paybox.js";

const PROTOCOL_VERSION = "2026-07-28";

/** Veil's fixed key-derivation message. The same wallet always yields the same private balance. */
export const VEIL_MESSAGE =
  "Sign this message to create your Veil Wallet private key. This will be used to decrypt your balances. Ensure you are signing this message on the Veil Cash website.";

export const CHAINS = ["ethereum", "avalanche", "optimism", "arbitrum", "base", "polygon"] as const;

const veilSignature = z
  .string()
  .regex(/^0x[0-9a-fA-F]{130}$/, "65-byte EIP-191 signature, 0x-prefixed")
  .describe("Signature of the Veil message (see hyde_setup) from the user's PayBox EVM wallet via request_wallet_sign. Never stored.");
const chain = z.enum(CHAINS);
const anyChain = z.enum([...CHAINS, "solana"]);
const usdc = z.string().regex(/^\d+(\.\d{1,6})?$/, 'USDC amount such as "25" or "25.5"');

const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MAGICBLOCK_API = "https://payments.magicblock.app";
const solanaAddress = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "Solana base58 public key");

/** MagicBlock Private Payments: builds an unsigned private transfer for the sender's wallet. No API key. */
async function magicblockPrivateTransfer(input: { from: string; to: string; amount: string; hideTiming: boolean }) {
  const res = await fetch(`${MAGICBLOCK_API}/v1/spl/transfer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      from: input.from,
      to: input.to,
      mint: SOLANA_USDC,
      amount: Number(input.amount),
      visibility: "private",
      fromBalance: "base",
      toBalance: "base",
      // Optional settlement delay between 1 and 10 minutes, so arrival time doesn't reveal the sender.
      ...(input.hideTiming ? { minDelayMs: "60000", maxDelayMs: "600000" } : {}),
    }),
    signal: AbortSignal.timeout(7000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`MagicBlock: ${data?.error?.message ?? data?.message ?? data?.error ?? res.status}`);
  if (data.sendTo !== "base" || data.requiredSigners?.length !== 1 || data.requiredSigners[0] !== input.from) {
    throw new Error("MagicBlock returned a transaction PayBox cannot sign (unexpected signers or route).");
  }
  return data as { transactionBase64: string; fees: { lamports: string; tokens: string } };
}

/** The Hyde API runs ZK proofs and the relay; PayBox injects its x-hyde-key header as a brokered secret. */
async function hyde(path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const base = process.env.HYDE_API_URL;
  if (!base) throw new Error("HYDE_API_URL is not configured for this plugin.");
  const res = await fetch(new URL(path, base), {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(7000),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status >= 400) throw new Error(typeof data?.error === "string" ? data.error : `Hyde API error ${res.status}`);
  return { status: res.status, data };
}

const text = (s: string) => [{ type: "text" as const, text: s }];

const setupOutput = z
  .object({
    message_to_sign: z.string(),
    how_to_sign: z.string(),
    chains: z.array(z.string()),
    flow: z.array(z.string()),
  })
  .strict();

const balanceOutput = z
  .object({
    status: z.enum(["computing", "ready", "refreshing"]),
    spendable_usdc: z.string().optional(),
    clearing_usdc: z.string().optional(),
    screening_usdc: z.string().optional(),
    pending_deposits: z.array(z.record(z.string(), z.unknown())),
  })
  .strict();

const sendOutput = z
  .object({
    status: z.enum(["quote", "sending"]),
    route: z.string(),
    you_spend: z.string(),
    recipient_receives: z.string().optional(),
    recipient_receives_at_least: z.string().optional(),
    relayer_fee: z.string().optional(),
    bridge_fee_at_most: z.string().optional(),
    job_id: z.string().optional(),
    next: z.string(),
  })
  .strict();

const jobOutput = z.record(z.string(), z.unknown());

export function createServer() {
  const server = new McpServer({ name: "hyde", version: "0.1.0" }, { supportedProtocolVersions: [PROTOCOL_VERSION] });

  server.registerTool(
    "hyde_setup",
    {
      title: "Set up private payments",
      description:
        "Start here for any private payment. Pick the rail: (A) recipient is a Solana wallet and the user holds Solana USDC -> " +
        "hyde_instant_send, no setup or signature needed. (B) anything else -> Vault: 1) sign message_to_sign once with the PayBox EVM " +
        "wallet (request_wallet_sign) and reuse that one signature as veil_signature for every Hyde call this session; 2) hyde_balance; " +
        "3) if spendable_usdc is below the amount to send, the user must hyde_deposit first (min 20.1 USDC, from the chain where " +
        "get_portfolio shows their USDC) and wait for it to clear (~15 min the first time); 4) hyde_send or hyde_payroll. " +
        "Never try to pay a Vault recipient straight from the public PayBox balance: that is not private.",
      inputSchema: z.object({}).strict(),
      outputSchema: setupOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const out = {
        message_to_sign: VEIL_MESSAGE,
        how_to_sign:
          "Call PayBox request_wallet_sign with the user's EVM wallet and a personal (EIP-191) message intent over message_to_sign, exactly as written. Use the returned signature as veil_signature.",
        chains: [...CHAINS, "solana"],
        flow: [
          "Instant (Solana): hyde_instant_send pays a Solana address privately from the user's Solana USDC in one approval. No deposit, no waiting; MagicBlock's private rollup breaks the link between sender and recipient. No signature from setup is needed.",
          "Vault: deposit from any chain, spend on any chain, privately (strongest privacy):",
          "1. hyde_deposit (EVM chains) or hyde_deposit_solana moves public USDC into the user's private balance (Veil Cash pool on Base). First deposits clear compliance screening, typically ~15 minutes.",
          "2. hyde_balance shows the private balance.",
          "3. hyde_send pays anyone on any listed chain, Solana included, from the private balance. Quote first, then confirm. No wallet signature: the user's address never appears in the payment.",
          "4. hyde_payroll pays up to 25 people at once, each on any chain, each receiving their exact amount.",
          "5. hyde_status tracks sends, payroll runs and deposits.",
        ],
      };
      return { content: text(`Sign this exact message with the PayBox EVM wallet:\n\n${VEIL_MESSAGE}`), structuredContent: out };
    },
  );

  server.registerTool(
    "hyde_instant_send",
    {
      title: "Send privately now (Solana)",
      description:
        "Pays a Solana address in USDC privately, in one approval, with no deposit or waiting. The transfer routes through " +
        "MagicBlock's private rollup so the payment can't be linked from sender to recipient on-chain. " +
        "Set hide_timing to delay settlement by a random 1-10 minutes for stronger privacy. Fee: 0.1% in USDC, plus ~0.002 SOL account rent the first time. " +
        "Pass the user's Solana wallet address as sender. Needs Solana USDC in that wallet plus ~0.005 SOL for fees; if short, tell the user instead of trying other tools.",
      inputSchema: z
        .object({
          sender: solanaAddress.describe("The user's PayBox Solana wallet address (public key)"),
          to: solanaAddress.describe("Recipient Solana wallet address"),
          amount: usdc.describe("USDC to send"),
          hide_timing: z.boolean().optional().describe("Delay settlement 1-10 minutes at random"),
        })
        .strict(),
      outputSchema: solanaOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ sender, to, amount, hide_timing }) => {
      if (sender === to) throw new Error("Sender and recipient are the same wallet.");
      const atomic = atomicAmount(amount, 6);
      if (BigInt(atomic) <= 0n) throw new Error("Amount must be above 0.");
      const tx = await magicblockPrivateTransfer({ from: sender, to, amount: atomic, hideTiming: hide_timing ?? false });
      const fee = Number(tx.fees.tokens) / 1e6;
      const result = proposeSolana({ transactionBase64: tx.transactionBase64 });
      const lines = [
        `Private transfer of ${amount} USDC on Solana to ${to}.`,
        `Privacy fee: ${fee} USDC${Number(tx.fees.lamports) > 0 ? `, plus ~${Number(tx.fees.lamports) / 1e9} SOL one-time account rent` : ""}.`,
        hide_timing ? "Settles privately after a random 1–10 minute delay." : "Settles privately within seconds of confirmation.",
        "Nothing has been signed: PayBox will show the transaction for approval.",
      ];
      return { ...result, content: text(lines.join("\n")) };
    },
  );

  server.registerTool(
    "hyde_deposit",
    {
      title: "Go private",
      description:
        "Deposits public USDC from the user's PayBox wallet straight into the Veil private pool on Base. This is how the private " +
        "balance gets funded; hyde_send and hyde_payroll spend only from it. From Base: call with the same arguments repeatedly, " +
        "waiting for each proposed transaction to confirm before the next call; each call proposes the next step (register once, " +
        "approve, deposit) until step is \"deposit\". From another chain: step=approve, then step=bridge (Circle delivers to the user's " +
        "own Base wallet), then the Base steps for the amount that arrived. Minimum 20.1 USDC on Base. After the deposit confirms, " +
        "poll hyde_balance until spendable_usdc covers the payment (first deposit: ~15 min screening).",
      inputSchema: z
        .object({
          veil_signature: veilSignature,
          from_chain: chain,
          amount: usdc.describe("USDC to send from the source chain"),
          step: z.enum(["approve", "bridge"]).optional().describe("Cross-chain only: approve first, then bridge"),
        })
        .strict(),
      outputSchema: evmOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const { data } = await hyde("/v1/deposit", args);
      const result = proposeEvm({ chain: `eip155:${data.call.chain_id}`, to: data.call.to, value: data.call.value, data: data.call.data });
      const lines = [
        `${data.call.description}.`,
        `Step: ${data.step}.`,
        data.step === "deposit" && data.arrives_at_least ? `About ${data.arrives_at_least} USDC enters the private pool; Veil keeps 0.3%.` : "",
        data.next_step ? `Next: ${data.next_step}.` : "After this confirms, the deposit clears Veil's screening (typically ~15 min). Check with hyde_balance.",
        "Nothing has been signed: PayBox will show the transaction for approval.",
      ];
      return { ...result, content: text(lines.filter(Boolean).join("\n")) };
    },
  );

  server.registerTool(
    "hyde_deposit_solana",
    {
      title: "Go private from Solana",
      description:
        "Moves public USDC from the user's Solana wallet into their private balance. Returns the exact PayBox request_swap " +
        "(bridge) arguments to run next: Solana USDC → Base USDC, delivered to the user's own Base wallet; then run hyde_deposit " +
        "with from_chain=base for the amount that arrived. Minimum 21 USDC.",
      inputSchema: z.object({ veil_signature: veilSignature, amount: usdc.describe("USDC to send from Solana") }).strict(),
      outputSchema: z
        .object({
          job_id: z.string(),
          inbox: z.string(),
          paybox_tool: z.literal("request_swap"),
          arguments: z.record(z.string(), z.string()),
          note: z.string(),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const { data } = await hyde("/v1/deposit/solana", args);
      return {
        content: text(
          `Next: call PayBox request_swap with the user's Solana wallet to bridge ${args.amount} USDC to Base, ` +
            `recipient ${data.inbox} (the user's own Base wallet). After it lands, call hyde_deposit with from_chain=base for the amount that arrived.`,
        ),
        structuredContent: data,
      };
    },
  );

  server.registerTool(
    "hyde_balance",
    {
      title: "Private balance",
      description:
        "Shows the user's private USDC balance (spendable_usdc) and deposits still clearing (clearing/screening). Check it before hyde_send or " +
        "hyde_payroll. If status is computing, wait ~10 seconds and call again with the same signature; do not call other tools meanwhile. " +
        "screening_usdc is a deposit still in Veil's compliance check.",
      inputSchema: z.object({ veil_signature: veilSignature }).strict(),
      outputSchema: balanceOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const { data } = await hyde("/v1/balance", args);
      const out = balanceOutput.parse(data);
      const summary =
        out.status === "computing"
          ? "Scanning the private pool… call hyde_balance again in ~10 seconds with the same signature."
          : `Private balance: ${out.spendable_usdc} USDC spendable` +
            (Number(out.clearing_usdc) || Number(out.screening_usdc) ? `, ${Number(out.clearing_usdc) + Number(out.screening_usdc)} USDC still clearing.` : ".");
      return { content: text(summary), structuredContent: out };
    },
  );

  server.registerTool(
    "hyde_send",
    {
      title: "Send privately",
      description:
        "Pays a recipient on any supported chain, Solana included, from the private balance, without the user's wallet appearing on-chain. " +
        "For Solana, pass a Solana wallet address as `to` and an EVM fallback_address (refund on Base if the bridge reverts). " +
        "Call without confirm to get a quote and show it to the user; call again with confirm=true only after they agree. " +
        "No PayBox signature is needed. Spends only the private balance: if hyde_balance shows less spendable_usdc than the amount, " +
        "tell the user to hyde_deposit first rather than retrying.",
      inputSchema: z
        .object({
          veil_signature: veilSignature,
          to: z
            .string()
            .regex(/^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/)
            .describe("Recipient address: EVM, or a Solana wallet when to_chain is solana"),
          to_chain: anyChain,
          fallback_address: z
            .string()
            .regex(/^0x[0-9a-fA-F]{40}$/)
            .optional()
            .describe("Solana sends only: EVM address that receives the USDC on Base if the bridge reverts"),
          amount: usdc.describe("USDC to spend from the private balance"),
          confirm: z.boolean().optional().describe("true only after the user approved the quote"),
        })
        .strict(),
      outputSchema: sendOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const { data } = await hyde("/v1/send", args);
      const out = sendOutput.parse(data);
      const receives = out.recipient_receives ?? `at least ${out.recipient_receives_at_least}`;
      const summary =
        out.status === "quote"
          ? `Quote: spend ${out.you_spend} USDC privately; recipient gets ${receives} USDC on ${args.to_chain}. Ask the user, then call with confirm=true.`
          : `Sending privately (job ${out.job_id}). Track with hyde_status.`;
      return { content: text(summary), structuredContent: out };
    },
  );

  const payee = z
    .object({
      to: z.string().regex(/^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/).describe("EVM address, or Solana wallet when to_chain is solana"),
      to_chain: anyChain,
      amount: usdc.describe("Exact USDC this payee receives; fees are added on top"),
      label: z.string().max(64).optional().describe("Name or role, e.g. \"Ada (design)\""),
      fallback_address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional().describe("Solana payees only: EVM refund address on Base"),
    })
    .strict();
  const payrollOutput = z
    .object({
      status: z.enum(["quote", "sending"]),
      payees: z.number(),
      salaries_usdc: z.string(),
      fees_at_most_usdc: z.string(),
      total_at_most_usdc: z.string(),
      items: z.array(z.object({ label: z.string().optional(), to: z.string(), to_chain: z.string(), receives: z.string(), costs: z.string() }).strict()),
      job_id: z.string().optional(),
      next: z.string(),
    })
    .strict();

  server.registerTool(
    "hyde_payroll",
    {
      title: "Run private payroll",
      description:
        "Pays up to 25 people at once from the private balance, each on any supported chain (Solana included). Every payee " +
        "receives exactly their amount; fees are added on top. Outsiders can't link the payments to the payer or to each other. " +
        "Call without confirm to get the total and show it to the user; call again with confirm=true only after they approve. " +
        "If the private balance can't cover the whole run, nobody is paid. No PayBox signature is needed. Check hyde_balance first; " +
        "if spendable_usdc is below total_at_most_usdc, the user must hyde_deposit first.",
      inputSchema: z
        .object({
          veil_signature: veilSignature,
          payees: z.array(payee).min(1).max(25),
          confirm: z.boolean().optional().describe("true only after the user approved the quote"),
        })
        .strict(),
      outputSchema: payrollOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const { data } = await hyde("/v1/payroll", args);
      const out = payrollOutput.parse(data);
      const summary =
        out.status === "quote"
          ? `Payroll for ${out.payees} people: ${out.salaries_usdc} USDC in pay + up to ${out.fees_at_most_usdc} USDC fees = up to ${out.total_at_most_usdc} USDC from the private balance. Ask the user, then call with confirm=true.`
          : `Payroll started (job ${out.job_id}). Each payee is paid in turn, about a minute each. Track with hyde_status.`;
      return { content: text(summary), structuredContent: out };
    },
  );

  server.registerTool(
    "hyde_status",
    {
      title: "Track a private send, payroll or deposit",
      description: "Status of a Hyde job by job_id (sends, payroll runs and deposits).",
      inputSchema: z.object({ job_id: z.string().uuid() }).strict(),
      outputSchema: jobOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ job_id }) => {
      const { data } = await hyde(`/v1/jobs/${job_id}`);
      return { content: text(`Job ${job_id}: ${data.status}${data.error ? ` (${data.error})` : ""}`), structuredContent: data };
    },
  );

  return server;
}

if (process.env.HYDE_NO_STDIO !== "1") serveStdio(createServer, { legacy: "reject" });
