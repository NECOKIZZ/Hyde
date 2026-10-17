import {
  concatHex,
  encodeAbiParameters,
  erc20Abi,
  getContractAddress,
  keccak256,
  pad,
  type Address,
  type Hex,
} from "viem";
import { CCTP_FAST, TOKEN_MESSENGER_V2, chainInfo, type ChainKey } from "./chains.js";
import { publicClient, relayerWallet } from "./clients.js";
import { exitBoxBytecode, exitBoxFactoryAbi } from "./generated/exitbox.js";

export interface ExitParams {
  destinationDomain: number;
  mintRecipient: Hex;
  minFinalityThreshold: number;
  maxFee: bigint;
  fallbackRecipient: Address;
  relayer: Address;
  relayerFee: bigint;
}

const exitParamsAbi = [
  {
    type: "tuple",
    components: [
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "minFinalityThreshold", type: "uint32" },
      { name: "maxFee", type: "uint256" },
      { name: "fallbackRecipient", type: "address" },
      { name: "relayer", type: "address" },
      { name: "relayerFee", type: "uint256" },
    ],
  },
] as const;

export function exitBoxFactoryAddress(): Address {
  const addr = process.env.EXIT_BOX_FACTORY as Address | undefined;
  if (!addr) throw new Error("EXIT_BOX_FACTORY is not set (deploy contracts/ first)");
  return addr;
}

/** `mintRecipient` is a left-padded EVM address, or a Solana USDC token account. */
export function exitParams(opts: {
  destinationDomain: number;
  mintRecipient: Hex;
  fallbackRecipient: Address;
  maxFee: bigint;
  relayer: Address;
  relayerFee: bigint;
}): ExitParams {
  return { ...opts, minFinalityThreshold: CCTP_FAST };
}

export function evmRecipient(to: ChainKey, recipient: Address) {
  return { destinationDomain: chainInfo(to).domain, mintRecipient: pad(recipient), fallbackRecipient: recipient };
}

/** CREATE2 address of the box, computed offline (mirrors ExitBoxFactory.boxAddress). */
export function predictExitBox(params: ExitParams, salt: Hex, factory = exitBoxFactoryAddress()): Address {
  const base = chainInfo("base");
  const ctorArgs = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, ...exitParamsAbi],
    [base.usdc, TOKEN_MESSENGER_V2, params],
  );
  const initCode = concatHex([exitBoxBytecode, ctorArgs]);
  return getContractAddress({ opcode: "CREATE2", from: factory, salt, bytecodeHash: keccak256(initCode) });
}

export async function usdcBalanceOnBase(address: Address): Promise<bigint> {
  return publicClient("base").readContract({
    address: chainInfo("base").usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
}

/** Deploys the box, which burns its USDC via CCTP with forwarding. Returns the Base tx hash (= the CCTP burn tx). */
export async function openExitBox(params: ExitParams, salt: Hex): Promise<Hex> {
  const client = publicClient("base");
  const wallet = relayerWallet("base");
  const { request } = await client.simulateContract({
    account: wallet.account!,
    address: exitBoxFactoryAddress(),
    abi: exitBoxFactoryAbi,
    functionName: "open",
    args: [params, salt],
  });
  const hash = await wallet.writeContract(request);
  await client.waitForTransactionReceipt({ hash });
  return hash;
}
