# Hyde

**Private USDC payments for PayBox agents, from and to any major chain.**

PayBox gives an agent scoped, passkey-approved access to your wallet. Hyde gives that wallet a private
balance: go private once from Ethereum, Arbitrum, Optimism, Polygon, Avalanche or Base, then pay anyone on
any of those chains without your address appearing in the payment.

> "Pay 50 USDC to 0xBob… on Arbitrum, privately." The agent quotes it, you agree, and Bob is paid by a
> one-time contract that bridged out of a shielded pool. Nothing on-chain connects Bob to you.

```
CHAIN A                         BASE (privacy hub)                                ANY CHAIN
your PayBox wallet
  │ CCTP burn (1 passkey tap) ─► Circle mints into your Veil inbox ─► swept → screened → shielded pool
                                                         ┄┄┄┄┄┄┄ link broken ┄┄┄┄┄┄┄
                                 ZK withdrawal (Veil relay) ─► one-time ExitBox ─► CCTP ─► Circle delivers to Bob
```

## How it works

- **Privacy:** the existing [Veil Cash](https://docs.veil.cash) USDC pool on Base (Tornado Nova fork,
  Sherlock-audited March 2026, every deposit screened by 0xbow). Hyde uses Veil's real pool rather than
  its own: privacy comes from the crowd already in it.
- **Cross-chain:** Circle CCTP V2 fast transfers with Circle's Forwarding Service, so Circle completes
  every mint; there is no bridge relayer.
- **ExitBox** (`contracts/`): a constructor-only contract at a CREATE2 address that commits to the
  destination chain, recipient, fee cap and relayer fee. The ZK withdrawal funds that address; deploying
  it can only bridge to the committed recipient, and if the burn reverts it pays the recipient on Base.
  It exists so that the user's wallet never has to touch the outbound leg.
- **Keys:** the user's PayBox EVM wallet signs Veil's fixed message once (`request_wallet_sign`). That
  signature derives the same Veil key veil.cash would. Hyde never stores it; it's used per request and
  inside a short-lived proving process.

## Repository

| Path | What |
|---|---|
| `plugin/` | **The PayBox plugin** (PayBox starter 1.0.2). Builds `dist/plugin.mjs`, the file you upload. |
| `server/` | **Hyde API**: Veil proofs and pool scans (in child processes), deposit/send jobs, ExitBox relayer. |
| `contracts/` | `ExitBox` / `ExitBoxFactory`, unit tests, and a Base mainnet fork test against real CCTP. |

### Plugin tools

| Tool | Does | Wallet action |
|---|---|---|
| `hyde_setup` | Explains the flow and returns the message to sign | — |
| `hyde_deposit` | Go private. Base: one USDC transfer. Other chains: `step: approve`, then `step: bridge` | EVM proposal each step |
| `hyde_balance` | Spendable / clearing / screening balances (poll while `computing`) | — |
| `hyde_send` | Quote, then `confirm: true` to pay a recipient on any supported chain | **none** |
| `hyde_status` | Track a send by `job_id` | — |

Every call returns within PayBox's 10-second budget: slow work (pool scans, Groth16 proofs) runs on the
Hyde API in the background and the plugin polls.

## Build and test

```bash
# plugin: Node 24.21, pnpm 11.11.0
cd plugin && pnpm install --frozen-lockfile && pnpm test     # typecheck, 2 reproducible builds, conformance

# contracts
cd contracts && npm i --legacy-peer-deps && npm test
FORK_BASE=1 npx hardhat test test/fork/ExitBox.base.fork.ts   # real CCTP + forwarding on a Base fork

# API
cd server && npm i && npm test
npm run test:e2e   # bundled plugin.mjs, fresh process per call → broker proxy → API → live Base/Circle/Veil. Moves no money.
```

## Deploy

1. **Contracts:** `cd contracts && DEPLOYER_PRIVATE_KEY=0x… npm run deploy -- --network base` → `EXIT_BOX_FACTORY`.
2. **Hyde API:** deploy `server/` (Dockerfile, or `render.yaml` blueprint) with `HYDE_API_KEY` (random, 16+
   chars), `RELAYER_PRIVATE_KEY` (hot wallet with ~$2–3 of ETH on Base), `EXIT_BOX_FACTORY`, optional `BASE_RPC_URL`.
3. **PayBox developer portal:** upload `plugin/dist/plugin.mjs`, then in **Test & configure**:
   - Network host: your API hostname (e.g. `hyde-api.onrender.com`)
   - Environment variable: `HYDE_API_URL=https://hyde-api.onrender.com`
   - Secret: host = your API hostname, header `x-hyde-key`, value = `HYDE_API_KEY`

## Privacy limits

- **Amount and timing correlation.** Going private with 100 and sending 100 a minute later is linkable.
  Go private once, spend later, prefer round amounts.
- The deposit and delivery legs are public; the pool hides only the link between them.
- First deposits wait for Veil's screening (~15 min typical, longer for new wallets).
- The Hyde API sees which wallet asks for which send while it processes it. It keeps job records without
  user identity, but it is a trusted operator, as is Veil's relay.
