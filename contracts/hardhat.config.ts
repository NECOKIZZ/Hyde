import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-viem";

const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  networks: {
    hardhat: process.env.FORK_BASE
      ? { forking: { url: process.env.BASE_RPC_URL ?? "https://mainnet.base.org" }, chainId: 8453 }
      : {},
    base: {
      url: process.env.BASE_RPC_URL ?? "https://mainnet.base.org",
      accounts: deployerKey ? [deployerKey] : [],
    },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
      accounts: deployerKey ? [deployerKey] : [],
    },
  },
};

export default config;
