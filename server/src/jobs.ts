import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Keypair } from "@veil-cash/sdk";
import type { Address, Hex } from "viem";
import { burnStatus } from "./cctp.js";
import { chainByDomain, type ChainKey } from "./chains.js";
import { openExitBox, usdcBalanceOnBase, type ExitParams } from "./exitbox.js";
import { inboxQueue, sweepInbox, type InboxSlot, type PrivateBalances } from "./veil.js";

interface JobBase {
  id: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  log: string[];
}

/** Public USDC → user's Veil inbox on Base (Circle forwards cross-chain deposits) → shielded pool. */
export interface ShieldJob extends JobBase {
  kind: "shield";
  status: "awaiting_funds" | "sweeping" | "screening" | "done" | "expired" | "failed";
  src: ChainKey;
  /** USDC base units the user is sending */
  amount: string;
  slot: InboxSlot;
  sweepTx?: string;
}

/** Shielded pool → one-time exit box on Base → CCTP (Circle-forwarded) → recipient on any chain. */
export interface ExitJob extends JobBase {
  kind: "exit";
  status: "proving" | "awaiting_funds" | "opening" | "bridging" | "done" | "failed";
  to: ChainKey;
  recipient: Address;
  amount: string;
  /** Base-only sends withdraw straight to the recipient and have no box */
  params?: Omit<ExitParams, "maxFee" | "relayerFee"> & { maxFee: string; relayerFee: string };
  salt?: Hex;
  box?: Address;
  withdrawTx?: Hex;
  openTx?: Hex;
  forwardTx?: Hex;
}

export type Job = ShieldJob | ExitJob;

const FILE = process.env.JOBS_FILE ?? "data/jobs.json";
const SHIELD_TTL_MS = 6 * 3600_000;
const jobs = new Map<string, Job>();

export function loadJobs() {
  try {
    for (const j of JSON.parse(readFileSync(FILE, "utf8")) as Job[]) {
      // A proof in flight dies with the process; the funds never left the private balance.
      if (j.kind === "exit" && j.status === "proving") {
        j.status = "failed";
        j.error = "Server restarted before the private withdrawal was submitted. Nothing moved; send again.";
      }
      jobs.set(j.id, j);
    }
  } catch {
    // first run
  }
}

function save() {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify([...jobs.values()], null, 2));
}

export function update(job: Job, patch: Partial<Job>, line?: string) {
  Object.assign(job, patch);
  job.updatedAt = new Date().toISOString();
  if (line) job.log.push(`${job.updatedAt} ${line}`);
  save();
}

export function createJob<T extends Job>(job: Omit<T, "id" | "createdAt" | "updatedAt" | "log">): T {
  const now = new Date().toISOString();
  const full = { ...job, id: randomUUID(), createdAt: now, updatedAt: now, log: [] } as unknown as T;
  jobs.set(full.id, full);
  update(full, {}, `created (${full.status})`);
  return full;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function pendingShields(inbox: Address): ShieldJob[] {
  return [...jobs.values()].filter(
    (j): j is ShieldJob => j.kind === "shield" && j.slot.forwarderAddress === inbox && !["done", "expired", "failed"].includes(j.status),
  );
}

/** Stable, non-reversible id for a Veil key: used for locks and caches, never stored with jobs. */
export function keyId(kp: Keypair): string {
  return createHash("sha256").update(String(kp.privkey)).digest("hex");
}

// One Veil operation at a time per user: concurrent proofs would pick the same notes.
const locks = new Map<string, Promise<unknown>>();
export function withUserLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(id, next);
  const release = () => {
    if (locks.get(id) === next) locks.delete(id);
  };
  next.then(release, release);
  return next;
}

const RUNNER = new URL("./veil-runner.ts", import.meta.url).pathname;
const RUNNER_TIMEOUT_MS = 180_000;

/** Runs CPU-heavy Veil work in a child process; the key is passed over stdin only. */
function runVeil<T>(op: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", RUNNER], { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), RUNNER_TIMEOUT_MS);
    child.stdout.on("data", (c) => (out += c));
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(out) as { ok: boolean; result?: T; error?: string };
        r.ok ? resolve(r.result as T) : reject(new Error(r.error));
      } catch {
        reject(new Error("Veil worker exited without a result"));
      }
    });
    child.stdin.end(JSON.stringify(op));
  });
}

/** Runs the ZK withdrawal in the background. The key lives only in this closure and the worker. */
export function startSend(job: ExitJob, kp: Keypair) {
  void withUserLock(keyId(kp), async () => {
    const { withdrawTx } = await runVeil<{ withdrawTx: Hex }>({
      op: "send",
      key: kp.privkey,
      amount: job.amount,
      recipient: job.box ?? job.recipient,
    });
    if (job.box) update(job, { status: "awaiting_funds", withdrawTx }, `private withdrawal to exit box ${withdrawTx}`);
    else update(job, { status: "done", withdrawTx }, `private withdrawal to recipient ${withdrawTx}`);
  }).catch((err: Error) => update(job, { status: "failed", error: err.message }, `proof/withdraw failed: ${err.message}`));
}

// Balance scans read the whole pool and can take longer than a plugin call, so they run in the
// background and callers poll. Results are cached briefly per key.
interface BalanceEntry {
  at: number;
  result?: PrivateBalances & { merged?: string | null };
  error?: string;
  running: boolean;
}
const balanceCache = new Map<string, BalanceEntry>();
const BALANCE_TTL_MS = 30_000;

export function requestBalance(kp: Keypair, slot: InboxSlot): BalanceEntry {
  const id = keyId(kp);
  const cached = balanceCache.get(id);
  if (cached && (cached.running || Date.now() - cached.at < BALANCE_TTL_MS)) return cached;
  const entry: BalanceEntry = { at: Date.now(), running: true };
  balanceCache.set(id, entry);
  void withUserLock(id, async () => {
    entry.result = await runVeil<PrivateBalances & { merged?: string | null }>({ op: "balance", key: kp.privkey, slot });
  })
    .catch((err: Error) => {
      entry.error = err.message;
    })
    .finally(() => {
      entry.running = false;
      entry.at = Date.now();
    });
  return entry;
}

async function advanceShield(job: ShieldJob) {
  switch (job.status) {
    case "awaiting_funds": {
      if ((await usdcBalanceOnBase(job.slot.forwarderAddress)) > 0n) {
        update(job, { status: "sweeping" }, "funds arrived in the Veil inbox");
      } else if (Date.now() - Date.parse(job.createdAt) > SHIELD_TTL_MS) {
        update(job, { status: "expired" }, "no funds arrived");
      }
      return;
    }
    case "sweeping": {
      const r = await sweepInbox(job.slot);
      update(job, { status: "screening", sweepTx: r.sweepTx }, `swept into Veil's deposit queue ${r.sweepTx}`);
      return;
    }
    case "screening": {
      const q = await inboxQueue(job.slot);
      if (q.pendingCount > 0) return;
      update(job, { status: "done" }, "cleared screening; joins the spendable balance on the next balance or send");
      return;
    }
  }
}

async function advanceExit(job: ExitJob) {
  switch (job.status) {
    case "awaiting_funds": {
      if ((await usdcBalanceOnBase(job.box!)) === 0n) return;
      update(job, { status: "opening" }, "withdrawal landed in the exit box");
      return;
    }
    case "opening": {
      const p = job.params!;
      const openTx = await openExitBox({ ...p, maxFee: BigInt(p.maxFee), relayerFee: BigInt(p.relayerFee) }, job.salt!);
      update(job, { status: "bridging", openTx }, `exit box opened: CCTP burn ${openTx}`);
      return;
    }
    case "bridging": {
      const s = await burnStatus("base", job.openTx!);
      if (!s.forwardTxHash) return;
      const dst = chainByDomain(job.params!.destinationDomain).key;
      update(job, { status: "done", forwardTx: s.forwardTxHash }, `delivered on ${dst} by Circle ${s.forwardTxHash}`);
      return;
    }
  }
}

const MAX_ERRORS = 30;
const errorCounts = new Map<string, number>();

export async function tick() {
  for (const job of jobs.values()) {
    const active = job.kind === "shield"
      ? ["awaiting_funds", "sweeping", "screening"].includes(job.status)
      : ["awaiting_funds", "opening", "bridging"].includes(job.status);
    if (!active) continue;
    try {
      if (job.kind === "shield") await advanceShield(job);
      else await advanceExit(job);
      errorCounts.delete(job.id);
    } catch (err) {
      const n = (errorCounts.get(job.id) ?? 0) + 1;
      errorCounts.set(job.id, n);
      const message = err instanceof Error ? err.message : String(err);
      update(job, n >= MAX_ERRORS ? { status: "failed", error: message } : { error: message }, `error (${n}): ${message}`);
    }
  }
}

export function startWorker(intervalMs = Number(process.env.WORKER_INTERVAL_MS ?? 10_000)) {
  loadJobs();
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } finally {
      running = false;
    }
  }, intervalMs);
}
