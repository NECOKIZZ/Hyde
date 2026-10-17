// Child process for CPU-heavy Veil work (pool scans, Poseidon, Groth16 proofs) so the API's event loop
// stays responsive within PayBox's 10-second plugin budget. Reads one JSON op on stdin, writes one
// JSON result on stdout. The key arrives over stdin, never argv or env.
import { Keypair } from "@veil-cash/sdk";
import type { Address, Hex } from "viem";
import { balances, mergeInbox, privateWithdraw, type InboxSlot } from "./veil.js";

type Op =
  | { op: "balance"; key: Hex; slot: InboxSlot }
  | { op: "send"; key: Hex; amount: string; recipient: Address };

async function run(input: Op) {
  const kp = new Keypair(input.key);
  const merged = await mergeInbox(kp).catch((e: Error) => `merge pending: ${e.message}`);
  if (input.op === "balance") return { ...(await balances(kp, input.slot)), merged };
  return { withdrawTx: await privateWithdraw(kp, BigInt(input.amount), input.recipient), merged };
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", async () => {
  try {
    process.stdout.write(JSON.stringify({ ok: true, result: await run(JSON.parse(raw)) }));
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  }
});
