import { randomBytes, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { VEIL_SIGNED_MESSAGE } from "@veil-cash/sdk";
import { getAddress, isAddress, isHex, toHex, type Hex } from "viem";
import { z } from "zod";
import { approveCall, burnCall, formatUsdc, maxFeeFor, parseUsdc, quoteFees, transferCall, type UnsignedCall } from "./cctp.js";
import { CHAIN_KEYS, chainInfo, type ChainKey } from "./chains.js";
import { relayerAccount } from "./clients.js";
import { exitParams, predictExitBox } from "./exitbox.js";
import { createJob, getJob, pendingShields, requestBalance, startSend, type ExitJob, type Job, type ShieldJob } from "./jobs.js";
import { MIN_SHIELD_USDC, inboxSlot, keypairFrom } from "./veil.js";

const chain = z.enum(CHAIN_KEYS);
const usdc = z.string().regex(/^\d+(\.\d{1,6})?$/);
const auth = z
  .object({ veil_signature: z.string().optional(), veil_key: z.string().optional() })
  .refine((a) => a.veil_signature || a.veil_key, "veil_signature is required")
  .refine((a) => [a.veil_signature, a.veil_key].every((v) => v === undefined || isHex(v)), "must be 0x-prefixed hex");

/** Relayer fee per destination: our Base gas to open the exit box. Circle's forwarding fee is separate. */
function relayerFee(): bigint {
  return parseUsdc(process.env.RELAYER_FEE_USDC ?? "0.03");
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
      chains: CHAIN_KEYS.map((k) => ({ key: k, name: chainInfo(k).name })),
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
    const fees = await quoteFees(body.from_chain, "base");
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

  api.post("/balance", route(async (req) => {
    const body = auth.parse(req.body);
    const kp = keypairFrom({ veil_signature: body.veil_signature as Hex | undefined, veil_key: body.veil_key as Hex | undefined });
    const slot = await inboxSlot(kp);
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
    const body = auth
      .and(z.object({ to: z.string(), to_chain: chain, amount: usdc, confirm: z.boolean().optional() }))
      .parse(req.body);
    if (!isAddress(body.to)) throw new ApiError(400, "to must be an EVM address");
    const recipient = getAddress(body.to);
    const amount = parseUsdc(body.amount);
    const to: ChainKey = body.to_chain;

    let quote: Record<string, string>;
    let job: Omit<ExitJob, "id" | "createdAt" | "updatedAt" | "log">;
    if (to === "base") {
      quote = { route: "Veil pool → recipient on Base", you_spend: body.amount, recipient_receives: body.amount };
      job = { kind: "exit", status: "proving", to, recipient, amount: amount.toString() };
    } else {
      const fee = relayerFee();
      const maxFee = maxFeeFor(amount - fee, await quoteFees("base", to));
      if (amount <= fee + maxFee) throw new ApiError(422, `Too small: fees are up to ${formatUsdc(fee + maxFee)} USDC.`);
      const params = exitParams({ to, recipient, maxFee, relayer: relayerAccount().address, relayerFee: fee });
      const salt = toHex(randomBytes(32));
      quote = {
        route: `Veil pool (Base) → one-time exit box → Circle CCTP → ${chainInfo(to).name}`,
        you_spend: body.amount,
        relayer_fee: formatUsdc(fee),
        bridge_fee_at_most: formatUsdc(maxFee),
        recipient_receives_at_least: formatUsdc(amount - fee - maxFee),
      };
      job = {
        kind: "exit",
        status: "proving",
        to,
        recipient,
        amount: amount.toString(),
        params: { ...params, maxFee: maxFee.toString(), relayerFee: fee.toString() },
        salt,
        box: predictExitBox(params, salt),
      };
    }
    if (!body.confirm) return { body: { status: "quote", ...quote, next: "Show this to the user; call again with confirm=true to send." } };

    const kp = keypairFrom({ veil_signature: body.veil_signature as Hex | undefined, veil_key: body.veil_key as Hex | undefined });
    const created = createJob<ExitJob>(job);
    startSend(created, kp);
    return { status: 202, body: { status: "sending", job_id: created.id, ...quote, next: "Poll the job; delivery usually takes 1–3 minutes." } };
  }));

  api.get("/jobs/:id", route(async (req) => {
    const job = getJob(String(req.params.id));
    if (!job) throw new ApiError(404, "Unknown job");
    return { body: jobView(job) };
  }));

  return api;
}
