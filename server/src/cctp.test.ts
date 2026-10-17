import assert from "node:assert/strict";
import { test } from "node:test";
import { formatUsdc, maxFeeFor, parseUsdc } from "./cctp.js";

test("USDC parsing and formatting round-trip", () => {
  assert.equal(parseUsdc("25"), 25_000_000n);
  assert.equal(parseUsdc("0.000001"), 1n);
  assert.equal(formatUsdc(25_500_000n), "25.5");
  assert.equal(formatUsdc(parseUsdc("20.1")), "20.1");
  assert.throws(() => parseUsdc("1.0000001"));
  assert.throws(() => parseUsdc("-1"));
});

test("fee cap: protocol fee +50%, forwarding fee +25%, rounded up", () => {
  // 100 USDC at 1.4 bps → 2.1 bps → 0.021 USDC; forwarding 0.054256 → 0.06782
  assert.equal(maxFeeFor(100_000_000n, { protocolBps: 1.4, forwardFee: 54_256n }), 21_000n + 67_820n);
  assert.equal(maxFeeFor(1n, { protocolBps: 1.4, forwardFee: 0n }), 1n);
});
