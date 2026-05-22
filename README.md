# Sector Message Drop

Supabase-backed message drop website with a separate reward-code admin page and an optional smart-contract-backed token matched ATM flow.

## Message Drop

- Stores submitted entries in Supabase.
- Uses an anonymous browser/device token plus request IP hash for rate limiting.
- Limits each recognizable device/IP window to 2 entries per hour.
- Each message must be 1-26 characters with no spaces.
- Browser websites cannot read a real device MAC address.

## Supabase Setup

1. Create a Supabase project.
2. Open the Supabase SQL editor.
3. Run `supabase-schema.sql`.
4. Deploy the static site.

Messages are available in Supabase Table Editor > `drops`.

## Token Matched ATM

The Solidity contract is in `contracts/TokenMatchedATM.sol`.

It does the following:

- Accepts one configured ERC-20 token.
- Requires the exact configured deposit amount through `transferFrom`.
- Releases a fixed native-chain payout from the funded contract vault.
- Rejects unsupported token paths through `claimWithToken`.
- Prevents reentrancy with OpenZeppelin `ReentrancyGuard`.
- Supports owner-only pause, unpause, term updates, native withdrawals, accepted token withdrawals, and unsupported token recovery.
- Emits events for claims, funding, withdrawals, term updates, and pause changes.
- Never stores private keys or seed phrases.

The browser wallet interface is `token-atm.html`.

### Install And Test

```bash
npm install
npm test
```

### Deploy

Set the owner wallet, accepted ERC-20 token, required deposit, and payout in base units:

```bash
ATM_OWNER=0xYourOwnerWallet \
ACCEPTED_TOKEN=0xAcceptedErc20Token \
REQUIRED_DEPOSIT=10000000000000000000 \
PAYOUT_AMOUNT=100000000000000000 \
SEPOLIA_RPC_URL=https://your-sepolia-rpc-url \
DEPLOYER_PRIVATE_KEY=your-temporary-testnet-deployer-key \
npm run deploy:atm -- --network sepolia
```

After deployment:

1. Fund the contract with native ETH using the contract address.
2. Put the deployed contract address in `token-atm.html` as `ATM_ADDRESS`.
3. Put the ERC-20 address in `token-atm.html` as `TOKEN_ADDRESS`.
4. Deploy the updated static site.

Users then connect a wallet, approve the exact ERC-20 deposit, and submit the claim transaction. The wallet signs all approvals and claims directly. The site does not custody user funds or private keys.

## Important Security Notes

- Do not paste seed phrases or private keys into this project.
- Do not deploy with an unfunded payout vault.
- Do not use the owner wallet for everyday browsing.
- Verify the accepted token address and payout amount before deployment.
- Test on Sepolia or another testnet before using mainnet funds.
