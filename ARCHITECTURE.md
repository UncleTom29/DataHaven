# DataHaven Technical Architecture

## Overview

DataHaven is a decentralized, cross-chain encrypted data storage protocol that enables users to store encrypted data on Walrus (Sui's decentralized storage) while maintaining origin records on Ethereum, Solana, or Sui blockchains.

## System Components

### 1. Origin Chains (User Entry Points)

**Supported Chains:**
- Ethereum (EVM)
- Solana
- Sui

**Smart Contracts:**
- `DataHavenOrigin.sol` (Ethereum)
- `datahaven_solana` (Solana/Anchor)
- `datahaven::origin` (Sui/Move)

**Responsibilities:**
- Accept user storage requests with payment
- Emit events for relayer monitoring
- Verify and store receipts from coordinator
- Handle refunds for failed requests
- Manage access revocation

### 2. Sui Coordinator Chain

**Package:** `datahaven::coordinator`

**Responsibilities:**
- Central coordination layer for all storage operations
- Process storage requests from all origin chains
- Maintain global state and metadata
- Validate ZK proofs
- Enforce access policies
- Generate cross-chain receipts

### 3. Walrus Decentralized Storage

**Purpose:** Persistent encrypted data storage

**Features:**
- Content-addressed blob storage
- Erasure coding for redundancy
- Configurable storage epochs (duration)
- Blob metadata on Sui blockchain

### 4. Relayer Service (Node.js/TypeScript)

**Core Services:**
- `EventListener` - Monitors blockchain events
- `WalrusSDKClient` - Handles Walrus storage operations
- `SealZKHandler` - Manages zero-knowledge proofs
- `WormholeBridger` - Cross-chain token bridging
- `FraudDetector` - Security and validation
- `ReceiptGenerator` - Creates cryptographic receipts
- `SuiSDKClient` - Sui blockchain interactions

**Infrastructure:**
- MongoDB - Persistent data storage
- Redis/Bull - Job queue for async processing
- Prometheus - Metrics collection

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER LAYER                               │
├──────────────┬──────────────────┬──────────────────────────────┤
│   Ethereum   │      Solana      │           Sui                │
│   Contract   │      Program     │         Package              │
└──────┬───────┴────────┬─────────┴────────────┬─────────────────┘
       │                │                      │
       │    Storage Request Events            │
       │                │                      │
       ▼                ▼                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                      RELAYER SERVICE                             │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────────┐    │
│  │EventListener │  │ Job Processor │  │ FraudDetector    │    │
│  └──────┬───────┘  └───────┬───────┘  └────────┬─────────┘    │
│         │                  │                    │               │
│         ▼                  ▼                    ▼               │
│  ┌──────────────────────────────────────────────────────┐      │
│  │            Redis Queue (Bull)                        │      │
│  └──────────────────────────────────────────────────────┘      │
│         │                  │                    │               │
│         ▼                  ▼                    ▼               │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐       │
│  │   Walrus    │  │  Seal ZK     │  │  Wormhole       │       │
│  │   Client    │  │  Handler     │  │  Bridger        │       │
│  └─────┬───────┘  └──────┬───────┘  └────────┬────────┘       │
│        │                 │                    │                │
└────────┼─────────────────┼────────────────────┼────────────────┘
         │                 │                    │
         ▼                 ▼                    ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│     Walrus      │ │  Sui Coordinator│ │   Wormhole      │
│     Storage     │ │     Package     │ │  Token Bridge   │
└─────────────────┘ └─────────────────┘ └─────────────────┘
         │                 │                    │
         └─────────────────┴────────────────────┘
                           │
                  Receipt Generation
                           │
         ┌─────────────────┴────────────────────┐
         │                                      │
         ▼                                      ▼
  ┌─────────────┐                       ┌─────────────┐
  │  Ethereum   │                       │   Solana    │
  │  Receipt    │                       │   Receipt   │
  │ Submission  │                       │ Submission  │
  └─────────────┘                       └─────────────┘
```

## Data Flow

### Storage Request Flow

```
1. User → Origin Chain Contract (with payment)
   ↓
2. Contract emits StorageRequested event
   ↓
3. Relayer EventListener picks up event
   ↓
4. Fraud check (rate limits, blacklist, patterns)
   ↓
5. User uploads encrypted data to Relayer API
   ↓
6. Relayer stores encrypted data on Walrus
   ↓
7. Generate ZK storage proof
   ↓
8. Submit to Sui Coordinator for verification
   ↓
9. Generate cryptographic receipt
   ↓
10. Submit receipt to Origin Chain
    ↓
11. Bridge payment to Sui (if cross-chain)
```

### Retrieval Request Flow

```
1. User → Origin Chain (request retrieval)
   ↓
2. Contract emits RetrievalRequested event
   ↓
3. Relayer validates access policy
   ↓
4. Generate ZK access proof
   ↓
5. Retrieve encrypted data from Walrus
   ↓
6. Generate integrity proof
   ↓
7. Return data + proofs to user
```

## Technology Stack

### Smart Contracts
- **Ethereum:** Solidity 0.8.x
- **Solana:** Anchor Framework 0.30.x
- **Sui:** Move Language

### Relayer Backend
- **Runtime:** Node.js v20+ / TypeScript
- **Frameworks:** Express.js
- **Storage:** MongoDB, Redis
- **Queue:** Bull (Redis-based)
- **Monitoring:** Winston (logging), Prometheus (metrics)

### Blockchain SDKs
- **Ethereum:** ethers.js v6
- **Solana:** @solana/web3.js, @coral-xyz/anchor
- **Sui:** @mysten/sui
- **Walrus:** @mysten/walrus
- **Seal (ZK):** @mysten/seal
- **Wormhole:** @wormhole-foundation/sdk, @mayanfinance/wormhole-sdk-route

## Security Features

### 1. Zero-Knowledge Proofs (Seal)
- Storage proofs verify data was stored correctly
- Access proofs validate retrieval permissions
- Integrity proofs ensure data hasn't been tampered

### 2. Fraud Detection
- Rate limiting (10 requests/min per user)
- Replay attack prevention (1-hour window)
- Behavioral analysis (statistical outliers)
- Address blacklisting
- Payment anomaly detection

### 3. Cryptographic Receipts
- Multi-chain signatures (ECDSA for EVM, Ed25519 for Solana/Sui)
- Hash-based verification
- Timestamped and immutable

### 4. Access Control
- User-controlled revocation
- Time-based access policies
- Token-based authorization


## Future Enhancements

1. **Multi-Region Deployment** - Geographic distribution of relayers
2. **Advanced ZK Circuits** - Custom circuits for specific use cases
3. **More Origin Chains** - 50+ chains
4. **Data Compression** - Pre-storage compression to reduce costs
5. **Incentive Layer** - Token rewards for relayer operators
6. **Decentralized Relayer Network** - Remove single point of failure