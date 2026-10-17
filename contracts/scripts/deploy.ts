import hre from "hardhat";

// Base mainnet: native USDC and CCTP V2 TokenMessenger.
const USDC = (process.env.USDC_ADDRESS ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") as `0x${string}`;
const TOKEN_MESSENGER_V2 = (process.env.TOKEN_MESSENGER_V2 ?? "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d") as `0x${string}`;

async function main() {
  const factory = await hre.viem.deployContract("ExitBoxFactory", [USDC, TOKEN_MESSENGER_V2]);
  console.log(`ExitBoxFactory deployed on ${hre.network.name}: ${factory.address}`);
  console.log(`Set EXIT_BOX_FACTORY=${factory.address} in server/.env`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
