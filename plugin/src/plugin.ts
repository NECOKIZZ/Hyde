import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { evmOutputSchema, proposeEvm } from "./paybox.js";

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
const usdc = z.string().regex(/^\d+(\.\d{1,6})?$/, 'USDC amount such as "25" or "25.5"');

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
        "Start here. Explains how Hyde works and returns the exact message the user's PayBox EVM wallet must sign. " +
        "Pass that signature as veil_signature to every other Hyde tool.",
      inputSchema: z.object({}).strict(),
      outputSchema: setupOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const out = {
        message_to_sign: VEIL_MESSAGE,
        how_to_sign:
          "Call PayBox request_wallet_sign with the user's EVM wallet and a personal (EIP-191) message intent over message_to_sign, exactly as written. Use the returned signature as veil_signature.",
        chains: [...CHAINS],
        flow: [
          "1. hyde_deposit moves public USDC from any listed chain into the user's private balance (Veil Cash pool on Base). First deposits clear compliance screening, typically ~15 minutes.",
          "2. hyde_balance shows the private balance.",
          "3. hyde_send pays anyone on any listed chain from the private balance. Quote first, then confirm. No wallet signature: the user's address never appears in the payment.",
          "4. hyde_status tracks a send.",
        ],
      };
      return { content: text(`Sign this exact message with the PayBox EVM wallet:\n\n${VEIL_MESSAGE}`), structuredContent: out };
    },
  );

  server.registerTool(
    "hyde_deposit",
    {
      title: "Go private",
      description:
        "Proposes moving public USDC into the user's private balance. From Base: one USDC transfer. From another chain: " +
        "call with step=approve, wait for that transaction to confirm, then call with step=bridge (Circle CCTP delivers to Base automatically). " +
        "Minimum 20.1 USDC arriving on Base.",
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
        data.inbox ? `Private inbox on Base: ${data.inbox}.` : "",
        data.arrives_at_least ? `At least ${data.arrives_at_least} USDC reaches the inbox; Veil keeps 0.3%.` : "",
        data.next_step ? `After this confirms, call hyde_deposit again with step="${data.next_step}".` : "After this confirms, the balance clears screening (typically ~15 min). Check with hyde_balance.",
        "Nothing has been signed: PayBox will show the transaction for approval.",
      ];
      return { ...result, content: text(lines.filter(Boolean).join("\n")) };
    },
  );

  server.registerTool(
    "hyde_balance",
    {
      title: "Private balance",
      description:
        "Shows the user's private USDC balance and deposits still clearing. Scanning the pool can take a while: if status is computing, call again in a few seconds.",
      inputSchema: z.object({ veil_signature: veilSignature }).strict(),
      outputSchema: balanceOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const { data } = await hyde("/v1/balance", args);
      const out = balanceOutput.parse(data);
      const summary =
        out.status === "computing"
          ? "Scanning the private pool… call hyde_balance again in ~5 seconds."
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
        "Pays a recipient on any supported chain from the private balance, without the user's wallet appearing on-chain. " +
        "Call without confirm to get a quote and show it to the user; call again with confirm=true only after they agree. " +
        "No PayBox signature is needed.",
      inputSchema: z
        .object({
          veil_signature: veilSignature,
          to: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("Recipient EVM address"),
          to_chain: chain,
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

  server.registerTool(
    "hyde_status",
    {
      title: "Track a private send or deposit",
      description: "Status of a Hyde job by job_id.",
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
