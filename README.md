# ERC8183base

ERC-8183 AgenticCommerce deployed on Base mainnet.

This repo contains a Foundry project for the ERC-8183 Agentic Commerce reference implementation. The contract is upgradeable through the UUPS pattern and is deployed behind an ERC1967 proxy.

## Deployed Contracts

Network: Base mainnet  
Chain ID: `8453`

Use the proxy address in apps and scripts:

```text
AgenticCommerce proxy:          0xD663f820500be769a3106A7d212E057d765e9D43
AgenticCommerce implementation: 0xa7Ad4403b9fC4D8A742A0C4087CB892630D23Ee5
Payment token:                  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
Treasury:                       0xd7F0EFC1736AC7E32Db2F9F48692308C62c9B020
```

BaseScan:

- Proxy: https://basescan.org/address/0xD663f820500be769a3106A7d212E057d765e9D43
- Implementation: https://basescan.org/address/0xa7Ad4403b9fC4D8A742A0C4087CB892630D23Ee5

Deployment transactions:

- Implementation deploy: `0x5bfb7f8448972b4fd05c5e4190463a4385b24719ae05f32c49710825dedfc1e0`
- Proxy deploy + initialize: `0x83978570838eae98fbe37e0d1b6e9032278d102205ef412e94859a911506ddab`

Both contracts are verified on BaseScan.

## What The Contract Does

AgenticCommerce is a job escrow contract for agentic commerce flows:

1. A client creates a job.
2. A provider accepts or is assigned.
3. The provider sets a budget.
4. The client funds escrow with the configured ERC-20 token.
5. The provider submits a deliverable hash.
6. The evaluator completes or rejects the job.
7. Funds are released to the provider or refunded to the client.

The deployed Base contract uses native USDC as the payment token.

## Project Layout

```text
contracts/AgenticCommerce.sol      ERC-8183 UUPS upgradeable implementation
contracts/IACPHook.sol             Hook interface for future extensions
script/DeployERC8183.s.sol         Foundry deployment script
DEPLOY_ERC8183.md                  Step-by-step deployment guide
foundry.toml                       Foundry config
remappings.txt                     Foundry remappings
```

## Build

Install dependencies:

```bash
forge install foundry-rs/forge-std --no-git
forge install OpenZeppelin/openzeppelin-contracts --no-git
forge install OpenZeppelin/openzeppelin-contracts-upgradeable --no-git
```

Build:

```bash
forge build
```

## Deploy Again

Copy the env template:

```bash
cp .env.example .env
```

Put the deployer key in `.env`:

```bash
export DEPLOYER_PRIVATE_KEY=0xYOUR_PRIVATE_KEY
export BASESCAN_API_KEY=your_basescan_api_key
```

`TREASURY_ADDRESS` is optional. If it is blank, the deployer address is used as treasury.

Deploy and verify:

```bash
source .env

forge script script/DeployERC8183.s.sol:DeployERC8183 \
  --rpc-url "$BASE_RPC_URL" \
  --broadcast \
  --verify \
  --etherscan-api-key "$BASESCAN_API_KEY" \
  -vvvv
```

Never commit `.env`. It is intentionally ignored by git.

## Verify The Current Deployment

```bash
cast call 0xD663f820500be769a3106A7d212E057d765e9D43 \
  "paymentToken()(address)" \
  --rpc-url https://mainnet.base.org
```

Expected result:

```text
0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```

## Source

ERC-8183 specification: https://eips.ethereum.org/EIPS/eip-8183
