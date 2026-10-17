import { expect } from "chai";
import hre from "hardhat";
import { erc20Abi, keccak256, pad, parseAbiItem, parseEther, toHex, type Address } from "viem";

// Real Base mainnet contracts. Run with: FORK_BASE=1 npx hardhat test test/fork/ExitBox.base.fork.ts
const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TOKEN_MESSENGER_V2: Address = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
const USDC_HOLDER: Address = "0x5c50d58E49C59d112680c187De2Bf989d2a91242"; // Veil USDC pool
const DEPOSIT_FOR_BURN = parseAbiItem(
  "event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)",
);

describe("ExitBox on a Base mainnet fork (real CCTP)", function () {
  before(function () {
    if (!process.env.FORK_BASE) this.skip();
  });

  it("burns with Circle forwarding via the real TokenMessengerV2 toward Arbitrum", async () => {
    const publicClient = await hre.viem.getPublicClient();
    const [, relayer, recipient] = await hre.viem.getWalletClients();
    const factory = await hre.viem.deployContract("ExitBoxFactory", [USDC, TOKEN_MESSENGER_V2]);
    const params = {
      destinationDomain: 3,
      mintRecipient: pad(recipient.account.address),
      minFinalityThreshold: 1000,
      maxFee: 150_000n,
      fallbackRecipient: recipient.account.address,
      relayer: relayer.account.address,
      relayerFee: 50_000n,
    };
    const salt = keccak256(toHex("fork-test"));
    const box = await factory.read.boxAddress([params, salt]);

    // Fund the box the way a Veil withdrawal would.
    await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [USDC_HOLDER] });
    await hre.network.provider.request({ method: "hardhat_setBalance", params: [USDC_HOLDER, toHex(parseEther("1"))] });
    const holder = await hre.viem.getWalletClient(USDC_HOLDER);
    await holder.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [box, 25_000_000n] });

    const hash = await factory.write.open([params, salt], { account: relayer.account });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const logs = await publicClient.getLogs({ address: TOKEN_MESSENGER_V2, event: DEPOSIT_FOR_BURN, blockHash: receipt.blockHash });

    expect(logs).to.have.length(1);
    expect(logs[0].args.amount).to.equal(24_950_000n);
    expect(logs[0].args.destinationDomain).to.equal(3);
    expect(logs[0].args.mintRecipient).to.equal(pad(recipient.account.address));
    expect(logs[0].args.maxFee).to.equal(150_000n);
    expect(logs[0].args.hookData).to.equal("0x636374702d666f72776172640000000000000000000000000000000000000000");
    expect(logs[0].args.depositor!.toLowerCase()).to.equal(box.toLowerCase());
    expect(await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [relayer.account.address] })).to.equal(50_000n);
  });

  it("burns with Circle forwarding toward a Solana USDC token account", async () => {
    const publicClient = await hre.viem.getPublicClient();
    const [, relayer, fallback] = await hre.viem.getWalletClients();
    const factory = await hre.viem.deployContract("ExitBoxFactory", [USDC, TOKEN_MESSENGER_V2]);
    // Any 32-byte Solana token account; CCTP on Base does not validate it.
    const solanaTokenAccount = keccak256(toHex("solana-usdc-ata"));
    const params = {
      destinationDomain: 5,
      mintRecipient: solanaTokenAccount,
      minFinalityThreshold: 1000,
      maxFee: 250_000n,
      fallbackRecipient: fallback.account.address,
      relayer: relayer.account.address,
      relayerFee: 30_000n,
    };
    const salt = keccak256(toHex("fork-test-solana"));
    const box = await factory.read.boxAddress([params, salt]);
    await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [USDC_HOLDER] });
    await hre.network.provider.request({ method: "hardhat_setBalance", params: [USDC_HOLDER, toHex(parseEther("1"))] });
    const holder = await hre.viem.getWalletClient(USDC_HOLDER);
    await holder.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [box, 10_000_000n] });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: await factory.write.open([params, salt], { account: relayer.account }) });
    const logs = await publicClient.getLogs({ address: TOKEN_MESSENGER_V2, event: DEPOSIT_FOR_BURN, blockHash: receipt.blockHash });
    expect(logs).to.have.length(1);
    expect(logs[0].args.destinationDomain).to.equal(5);
    expect(logs[0].args.mintRecipient).to.equal(solanaTokenAccount);
    expect(logs[0].args.amount).to.equal(9_970_000n);
  });
});
