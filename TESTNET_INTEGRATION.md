# DataHaven Developer Integration Guide

## Table of Contents

1. [Quick Start](#quick-start)
2. [Smart Contract Integration](#smart-contract-integration)
3. [Client SDK Usage](#client-sdk-usage)
4. [API Reference](#api-reference)
5. [Best Practices](#best-practices)
6. [Error Handling](#error-handling)
7. [Testing](#testing)

---

## Quick Start

### Prerequisites

- Node.js v20+ and npm/yarn
- Wallet with tokens on supported chains (Ethereum, Solana, or Sui)
- Basic understanding of blockchain interactions

### Installation

```bash
npm install ethers @solana/web3.js @mysten/sui
# Or
yarn add ethers @solana/web3.js @mysten/sui
```

###  Integration

```javascript
import { ethers } from 'ethers';

// 1. Connect to DataHaven contract
const provider = new ethers.JsonRpcProvider('https://eth-testnet...');
const signer = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);

// 2. Encrypt your data (client-side)
const data = "Hello, DataHaven!";
const encryptedData = encryptData(data, userPassword);
const dataHash = ethers.keccak256(ethers.toUtf8Bytes(encryptedData));

// 3. Initiate storage request
const payment = ethers.parseEther("0.01"); // 0.01 ETH
const tx = await contract.initiateStorage(dataHash, { value: payment });
const receipt = await tx.wait();

// 4. Upload encrypted data to relayer
const requestId = receipt.logs[0].args.requestId;
await fetch('https://relayer.datahaven.xyz/upload', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    requestId,
    encryptedDataBase64: Buffer.from(encryptedData).toString('base64')
  })
});

// 5. Monitor request status
const status = await contract.getRequest(requestId);
console.log('Storage status:', status);
```

---

## Smart Contract Integration

### Ethereum (Solidity)

#### Deploy Contract

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IDataHaven {
    function initiateStorage(bytes32 _dataHash) external payable returns (bytes32);
    function getRequest(bytes32 _requestId) external view returns (Request memory);
    function revokeAccess(bytes32 _requestId) external;
}
```

#### Initiate Storage

```javascript
import { ethers } from 'ethers';

const CONTRACT_ADDRESS = "0x...";
const ABI = [
  "function initiateStorage(bytes32 _dataHash) external payable returns (bytes32)",
  "event StorageRequested(bytes32 indexed requestId, address indexed user, bytes32 dataHash, uint256 payment, uint256 timestamp)"
];

async function storeData(dataHash) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);

  // Estimate minimum payment
  const minPayment = await contract.MIN_PAYMENT();
  
  // Send transaction
  const tx = await contract.initiateStorage(dataHash, {
    value: minPayment
  });
  
  const receipt = await tx.wait();
  
  // Extract request ID from event
  const event = receipt.logs.find(log => 
    log.topics[0] === ethers.id("StorageRequested(bytes32,address,bytes32,uint256,uint256)")
  );
  
  const requestId = event.topics[1];
  console.log('Request ID:', requestId);
  
  return requestId;
}
```

#### Check Status

```javascript
async function checkStatus(requestId) {
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);
  
  const request = await contract.getRequest(requestId);
  
  return {
    user: request.user,
    dataHash: request.dataHash,
    blobId: request.blobId,
    status: ['Pending', 'Confirmed', 'Failed', 'Revoked'][request.status],
    payment: ethers.formatEther(request.payment),
    timestamp: new Date(Number(request.timestamp) * 1000)
  };
}
```

#### Revoke Access

```javascript
async function revokeAccess(requestId) {
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
  const tx = await contract.revokeAccess(requestId);
  await tx.wait();
  console.log('Access revoked');
}
```

### Solana (Anchor)

#### Initialize

```typescript
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor';
import idl from './idl.json';

const connection = new Connection('https://api.mainnet-beta.solana.com');
const wallet = new Wallet(keypair);
const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
const programId = new PublicKey('YOUR_PROGRAM_ID');
const program = new Program(idl, provider);
```

#### Initiate Storage

```typescript
async function initiateStorage(dataHashBuffer: Buffer, paymentAmount: number) {
  const [state] = PublicKey.findProgramAddressSync(
    [Buffer.from('state')],
    programId
  );
  
  const userPubkey = provider.wallet.publicKey;
  const stateAccount = await program.account.state.fetch(state);
  
  const [request] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('request'),
      userPubkey.toBuffer(),
      Buffer.from(stateAccount.count.toString())
    ],
    programId
  );
  
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault')],
    programId
  );
  
  // Convert buffer to array of 32 bytes
  const dataHashArray = Array.from(dataHashBuffer);
  
  const tx = await program.methods
    .initiateStorage(dataHashArray, paymentAmount)
    .accounts({
      state,
      request,
      user: userPubkey,
      vault,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  
  console.log('Transaction:', tx);
  console.log('Request address:', request.toBase58());
  
  return request.toBase58();
}
```

#### Check Status

```typescript
async function checkStatus(requestAddress: string) {
  const requestPubkey = new PublicKey(requestAddress);
  const request = await program.account.request.fetch(requestPubkey);
  
  return {
    user: request.user.toBase58(),
    dataHash: Buffer.from(request.dataHash).toString('hex'),
    blobId: Buffer.from(request.blobId).toString('hex'),
    status: ['Pending', 'Confirmed', 'Failed', 'Revoked'][request.status],
    payment: request.payment,
    timestamp: new Date(request.timestamp * 1000)
  };
}
```

### Sui (Move)

#### Initialize

```typescript
import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const client = new SuiClient({ url: 'https://fullnode.mainnet.sui.io' });
const keypair = Ed25519Keypair.fromSecretKey(privateKeyBytes);
const packageId = 'PACKAGE_ID';
```

#### Initiate Storage

```typescript
async function initiateStorage(dataHash: Uint8Array, payment: string) {
  const tx = new Transaction();
  
  // Split coins for payment
  const [coin] = tx.splitCoins(tx.gas, [payment]);
  
  tx.moveCall({
    target: `${packageId}::origin::initiate_storage`,
    arguments: [
      tx.object('STATE_OBJECT_ID'),
      tx.pure.vector('u8', Array.from(dataHash)),
      coin,
      tx.object('0x6'), // Clock object
    ],
  });
  
  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: {
      showEffects: true,
      showEvents: true,
      showObjectChanges: true,
    },
  });
  
  // Extract request object ID from created objects
  const requestObject = result.objectChanges?.find(
    change => change.type === 'created' && change.objectType.includes('Request')
  );
  
  console.log('Request Object ID:', requestObject?.objectId);
  return requestObject?.objectId;
}
```

---

## Client SDK Usage

### Encryption Helper

```typescript
import crypto from 'crypto';

/**
 * Encrypt data using AES-256-GCM
 */
export function encryptData(
  data: string | Buffer,
  password: string
): { encrypted: Buffer; salt: Buffer; iv: Buffer } {
  const salt = crypto.randomBytes(32);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  const iv = crypto.randomBytes(16);
  
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(data),
    cipher.final(),
    cipher.getAuthTag()
  ]);
  
  return { encrypted, salt, iv };
}

/**
 * Decrypt data
 */
export function decryptData(
  encrypted: Buffer,
  password: string,
  salt: Buffer,
  iv: Buffer
): Buffer {
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  
  const authTag = encrypted.slice(-16);
  const ciphertext = encrypted.slice(0, -16);
  
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]);
}
```

### Complete Storage Flow

```typescript
import { ethers } from 'ethers';
import { encryptData } from './crypto';

class DataHavenClient {
  constructor(
    private provider: ethers.Provider,
    private signer: ethers.Signer,
    private contractAddress: string,
    private relayerUrl: string
  ) {}
  
  async store(data: string | Buffer, password: string) {
    // 1. Encrypt data
    const { encrypted, salt, iv } = encryptData(data, password);
    
    // 2. Compute hash
    const dataHash = ethers.keccak256(encrypted);
    
    // 3. Initiate on-chain request
    const contract = new ethers.Contract(
      this.contractAddress,
      ['function initiateStorage(bytes32) external payable'],
      this.signer
    );
    
    const minPayment = ethers.parseEther('0.01');
    const tx = await contract.initiateStorage(dataHash, { value: minPayment });
    const receipt = await tx.wait();
    
    // 4. Extract request ID
    const requestId = receipt.logs[0].topics[1];
    
    // 5. Upload encrypted data to relayer
    const response = await fetch(`${this.relayerUrl}/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId,
        encryptedDataBase64: encrypted.toString('base64')
      })
    });
    
    if (!response.ok) {
      throw new Error('Upload failed');
    }
    
    // 6. Store metadata for decryption
    return {
      requestId,
      salt: salt.toString('base64'),
      iv: iv.toString('base64')
    };
  }
  
  async retrieve(requestId: string, password: string, salt: string, iv: string) {
    // 1. Check status on-chain
    const contract = new ethers.Contract(
      this.contractAddress,
      ['function getRequest(bytes32) external view returns (tuple)'],
      this.provider
    );
    
    const request = await contract.getRequest(requestId);
    
    if (request.status !== 1) { // Not confirmed
      throw new Error('Request not confirmed');
    }
    
    // 2. Request retrieval from relayer
    const response = await fetch(
      `${this.relayerUrl}/storage/${requestId}`
    );
    
    if (!response.ok) {
      throw new Error('Retrieval failed');
    }
    
    const { walrusBlobId } = await response.json();
    
    // 3. Fetch from Walrus (through relayer proxy)
    const dataResponse = await fetch(
      `${this.relayerUrl}/retrieve/${walrusBlobId}`
    );
    
    const encryptedData = Buffer.from(await dataResponse.arrayBuffer());
    
    // 4. Decrypt
    const decrypted = decryptData(
      encryptedData,
      password,
      Buffer.from(salt, 'base64'),
      Buffer.from(iv, 'base64')
    );
    
    return decrypted;
  }
}

// Usage
const client = new DataHavenClient(
  provider,
  signer,
  '0xCONTRACT_ADDRESS',
  'https://relayer.datahaven.io'
);

const metadata = await client.store('My secret data', 'my-password');
console.log('Stored with ID:', metadata.requestId);

// Later...
const retrieved = await client.retrieve(
  metadata.requestId,
  'my-password',
  metadata.salt,
  metadata.iv
);
console.log('Retrieved:', retrieved.toString());
```

---

## API Reference

### Relayer REST API

#### POST /upload

Upload encrypted data for a storage request.

**Request:**
```json
{
  "requestId": "0x...",
  "encryptedDataBase64": "base64_encoded_data"
}
```

**Response:**
```json
{
  "message": "Upload successful"
}
```

#### GET /storage/:requestId

Get status of a storage request.

**Response:**
```json
{
  "requestId": "0x...",
  "user": "0x...",
  "dataHash": "0x...",
  "status": "confirmed",
  "walrusBlobId": "blob_id",
  "suiTxHash": "tx_hash",
  "payment": "1000000",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

#### GET /estimate

Estimate fees for storage.

**Query Parameters:**
- `sizeBytes`: Number - Size of data in bytes

**Response:**
```json
{
  "walrusSui": 0.0002,
  "gasSui": 0.02,
  "totalSui": 0.0202
}
```

#### GET /health

Health check endpoint.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "uptime": 3600
}
```

---

## Best Practices

### 1. Data Encryption

✅ **DO:**
- Always encrypt data client-side before uploading
- Use strong passwords (12+ characters, mixed case, symbols)
- Store salt and IV securely alongside encrypted data
- Use AES-256-GCM for authenticated encryption

❌ **DON'T:**
- Never send unencrypted sensitive data
- Don't reuse IVs for different encryptions
- Don't store passwords in plaintext

### 2. Error Handling

```typescript
async function storeWithRetry(data: Buffer, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await client.store(data, password);
    } catch (error) {
      if (attempt === maxRetries) throw error;
      
      console.log(`Attempt ${attempt} failed, retrying...`);
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }
}
```

### 3. Payment Estimation

```typescript
async function estimateStorageCost(dataSizeBytes: number) {
  const response = await fetch(
    `${relayerUrl}/estimate?sizeBytes=${dataSizeBytes}`
  );
  const estimate = await response.json();
  
  // Add 20% buffer for gas price fluctuations
  const payment = Math.ceil(estimate.totalSui * 1.2 * 1e9); // Convert to lamports
  
  return payment;
}
```

### 4. Event Monitoring

```typescript
// Listen for confirmation events
contract.on('StorageConfirmed', (requestId, blobId, suiTxHash) => {
  console.log('Storage confirmed!');
  console.log('Request ID:', requestId);
  console.log('Blob ID:', blobId);
  console.log('Sui Tx:', suiTxHash);
});

// Listen for failure events
contract.on('RequestFailed', (requestId) => {
  console.log('Storage failed, refund initiated');
});
```

---

## Error Handling

### Common Errors

| Error Code | Description | Solution |
|------------|-------------|----------|
| `INSUFFICIENT_PAYMENT` | Payment below minimum | Check `MIN_PAYMENT` constant |
| `PAUSED` | Contract is paused | Wait for admin to unpause |
| `INVALID_STATUS` | Request in wrong state | Check current status first |
| `UNAUTHORIZED` | Caller not authorized | Use correct signer |
| `UPLOAD_FAILED` | Data upload failed | Retry with exponential backoff |

### Error Handling Example

```typescript
try {
  await contract.initiateStorage(dataHash, { value: payment });
} catch (error) {
  if (error.code === 'INSUFFICIENT_FUNDS') {
    console.error('Insufficient balance for transaction');
  } else if (error.message.includes('INSUFFICIENT_PAYMENT')) {
    console.error('Payment too low, increase amount');
  } else if (error.message.includes('PAUSED')) {
    console.error('Contract is paused, try again later');
  } else {
    console.error('Unexpected error:', error);
  }
}
```

---

## Testing

### Unit Tests

```typescript
import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('DataHaven Storage', () => {
  it('should store data successfully', async () => {
    const [user] = await ethers.getSigners();
    const contract = await ethers.deployContract('DataHavenOrigin');
    
    const dataHash = ethers.randomBytes(32);
    const payment = ethers.parseEther('0.01');
    
    await expect(
      contract.connect(user).initiateStorage(dataHash, { value: payment })
    ).to.emit(contract, 'StorageRequested');
  });
  
  it('should reject insufficient payment', async () => {
    const contract = await ethers.deployContract('DataHavenOrigin');
    const dataHash = ethers.randomBytes(32);
    const lowPayment = ethers.parseEther('0.0001');
    
    await expect(
      contract.initiateStorage(dataHash, { value: lowPayment })
    ).to.be.revertedWithCustomError(contract, 'InsufficientPayment');
  });
});
```

### Integration Tests

```typescript
describe('End-to-End Storage Flow', () => {
  it('should complete full storage cycle', async () => {
    // 1. Encrypt data
    const data = 'Test data';
    const { encrypted, salt, iv } = encryptData(data, 'password');
    
    // 2. Initiate storage
    const requestId = await client.store(encrypted, 'password');
    
    // 3. Wait for confirmation (in test, mock relayer)
    await waitForConfirmation(requestId, 30000);
    
    // 4. Retrieve data
    const retrieved = await client.retrieve(requestId, 'password', salt, iv);
    
    expect(retrieved.toString()).to.equal(data);
  });
});
```

---

## Support & Resources

- **GitHub:** https://github.com/uncletom29/datahaven
- **Website:** https://datahaven.vercel.app
- **Twitter:** @DataHavenX

## License

MIT License - see LICENSE file for details