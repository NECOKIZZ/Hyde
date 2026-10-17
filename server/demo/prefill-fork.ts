// Copies the Veil USDC pool's commitments and encrypted outputs from Base mainnet into the local fork
// in bulk. A fork reads mainnet storage one slot per request, which makes a full pool scan take ~30 min.
import { readFileSync } from "node:fs";
import { encodeAbiParameters, keccak256, hexToBigInt, toHex, pad, type Hex } from "viem";

const POOL = "0x5c50d58E49C59d112680c187De2Bf989d2a91242";
const MAINNET = process.env.MAINNET_RPC ?? "https://mainnet.base.org";
const FORK = process.env.FORK_RPC ?? "http://127.0.0.1:8549";
const BLOCK = toHex(Number(readFileSync(process.argv[2], "utf8").trim()));
const COMMITMENTS_SLOT = 6n, OUTPUTS_SLOT = 7n;

const mapSlot = (key: bigint, slot: bigint) => keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [key, slot]));
async function rpc(url: string, calls: { method: string; params: unknown[] }[]): Promise<Hex[]> {
  const results: (Hex | undefined)[] = new Array(calls.length);
  for (let attempt = 0; results.includes(undefined) || results.length !== calls.length; attempt++) {
    const todo = calls.map((c, id) => ({ c, id })).filter(({ id }) => results[id] === undefined);
    if (todo.length === 0) break;
    if (attempt > 20) throw new Error(`rpc failed for ${todo.length} calls`);
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * attempt));
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(todo.map(({ c, id }) => ({ jsonrpc: "2.0", id, ...c }))) }).catch(() => null);
    const out = (await res?.json().catch(() => null)) as { id: number; result?: Hex }[] | null;
    if (Array.isArray(out)) for (const r of out) if (r.result !== undefined) results[r.id] = r.result;
  }
  return results as Hex[];
}
const read = (slots: Hex[]) => rpc(MAINNET, slots.map((s) => ({ method: "eth_getStorageAt", params: [POOL, s, BLOCK] })));
const write = (pairs: [Hex, Hex][]) => rpc(FORK, pairs.map(([s, v]) => ({ method: "hardhat_setStorageAt", params: [POOL, s, v] })));

const [packed] = await read([pad(toHex(2n))]);
const n = Number((hexToBigInt(packed) >> 32n) & 0xffffffffn);
console.log("pool commitments:", n);
const t = Date.now();
const BATCH = 50;
// 1. commitments and the head slot of each encrypted output
const heads: Hex[] = [];
for (let i = 0; i < n; i += BATCH) {
  const idx = [...Array(Math.min(BATCH, n - i)).keys()].map((k) => BigInt(i + k));
  const cSlots = idx.map((k) => mapSlot(k, COMMITMENTS_SLOT));
  const oSlots = idx.map((k) => mapSlot(k, OUTPUTS_SLOT));
  const vals = await read([...cSlots, ...oSlots]);
  await write([...cSlots, ...oSlots].map((s, j) => [s, vals[j]] as [Hex, Hex]));
  heads.push(...vals.slice(idx.length));
}
console.log("commitments + output heads copied", ((Date.now() - t) / 1000).toFixed(0), "s");
// 2. long-form bytes: data words live at keccak(headSlot)
const dataSlots: Hex[] = [];
heads.forEach((h, i) => {
  const v = hexToBigInt(h);
  if (v % 2n === 1n) {
    const words = Number(((v - 1n) / 2n + 31n) / 32n);
    const start = hexToBigInt(keccak256(mapSlot(BigInt(i), OUTPUTS_SLOT)));
    for (let w = 0; w < words; w++) dataSlots.push(pad(toHex(start + BigInt(w))));
  }
});
for (let i = 0; i < dataSlots.length; i += BATCH * 2) {
  const slots = dataSlots.slice(i, i + BATCH * 2);
  const vals = await read(slots);
  await write(slots.map((s, j) => [s, vals[j]] as [Hex, Hex]));
}
console.log("encrypted output data copied:", dataSlots.length, "slots in", ((Date.now() - t) / 1000).toFixed(0), "s");
