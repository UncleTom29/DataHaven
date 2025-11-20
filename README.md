# DataHaven

**Cross-Chain Privacy Layer for Decentralized Storage**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Built with Walrus](https://img.shields.io/badge/Built%20with-Walrus-blue)](https://walrus.io)
[![Powered by Seal](https://img.shields.io/badge/Powered%20by-Seal-green)](https://seal.app)
[![Multi-Chain](https://img.shields.io/badge/Multi--Chain-ETH%20|%20SOL%20|%20SUI-orange)](https://github.com/yourusername/datahaven)

DataHaven enables users on any blockchain (Ethereum, Solana, Sui) to securely store encrypted data on Walrus with zero-knowledge privacy guarantees, all without leaving their native chain.

🔗 **[Demo]()** • 📚 **[Pitch](https://docs.google.com/presentation/d/1au-rc8LnN8E1ES53H930WJsU-8kdQUxmuHX1QkpgxS8/edit?usp=sharing)** • 🌐 **[Website](https://datahaven.vercel.app)**

- Sui Testnet Deployment:  https://suiscan.xyz/testnet/object/0x3b27c207fcac0f39646010314460ce306cfd1602a023a179e0fa3b1db00bb485/contracts
- Solana Devnet Deployment: https://solscan.io/account/GRLdEPx7n4g2kowPvfPrPWpToeap3sHbKSDe18bCLyU5?cluster=devnet
- Sepolia Deployment: https://sepolia.etherscan.io/address/0x2a539aE52d86C63052cD19ADd268D83Cf76f5B07#code

---

## 🌟 Features

- **🔐 Zero-Knowledge Privacy** - Prove storage and access without revealing data using Seal SDK
- **🌐 Cross-Chain Native** - Support for Ethereum, Solana, and Sui
- **✅ Verifiable Storage** - Cryptographic proof of data availability on Walrus
- **🛡️ ML Fraud Detection** - Real-time anomaly detection with TensorFlow
- **⚡ Instant Retrieval** - Fast data access with integrity verification
- **🔄 User Revocable** - Full control over data access rights
- **📊 Policy Management** - Time-based, address-based access control
- **🔗 Cross-Chain Payments** - Wormhole bridge integration for seamless token conversion

---


## Use Cases

- Private document storage with verifiable integrity
- Cross-chain data sharing with granular access control
- GDPR/HIPAA compliant data management
- Enterprise data sovereignty


## Innovation

- First to combine Walrus + Seal for cross-chain privacy
- Zero-knowledge proofs for storage attestation and access control
- Multi-chain support with single relayer architecture
- Off-chain complexity, on-chain simplicity


## 🏗️ Architecture

```
┌─────────────────────────────────────────┐
│     Origin Chains (ETH/SOL/SUI)         │
│  ✅ Collect payment                      │
│  ✅ Emit StorageRequested event          │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│        Relayer Service (Off-Chain)       │
│  ✅ Event Listening (WebSocket)          │
│  ✅ Walrus SDK (Storage)                 │
│  ✅ Seal SDK (ZK Proofs)                 │
│  ✅ FX Router (Wormhole)                 │
│  ✅ Fraud Detection (ML)                 │
│  ✅ Database (MongoDB)                   │
│  ✅ Metrics (Prometheus)                 │
└─────────────────────────────────────────┘
```

---

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- Rust & Cargo
- Solana CLI
- Sui CLI
- MongoDB
- Redis

### Installation

```bash
# Clone the repository
git clone https://github.com/uncletom29/datahaven.git
cd datahaven

# Install dependencies
npm install

# Setup environment
cp .env.example .env
# Edit .env with your configuration

# Build contracts
cd contracts/ethereum && npx hardhat compile
cd ../solana && anchor build
cd ../sui && sui move build
```

### Deploy Contracts

```bash
# Ethereum (Sepolia)
cd contracts/ethereum
export RELAYER_ADDRESS="0xYourRelayerAddress"
npx hardhat run scripts/deploy.ts --network sepolia

# Solana (Devnet)
cd contracts/solana
anchor deploy --provider.cluster devnet

# Sui (Devnet)
cd contracts/sui
sui client publish --gas-budget 100000000
```

### Run Relayer Service

```bash
cd relayer
npm run build
npm start

# Or with PM2
pm2 start ecosystem.config.js
```

---

## 📦 Repository Structure

```
datahaven/
├── contracts/
│   ├── ethereum/          # Solidity contracts
│   ├── solana/            # Anchor programs
│   └── sui/               # Move contracts
├── relayer/
│   ├── src/
│   │   ├── services/      # Core services
│   │   │   ├── EventListener.ts
│   │   │   ├── TransactionExecutor.ts
│   │   │   ├── SealZKHandler.ts
│   │   │   ├── WalrusClient.ts
│   │   │   ├── FraudDetector.ts
│   │   │   └── ...
│   │   ├── utils/
│   │   └── config.ts
│   └── package.json
├── sdk/                   # TypeScript SDK
├── docs/                  # Documentation
├── circuits/              # ZK circuits (Seal)
└── README.md
```

---

## 🔧 Configuration

Create a `.env` file in the relayer directory:

```env
# Ethereum
ETHEREUM_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR-KEY
ETHEREUM_CONTRACT_ADDRESS=0x...
RELAYER_ETHEREUM_PRIVATE_KEY=0x...

# Solana
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_PROGRAM_ID=...
RELAYER_SOLANA_PRIVATE_KEY=...

# Sui
SUI_RPC_URL=https://fullnode.devnet.sui.io
SUI_PRIVATE_KEY=...
SUI_PACKAGE_ID=0x...

# Walrus
WALRUS_PUBLISHER_ID=0x...
WALRUS_AGGREGATOR_URL=https://aggregator.walrus.io

# Seal
SEAL_CONTRACT_ID=0x...

# Database
MONGODB_URI=mongodb://localhost:27017
REDIS_HOST=localhost
```

---

## 💻 Usage

### Store Data

```typescript
import { createDataHavenClient, Chain } from '@datahaven/sdk';

const client = createDataHavenClient({
  chain: Chain.ETHEREUM,
  rpcUrl: 'https://eth-sepolia.g.alchemy.com/v2/YOUR-KEY',
  contractAddress: '0x...',
  walletPrivateKey: 'your-private-key',
});

// Encrypt data client-side
const data = new TextEncoder().encode('Sensitive data');
const { encrypted, salt, iv } = await DataHavenUtils.encryptData(data, 'password');

// Get data hash
const dataHash = await DataHavenUtils.hashData(encrypted);

// Initiate storage
const requestId = await client.initiateStorage({
  dataHash,
  payment: ethers.parseEther('0.001'),
});

console.log('Storage request initiated:', requestId);
```

### Retrieve Data

```typescript
// Request retrieval
const retrievalId = await client.requestRetrieval({
  storageRequestId: requestId,
  accessToken: 'your-access-token',
});

// Data will be retrieved by relayer and verified with ZK proofs
```

---

## 🧪 Testing

```bash
# Run all tests
npm test

# Test specific contract
cd contracts/ethereum && npx hardhat test
cd contracts/solana && anchor test
cd contracts/sui && sui move test

# Integration tests
npm run test:integration
```


---

## 🛣️ Roadmap

- [x] Multi-chain contract deployment
- [x] Walrus SDK integration
- [x] Seal ZK proof generation
- [x] ML-based fraud detection
- [ ] Additional chain support (22+)
- [ ] Typescript SDK 
- [ ] DAO governance

---


## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## 🔗 Links

- **Website**: [datahaven.vercel.app](https://datahaven.vercel.app)
- **Twitter**: [@DataHavenX](https://twitter.com/DataHavenX)

---

## 🙏 Acknowledgments

Built with:
- [Walrus](https://walrus.io) - Decentralized storage
- [Seal](https://seal.app) - Zero-knowledge proofs
- [Sui](https://sui.io) - High-performance blockchain
- [Ethereum](https://ethereum.org) 
- [Solana](https://solana.com) 
- [Wormhole](https://wormhole.com) - Cross-chain messaging

---


**Built with ❤️ for the decentralized future**