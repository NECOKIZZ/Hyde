// Local Base mainnet fork for the demo recording (not used by tests or deploys).
module.exports = {
  networks: {
    hardhat: {
      chainId: 8453,
      hardfork: "cancun",
      forking: { url: "https://mainnet.base.org", blockNumber: 52735260 },
      chains: { 8453: { hardforkHistory: { cancun: 0 } } },
      mining: { auto: true },
    },
  },
};
