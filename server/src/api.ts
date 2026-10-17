import { randomBytes, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { VEIL_SIGNED_MESSAGE } from "@veil-cash/sdk";
import { getAddress, isAddress, isHex, toHex, type Hex } from "viem";
import { z } from "zod";
import { approveCall, burnCall, formatUsdc, maxFeeFor, parseUsdc, quoteFees, transferCall, type UnsignedCall } from "./cctp.js";
import { CHAIN_KEYS, chainInfo, type ChainKey } from "./chains.js";
import { relayerAccount } from "./clients.js";
import { evmRecipient, exitParams, predictExitBox, usdcBalanceOnBase } from "./exitbox.js";
import { SOLANA, isSolanaAddress, toBytes32, usdcAccountExists, usdcTokenAccount } from "./solana.js";
import { createJob, getJob, pendingShields, requestBalance, startPayroll, startSend, type ExitJob, type Job, type PayrollJob, type ShieldJob } from "./jobs.js";
import { MIN_SHIELD_USDC, inboxSlot, keypairFrom } from "./veil.js";

const chain = z.enum(CHAIN_KEYS);
const anyChain = z.enum([...CHAIN_KEYS, "solana"]);
const BASE_DOMAIN = chainInfo("base").domain;
/** Solana deposits go through PayBox's own bridge; leave room for its fees above Veil's minimum. */
const MIN_SOLANA_DEPOSIT = 21_000_000n;
const usdc = z.string().regex(/^\d+(\.\d{1,6})?$/);
const auth = z
  .object({ veil_signature: z.string().optional(), veil_key: z.string().optional() })
  .refine((a) => a.veil_signature || a.veil_key, "veil_signature is required")
  .refine((a) => [a.veil_signature, a.veil_key].every((v) => v === undefined || isHex(v)), "must be 0x-prefixed hex");

/** Relayer fee per destination: our Base gas to open the exit box. Circle's forwarding fee is separate. */
function relayerFee(): bigint {
  return parseUsdc(process.env.RELAYER_FEE_USDC ?? "0.03");
}

const MAX_PAYEES = 25;
const payeeSchema = z.object({ to: z.string(), to_chain: anyChain, amount: usdc, fallback_address: z.string().optional() });
type Payee = z.infer<typeof payeeSchema>;
type ExitTemplate = Omit<ExitJob, "id" | "createdAt" | "updatedAt" | "log">;

/**
 * Resolves a payee to an exit job. exactOut: the recipient gets at least `amount` and fees are added on
 * top (payroll); otherwise fees come out of `amount` (single sends).
 */
async function prepareExit(p: Payee, opts: { exactOut: boolean }): Promise<{ quote: Record<string, string>; job: ExitTemplate; spend: bigint }> {
  const amount = parseUsdc(p.amount);
  if (amount === 0n) throw new ApiError(422, "Amount must be above 0.");
  const to = p.to_chain;
  let recipient: string;
  let target: ReturnType<typeof evmRecipient>;
  if (to === "solana") {
    if (!isSolanaAddress(p.to)) throw new ApiError(400, "to must be a Solana wallet address");
    if (!p.fallback_address || !isAddress(p.fallback_address)) {
      throw new ApiError(400, "Sending to Solana needs fallback_address: an EVM address that receives the USDC on Base if the bridge reverts.");
    }
    if (!(await usdcAccountExists(p.to))) {
      throw new ApiError(422, "The recipient has no USDC account on Solana yet. Ask them to receive any USDC once first (CCTP can only mint into an existing account).");
    }
    recipient = p.to;
    target = { destinationDomain: SOLANA.domain, mintRecipient: toBytes32(usdcTokenAccount(p.to)), fallbackRecipient: getAddress(p.fallback_address) };
  } else {
    if (!isAddress(p.to)) throw new ApiError(400, "to must be an EVM address");
    recipient = getAddress(p.to);
    target = evmRecipient(to, recipient as `0x${string}`);
  }

  if (to === "base") {
    return {
      quote: { route: "Veil pool → recipient on Base", you_spend: p.amount, recipient_receives: p.amount },
      job: { kind: "exit", status: "proving", to, recipient, amount: amount.toString() },
      spend: amount,
    };
  }

  const fee = relayerFee();
  const fees = await quoteFees(BASE_DOMAIN, target.destinationDomain);
  let maxFee: bigint;
  let spend: bigint;
  if (opts.exactOut) {
    // Size the cap on the grossed-up amount so the recipient still nets `amount`.
    maxFee = maxFeeFor(amount + maxFeeFor(amount, fees), fees);
    spend = amount + maxFee + fee;
  } else {
    maxFee = maxFeeFor(amount - fee, fees);
    if (amount <= fee + maxFee) throw new ApiError(422, `Too small: fees are up to ${formatUsdc(fee + maxFee)} USDC.`);
    spend = amount;
  }
  const params = exitParams({ ...target, maxFee, relayer: relayerAccount().address, relayerFee: fee });
  const salt = toHex(randomBytes(32));
  return {
    quote: {
      route: `Veil pool (Base) → one-time exit box → Circle CCTP → ${to === "solana" ? SOLANA.name : chainInfo(to).name}`,
      you_spend: formatUsdc(spend),
      relayer_fee: formatUsdc(fee),
      bridge_fee_at_most: formatUsdc(maxFee),
      recipient_receives_at_least: formatUsdc(spend - fee - maxFee),
    },
    job: {
      kind: "exit",
      status: "proving",
      to,
      recipient,
      amount: spend.toString(),
      params: { ...params, maxFee: maxFee.toString(), relayerFee: fee.toString() },
      salt,
      box: predictExitBox(params, salt),
    },
    spend,
  };
}

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function callView(c: UnsignedCall) {
  return { chain_id: c.chainId, to: c.to, value: c.value, data: c.data, description: c.description };
}

function jobView(job: Job) {
  const base = { job_id: job.id, kind: job.kind, status: job.status, updated_at: job.updatedAt, error: job.error, log: job.log.slice(-5) };
  if (job.kind === "shield") {
    return { ...base, from_chain: job.src, amount_usdc: formatUsdc(BigInt(job.amount)), inbox: job.slot.forwarderAddress, sweep_tx: job.sweepTx };
  }
  if (job.kind === "payroll") {
    return {
      ...base,
      total_at_most_usdc: formatUsdc(BigInt(job.total)),
      payees: job.items.map((item) => {
        const send = item.job_id ? getJob(item.job_id) : undefined;
        return { ...item, status: send?.status ?? "queued", error: send?.error, delivery_tx: send?.kind === "exit" ? send.forwardTx ?? send.withdrawTx : undefined };
      }),
    };
  }
  return {
    ...base,
    to_chain: job.to,
    recipient: job.recipient,
    amount_usdc: formatUsdc(BigInt(job.amount)),
    veil_withdraw_tx: job.withdrawTx,
    exit_box: job.box,
    bridge_tx: job.openTx,
    delivery_tx: job.forwardTx,
  };
}

const route =
  (fn: (req: Request) => Promise<{ status?: number; body: unknown }>) =>
  async (req: Request, res: Response) => {
    try {
      const { status = 200, body } = await fn(req);
      res.status(status).json(body);
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
      const status = err instanceof ApiError ? err.status : 500;
      if (status === 500) console.error(err);
      res.status(status).json({ error: (err as Error).message });
    }
  };

function requireKey(req: Request, res: Response, next: NextFunction) {
  const want = Buffer.from(process.env.HYDE_API_KEY ?? "");
  const given = Buffer.from(req.header("x-hyde-key") ?? "");
  if (want.length < 16 || given.length !== want.length || !timingSafeEqual(given, want)) {
    res.status(401).json({ error: "Not authorized" });
    return;
  }
  next();
}

export function buildApi() {
  const api = express.Router();
  api.use(express.json({ limit: "32kb" }));
  api.use(requireKey);

  api.get("/info", route(async () => ({
    body: {
      sign_this_message: VEIL_SIGNED_MESSAGE,
      chains: [...CHAIN_KEYS.map((k) => ({ key: k, name: chainInfo(k).name })), { key: SOLANA.key, name: SOLANA.name }],
      min_deposit_usdc: formatUsdc(MIN_SHIELD_USDC),
      relayer_fee_usdc: formatUsdc(relayerFee()),
    },
  })));

  // Go private: one unsigned call per step. Cross-chain needs "approve" then "bridge".
  api.post("/deposit", route(async (req) => {
    const body = auth.and(z.object({ from_chain: chain, amount: usdc, step: z.enum(["approve", "bridge"]).optional() })).parse(req.body);
    const kp = keypairFrom({ veil_signature: body.veil_signature as Hex | undefined, veil_key: body.veil_key as Hex | undefined });
    const amount = parseUsdc(body.amount);
    const slot = await inboxSlot(kp);

    if (body.from_chain === "base") {
      if (amount < MIN_SHIELD_USDC) throw new ApiError(422, `Minimum is ${formatUsdc(MIN_SHIELD_USDC)} USDC.`);
      const job = createJob<ShieldJob>({ kind: "shield", status: "awaiting_funds", src: "base", amount: amount.toString(), slot });
      return {
        body: {
          step: "transfer",
          next_step: null,
          job_id: job.id,
          inbox: slot.forwarderAddress,
          arrives_at_least: formatUsdc(amount),
          call: callView(transferCall("base", slot.forwarderAddress, amount, `Send ${body.amount} USDC to your private inbox on Base`)),
        },
      };
    }

    const step = body.step ?? "approve";
    if (step === "approve") {
      return { body: { step, next_step: "bridge", call: callView(approveCall(body.from_chain, amount)) } };
    }
    const fees = await quoteFees(chainInfo(body.from_chain).domain, BASE_DOMAIN);
    const maxFee = maxFeeFor(amount, fees);
    if (amount - maxFee < MIN_SHIELD_USDC) {
      throw new ApiError(422, `At least ${formatUsdc(MIN_SHIELD_USDC)} USDC must reach Base after up to ${formatUsdc(maxFee)} USDC of bridge fees.`);
    }
    const job = createJob<ShieldJob>({ kind: "shield", status: "awaiting_funds", src: body.from_chain, amount: amount.toString(), slot });
    return {
      body: {
        step,
        next_step: null,
        job_id: job.id,
        inbox: slot.forwarderAddress,
        bridge_fee_at_most: formatUsdc(maxFee),
        arrives_at_least: formatUsdc(amount - maxFee),
        call: callView(burnCall({ src: body.from_chain, dst: "base", amount, recipient: slot.forwarderAddress, maxFee })),
      },
    };
  }));

  // Go private from Solana. A CCTP burn on Solana needs a second (event account) signer, which PayBox
  // proposals don't allow, so the agent uses PayBox's own bridge to deliver into the Veil inbox.
  api.post("/deposit/solana", route(async (req) => {
    const body = auth.and(z.object({ amount: usdc })).parse(req.body);
    const kp = keypairFrom({ veil_signature: body.veil_signature as Hex | undefined, veil_key: body.veil_key as Hex | undefined });
    const amount = parseUsdc(body.amount);
    if (amount < MIN_SOLANA_DEPOSIT) throw new ApiError(422, `Minimum from Solana is ${formatUsdc(MIN_SOLANA_DEPOSIT)} USDC (bridge fees come off first).`);
    const slot = await inboxSlot(kp);
    const job = createJob<ShieldJob>({ kind: "shield", status: "awaiting_funds", src: "solana", amount: amount.toString(), slot });
    return {
      body: {
        job_id: job.id,
        inbox: slot.forwarderAddress,
        paybox_tool: "request_swap",
        arguments: {
          src_chain: "solana",
          dst_chain: "base",
          src_token: SOLANA.usdcMint,
          dst_token: chainInfo("base").usdc,
          amount: body.amount,
          recipient: slot.forwarderAddress,
        },
        note: "Bridge with PayBox request_swap using these values (field formats per your PayBox tool schema). The recipient must be the inbox address exactly. At least 20.1 USDC must arrive on Base.",
      },
    };
  }));

  api.post("/balance", route(async (req) => {
    const body = auth.parse(req.body);
    const kp = keypairFrom({ veil_signature: body.veil_signature as Hex | undefined, veil_key: body.veil_key as Hex | undefined });
    const slot = await inboxSlot(kp);
    // A deposit whose job was lost (e.g. a restart wiped the job file) still sits in the inbox:
    // track it again so the worker sweeps it.
    if (pendingShields(slot.forwarderAddress).length === 0) {
      const held = await usdcBalanceOnBase(slot.forwarderAddress).catch(() => 0n);
      if (held >= MIN_SHIELD_USDC) createJob<ShieldJob>({ kind: "shield", status: "sweeping", src: "base", amount: held.toString(), slot });
    }
    const entry = requestBalance(kp, slot);
    const deposits = pendingShields(slot.forwarderAddress).map(jobView);
    if (entry.error) throw new ApiError(502, `Balance scan failed: ${entry.error}`);
    if (!entry.result) return { status: 202, body: { status: "computing", pending_deposits: deposits } };
    return {
      body: {
        status: entry.running ? "refreshing" : "ready",
        spendable_usdc: entry.result.shielded,
        clearing_usdc: entry.result.inbox,
        screening_usdc: entry.result.screening,
        pending_deposits: deposits,
      },
    };
  }));

  api.post("/send", route(async (req) => {
    const body = auth.and(payeeSchema).and(z.object({ confirm: z.boolean().optional() })).parse(req.body);
    const prepared = await prepareExit(body, { exactOut: false });
    if (!body.confirm) return { body: { status: "quote", ...prepared.quote, next: "Show this to the user; call again with confirm=true to send." } };

    const kp = keypairFrom({ veil_signature: body.veil_signature as Hex | undefined, veil_key: body.veil_key as Hex | undefined });
    const created = createJob<ExitJob>(prepared.job);
    startSend(created, kp);
    return { status: 202, body: { status: "sending", job_id: created.id, ...prepared.quote, next: "Poll the job; delivery usually takes 1–3 minutes." } };
  }));

  // Payroll: every payee receives exactly their amount; fees are added on top. Nothing is sent unless
  // the private balance covers the whole run.
  api.post("/payroll", route(async (req) => {
    const body = auth
      .and(z.object({ payees: z.array(payeeSchema.and(z.object({ label: z.string().max(64).optional() }))).min(1).max(MAX_PAYEES), confirm: z.boolean().optional() }))
      .parse(req.body);
    const prepared = [];
    for (const [i, payee] of body.payees.entries()) {
      try {
        prepared.push({ payee, ...(await prepareExit(payee, { exactOut: true })) });
      } catch (err) {
        throw new ApiError(err instanceof ApiError ? err.status : 422, `Payee ${i + 1}${payee.label ? ` (${payee.label})` : ""}: ${(err as Error).message}`);
      }
    }
    const total = prepared.reduce((sum, p) => sum + p.spend, 0n);
    const salaries = prepared.reduce((sum, p) => sum + parseUsdc(p.payee.amount), 0n);
    const summary = {
      payees: prepared.length,
      salaries_usdc: formatUsdc(salaries),
      fees_at_most_usdc: formatUsdc(total - salaries),
      total_at_most_usdc: formatUsdc(total),
      items: prepared.map((p) => ({ label: p.payee.label, to: p.payee.to, to_chain: p.payee.to_chain, receives: p.payee.amount, costs: formatUsdc(p.spend) })),
    };
    if (!body.confirm) return { body: { status: "quote", ...summary, next: "Show this to the user; call again with confirm=true to pay everyone." } };

    const kp = keypairFrom({ veil_signature: body.veil_signature as Hex | undefined, veil_key: body.veil_key as Hex | undefined });
    const slot = await inboxSlot(kp);
    const run = createJob<PayrollJob>({
      kind: "payroll",
      status: "checking",
      total: total.toString(),
      items: prepared.map((p) => ({ label: p.payee.label, to: p.payee.to, to_chain: p.payee.to_chain, receives: p.payee.amount })),
    });
    startPayroll(run, kp, slot, prepared.map((p) => p.job));
    return { status: 202, body: { status: "sending", job_id: run.id, ...summary, next: "Poll the job with hyde_status; each payee is paid in turn (about a minute each)." } };
  }));

  api.get("/jobs/:id", route(async (req) => {
    const job = getJob(String(req.params.id));
    if (!job) throw new ApiError(404, "Unknown job");
    return { body: jobView(job) };
  }));

  return api;
}
