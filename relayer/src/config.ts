// File: src/config.ts

import dotenv from 'dotenv';

dotenv.config();

export const Config = {
  // Server
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',

  // Database
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://localhost:27017',
  MONGODB_DATABASE: process.env.MONGODB_DATABASE || 'datahaven',

  // Redis
  REDIS_HOST: process.env.REDIS_HOST || 'localhost',
  REDIS_PORT: parseInt(process.env.REDIS_PORT || '6379'),
  REDIS_PASSWORD: process.env.REDIS_PASSWORD,

  // Solana
  SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
  SOLANA_PROGRAM_ID: process.env.SOLANA_PROGRAM_ID!,
  RELAYER_SOLANA_PRIVATE_KEY: process.env.RELAYER_SOLANA_PRIVATE_KEY!,

  // Ethereum
  ETHEREUM_RPC_URL: process.env.ETHEREUM_RPC_URL!,
  ETHEREUM_CONTRACT_ADDRESS: process.env.ETHEREUM_CONTRACT_ADDRESS!,
  RELAYER_ETHEREUM_PRIVATE_KEY: process.env.RELAYER_ETHEREUM_PRIVATE_KEY!,

  // Polygon
  POLYGON_RPC_URL: process.env.POLYGON_RPC_URL,
  POLYGON_CONTRACT_ADDRESS: process.env.POLYGON_CONTRACT_ADDRESS,

  // Sui
  SUI_RPC_URL: process.env.SUI_RPC_URL || 'https://fullnode.devnet.sui.io',
  SUI_PRIVATE_KEY: process.env.SUI_PRIVATE_KEY!,
  SUI_COORDINATOR_PACKAGE_ID: process.env.SUI_COORDINATOR_PACKAGE_ID!,
  SUI_RECIPIENT_ADDRESS: process.env.SUI_RECIPIENT_ADDRESS!,
  SUI_RELAYER_ADDRESS: '0x...',

  // Walrus
  WALRUS_PUBLISHER_ID: '0x...',
  WALRUS_AGGREGATOR_URL: 'https://aggregator.walrus.space/v1/',

  // Seal
  SEAL_CONTRACT_ID: '0x...',
};

// Validate required configuration
const requiredVars = [
  'SOLANA_PROGRAM_ID',
  'RELAYER_SOLANA_PRIVATE_KEY',
  'ETHEREUM_RPC_URL',
  'ETHEREUM_CONTRACT_ADDRESS',
  'RELAYER_ETHEREUM_PRIVATE_KEY',
  'SUI_PRIVATE_KEY',
  'SUI_COORDINATOR_PACKAGE_ID',
  'WALRUS_API_KEY',
  'WORMHOLE_TOKEN_BRIDGE_ADDRESS',
];

for (const varName of requiredVars) {
  if (!process.env[varName]) {
    throw new Error(`Missing required environment variable: ${varName}`);
  }
}
