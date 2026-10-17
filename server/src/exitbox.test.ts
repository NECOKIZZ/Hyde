import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address, Hex } from "viem";
import { predictExitBox, type ExitParams } from "./exitbox.js";
import fixture from "./generated/exitbox-fixture.json" with { type: "json" };

test("offline exit box prediction matches ExitBoxFactory.boxAddress", () => {
  for (const c of fixture.cases) {
    const params: ExitParams = { ...c.params, mintRecipient: c.params.mintRecipient as Hex, fallbackRecipient: c.params.fallbackRecipient as Address, relayer: c.params.relayer as Address, maxFee: BigInt(c.params.maxFee), relayerFee: BigInt(c.params.relayerFee) };
    assert.equal(predictExitBox(params, c.salt as Hex, fixture.factory as Address), c.box);
  }
});
