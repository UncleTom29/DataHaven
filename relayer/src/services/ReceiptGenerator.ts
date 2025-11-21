// File: src/services/ReceiptGenerator.ts

import { Logger } from '../utils/Logger';
import { ethers } from 'ethers';
import * as ed25519 from 'ed25519';
import { Config } from '../config';

export class ReceiptGenerator {
  private logger: Logger;
  private ethereumWallet: ethers.Wallet;
  private solanaKeypair: any; // ed25519 keypair


  constructor() {
    this.logger = new Logger('ReceiptGenerator');
    
    const provider = new ethers.JsonRpcProvider(Config.ETHEREUM_RPC_URL);
    this.ethereumWallet = new ethers.Wallet(Config.RELAYER_ETHEREUM_PRIVATE_KEY, provider);
    
    // Generate ed25519 keypair for Solana signatures
    const seed = Buffer.from(Config.RELAYER_SOLANA_PRIVATE_KEY, 'hex');
    this.solanaKeypair = ed25519.MakeKeypair(seed);
  }

  async createReceipt(params: {
    requestId: string;
    walrusBlobId: string;
    suiTxHash: string;
    dataHash: string;
    zkProof: Buffer;
  }): Promise<any> {
    this.logger.info(`Creating receipt for request: ${params.requestId}`);

    const timestamp = Date.now();
    
    // Create receipt data structure
    const receipt = {
      requestId: params.requestId,
      walrusBlobId: params.walrusBlobId,
      suiTxHash: params.suiTxHash,
      dataHash: params.dataHash,
      zkProofHash: this.hashData(params.zkProof),
      timestamp,
      version: '1.0',
    };

    // Generate signatures for both chains
    const evmSignature = await this.signForEVM(receipt);
    const solanaSignature = this.signForSolana(receipt);

    return {
      ...receipt,
      zkProof: params.zkProof,
      signatures: {
        evm: evmSignature,
        solana: solanaSignature,
      },
    };
  }

  private async signForEVM(receipt: any): Promise<string> {
    // Create message hash
    const messageHash = ethers.solidityPackedKeccak256(
      ['bytes32', 'uint128', 'bytes32', 'bytes32', 'uint256'],
      [
        receipt.requestId,
        receipt.walrusBlobId,
        receipt.suiTxHash,
        receipt.dataHash,
        receipt.timestamp,
      ]
    );

    // Sign the message
    const signature = await this.ethereumWallet.signMessage(ethers.getBytes(messageHash));
    
    this.logger.debug(`EVM signature: ${signature}`);
    return signature;
  }

  private signForSolana(receipt: any): string {
    // Create message
    const message = Buffer.concat([
      Buffer.from(receipt.requestId, 'hex'),
      Buffer.from(receipt.walrusBlobId),
      Buffer.from(receipt.suiTxHash, 'hex'),
      Buffer.from(receipt.dataHash, 'hex'),
      Buffer.from(receipt.timestamp.toString()),
    ]);

    // Sign with ed25519
    const signature = ed25519.Sign(message, this.solanaKeypair);
    
    this.logger.debug(`Solana signature length: ${signature.length}`);
    return signature.toString('hex');
  }

  private hashData(data: Buffer): string {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(data).digest('hex');
  }
}