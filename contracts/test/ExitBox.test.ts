import { expect } from "chai";
import hre from "hardhat";
import { getAddress, pad, keccak256, toHex, type Address } from "viem";

const ARBITRUM_DOMAIN = 3;

async function setup() {
  const [deployer, relayer, recipient] = await hre.viem.getWalletClients();
  const usdc = await hre.viem.deployContract("MockUSDC");
  const messenger = await hre.viem.deployContract("MockTokenMessengerV2");
  const factory = await hre.viem.deployContract("ExitBoxFactory", [usdc.address, messenger.address]);

  const params = {
    destinationDomain: ARBITRUM_DOMAIN,
    mintRecipient: pad(recipient.account.address),
    minFinalityThreshold: 1000,
    maxFee: 100_000n, // 0.10 USDC: protocol + forwarding fee cap
    fallbackRecipient: recipient.account.address,
    relayer: relayer.account.address,
    relayerFee: 50_000n, // 0.05 USDC
  };
  const salt = keccak256(toHex("payment-1"));
  return { deployer, relayer, recipient, usdc, messenger, factory, params, salt };
}

describe("ExitBoxFactory", () => {
  it("predicts the box address before deployment", async () => {
    const { factory, params, salt } = await setup();
    const predicted = await factory.read.boxAddress([params, salt]);
    const hash = await factory.write.open([params, salt]).catch((e: Error) => e);
    // Unfunded box must revert; prediction is still deterministic.
    expect(hash).to.be.instanceOf(Error);
    expect(await factory.read.boxAddress([params, salt])).to.equal(predicted);
  });

  it("bridges the full balance minus the relayer fee to the committed recipient", async () => {
    const { factory, usdc, messenger, params, salt, relayer, recipient } = await setup();
    const box = (await factory.read.boxAddress([params, salt])) as Address;
    await usdc.write.mint([box, 20_000_000n]); // 20 USDC lands from the Veil withdrawal

    const publicClient = await hre.viem.getPublicClient();
    const tx = await factory.write.open([params, salt], { account: relayer.account });
    await publicClient.waitForTransactionReceipt({ hash: tx });

    const [sender, amount, domain, mintRecipient, burnToken, destinationCaller, maxFee, finality, hookData] =
      await messenger.read.last();
    expect(getAddress(sender)).to.equal(getAddress(box));
    expect(amount).to.equal(19_950_000n);
    expect(domain).to.equal(ARBITRUM_DOMAIN);
    expect(mintRecipient).to.equal(pad(recipient.account.address));
    expect(getAddress(burnToken)).to.equal(getAddress(usdc.address));
    expect(destinationCaller).to.equal(pad("0x0", { size: 32 }));
    expect(maxFee).to.equal(100_000n);
    expect(finality).to.equal(1000);
    expect(hookData).to.equal("0x636374702d666f72776172640000000000000000000000000000000000000000");

    expect(await usdc.read.balanceOf([relayer.account.address])).to.equal(50_000n);
    expect(await usdc.read.balanceOf([box])).to.equal(0n);
    // Only Solidity's revert-only stub remains: no callable functions.
    const err = await publicClient.call({ to: box, data: "0x12345678" }).catch((e: Error) => e);
    expect(err).to.be.instanceOf(Error);
  });

  it("commits to every parameter: changing the recipient changes the address", async () => {
    const { factory, params, salt, deployer } = await setup();
    const a = await factory.read.boxAddress([params, salt]);
    const b = await factory.read.boxAddress([{ ...params, mintRecipient: pad(deployer.account.address) }, salt]);
    const c = await factory.read.boxAddress([{ ...params, relayerFee: params.relayerFee + 1n }, salt]);
    const d = await factory.read.boxAddress([{ ...params, maxFee: params.maxFee + 1n }, salt]);
    expect(new Set([a, b, c, d]).size).to.equal(4);
  });

  it("falls back to paying the recipient on Base if the burn reverts", async () => {
    const { factory, usdc, messenger, params, salt, recipient } = await setup();
    await messenger.write.setShouldRevert([true]);
    const box = (await factory.read.boxAddress([params, salt])) as Address;
    await usdc.write.mint([box, 5_000_000n]);

    await factory.write.open([params, salt]);

    expect(await usdc.read.balanceOf([recipient.account.address])).to.equal(4_950_000n);
    expect(await messenger.read.burns()).to.equal(0n);
  });

  it("is single-use", async () => {
    const { factory, usdc, params, salt } = await setup();
    const box = (await factory.read.boxAddress([params, salt])) as Address;
    await usdc.write.mint([box, 5_000_000n]);
    await factory.write.open([params, salt]);
    await usdc.write.mint([box, 5_000_000n]);
    const again = await factory.write.open([params, salt]).catch((e: Error) => e);
    expect(again).to.be.instanceOf(Error);
  });

  it("refuses to open an unfunded box", async () => {
    const { factory, params, salt } = await setup();
    const err = await factory.write.open([params, salt]).catch((e: Error) => e);
    expect(String(err)).to.match(/unfunded/);
  });
});

describe("address fixture for the server", () => {
  it("writes boxAddress results computed by the real factory", async () => {
    // Base mainnet constants; boxAddress is a pure view so the addresses needn't hold code here.
    const factory = await hre.viem.deployContract("ExitBoxFactory", [
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
    ]);
    const [, relayer, recipient] = await hre.viem.getWalletClients();
    const cases = [];
    for (const [i, domain] of [0, 3, 7].entries()) {
      const params = {
        destinationDomain: domain,
        mintRecipient: pad(recipient.account.address),
        minFinalityThreshold: 1000,
        maxFee: 60_000n + BigInt(i) * 1_000_000n,
        fallbackRecipient: recipient.account.address,
        relayer: relayer.account.address,
        relayerFee: 50_000n * BigInt(i + 1),
      };
      const salt = keccak256(toHex(`fixture-${i}`));
      cases.push({
        params: { ...params, maxFee: params.maxFee.toString(), relayerFee: params.relayerFee.toString() },
        salt,
        box: await factory.read.boxAddress([params, salt]),
      });
    }
    const fs = await import("node:fs");
    fs.writeFileSync(
      `${__dirname}/../../server/src/generated/exitbox-fixture.json`,
      JSON.stringify({ factory: factory.address, cases }, null, 2),
    );
  });
});
