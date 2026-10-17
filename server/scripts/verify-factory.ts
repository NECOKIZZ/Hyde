// Checks a deployed ExitBoxFactory: wiring, and that the API's offline box prediction matches it.
import { createPublicClient, http, keccak256, pad, toHex, type Address } from "viem";
import { base } from "viem/chains";
import { exitBoxFactoryAbi } from "../src/generated/exitbox.js";
import { predictExitBox } from "../src/exitbox.js";

const factory = process.argv[2] as Address;
const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL) });
const [usdc, messenger, code] = await Promise.all([
  client.readContract({ address: factory, abi: exitBoxFactoryAbi, functionName: "usdc" }),
  client.readContract({ address: factory, abi: exitBoxFactoryAbi, functionName: "messenger" }),
  client.getCode({ address: factory }),
]);
console.log("bytecode bytes:", (code!.length - 2) / 2);
console.log("usdc:", usdc, usdc === "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" ? "✓ Base USDC" : "✗");
console.log("messenger:", messenger, messenger === "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d" ? "✓ CCTP TokenMessengerV2" : "✗");
const params = {
  destinationDomain: 3,
  mintRecipient: pad("0x000000000000000000000000000000000000bEEF"),
  minFinalityThreshold: 1000,
  maxFee: 100_000n,
  fallbackRecipient: "0x000000000000000000000000000000000000bEEF" as Address,
  relayer: "0xe01Fc4E62b12EAdA49EE2671411D19E2FD9073ce" as Address,
  relayerFee: 30_000n,
};
const salt = keccak256(toHex("verify"));
const onchain = await client.readContract({ address: factory, abi: exitBoxFactoryAbi, functionName: "boxAddress", args: [params, salt] });
const offline = predictExitBox(params, salt, factory);
console.log("box prediction:", onchain === offline ? "✓ API matches chain" : `✗ ${onchain} vs ${offline}`);
