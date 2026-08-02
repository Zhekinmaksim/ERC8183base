# ERC-8183 AgenticCommerce: деплой на Base

Контракт: `contracts/AgenticCommerce.sol`

Это UUPS upgradeable reference implementation ERC-8183 из EIP-спецификации:
https://eips.ethereum.org/EIPS/eip-8183

Деплой-скрипт поднимает два адреса:

- `implementation` - логика контракта.
- `proxy` - основной адрес, который нужно использовать в приложениях (`createJob`, `fund`, `submit`, `complete`).

## 1. Установка Foundry

```bash
curl -L https://foundry.paradigm.xyz | bash
source ~/.zshrc
foundryup
forge --version
```

Если shell не видит `forge`, открой новый терминал или выполни:

```bash
export PATH="$HOME/.foundry/bin:$PATH"
```

## 2. Установка зависимостей

Из корня этого репозитория:

```bash
cd /Users/zmaxx/Projects/ERC8183

forge install foundry-rs/forge-std --no-git
forge install OpenZeppelin/openzeppelin-contracts --no-git
forge install OpenZeppelin/openzeppelin-contracts-upgradeable --no-git
```

В проекте уже есть:

- `foundry.toml`
- `remappings.txt`
- `contracts/AgenticCommerce.sol`
- `contracts/IACPHook.sol`
- `script/DeployERC8183.s.sol`

## 3. Компиляция

```bash
forge build
```

Контракт компилируется Solidity `0.8.28` с `evm_version = "cancun"`, потому что reference implementation использует `ReentrancyGuardTransient`.

## 4. Куда вставлять приватный ключ деплоера

Не вставляй приватный ключ в `.sol` или `.s.sol` файлы.

Скопируй пример env-файла:

```bash
cp .env.example .env
```

Открой `.env` и вставь приватный ключ деплоера сюда:

```bash
export DEPLOYER_PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE
```

Там же укажи treasury:

```bash
export TREASURY_ADDRESS=0xYOUR_TREASURY_ADDRESS
```

`TREASURY_ADDRESS` - адрес, куда будут идти platform fees. На старте можно поставить адрес деплоера.

Важно:

- `.env` уже добавлен в `.gitignore`.
- На деплоер-кошельке должен быть ETH в Base для газа.
- Не используй кошелек с большими средствами как деплоер.

## 5. Base RPC и USDC

В `.env.example` уже указан публичный RPC:

```bash
export BASE_RPC_URL=https://mainnet.base.org
```

По умолчанию скрипт использует native USDC на Base:

```bash
export PAYMENT_TOKEN=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```

Если нужен другой ERC-20 токен для escrow, поменяй `PAYMENT_TOKEN` в `.env`.

## 6. Деплой implementation + proxy

Загрузи переменные из `.env`:

```bash
source .env
```

Запусти деплой:

```bash
forge script script/DeployERC8183.s.sol:DeployERC8183 \
  --rpc-url "$BASE_RPC_URL" \
  --broadcast \
  -vvvv
```

В выводе будут строки:

```text
AgenticCommerce implementation: 0x...
AgenticCommerce proxy: 0x...
Payment token: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
Treasury: 0x...
```

Используй именно `AgenticCommerce proxy` как адрес ERC-8183 контракта.

## 7. Деплой с верификацией на BaseScan

Добавь ключ в `.env`:

```bash
export BASESCAN_API_KEY=your_basescan_api_key
```

Потом:

```bash
source .env

forge script script/DeployERC8183.s.sol:DeployERC8183 \
  --rpc-url "$BASE_RPC_URL" \
  --broadcast \
  --verify \
  --etherscan-api-key "$BASESCAN_API_KEY" \
  -vvvv
```

## 8. Проверка proxy после деплоя

Подставь адрес proxy:

```bash
export AGENTIC_COMMERCE=0xYOUR_PROXY_ADDRESS
```

Проверить payment token:

```bash
cast call "$AGENTIC_COMMERCE" \
  "paymentToken()(address)" \
  --rpc-url "$BASE_RPC_URL"
```

Проверить treasury:

```bash
cast call "$AGENTIC_COMMERCE" \
  "platformTreasury()(address)" \
  --rpc-url "$BASE_RPC_URL"
```

## 9. Использование с base-jobs.js

После деплоя:

```bash
AGENTIC_COMMERCE=0xYOUR_PROXY_ADDRESS node base-jobs.js
```

`base-jobs.js` должен работать с proxy-адресом, не с implementation.

## 10. Upgrade в будущем

Для UUPS upgrade деплоер/admin должен вызвать upgrade на proxy. Admin роли выдаются адресу, который деплоит proxy, потому что `initialize()` вызывается внутри конструктора `ERC1967Proxy`.

Минимальная логика upgrade:

```solidity
AgenticCommerce newImplementation = new AgenticCommerce();
AgenticCommerce(proxy).upgradeToAndCall(address(newImplementation), "");
```

Перед upgrade обязательно проверь storage layout.
