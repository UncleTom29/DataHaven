// src/services/WalrusSDKClient.ts
import { walrus, WalrusFile } from '@mysten/walrus';
import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Logger } from '../utils/Logger';
import { Config } from '../config';
import * as crypto from 'crypto';

export class WalrusSDKClient {
  private logger: Logger;
  private suiClient: any;
  private signer: Ed25519Keypair;

  constructor() {
    this.logger = new Logger('WalrusSDKClient');
    
    const network = this.getNetworkFromUrl(Config.SUI_RPC_URL);
    
    this.logger.info(`Initializing Walrus client on ${network}`);
    

    this.suiClient = (new SuiClient({ 
      url: Config.SUI_RPC_URL 
    }).$extend(walrus({ network })) as unknown) as any;
    
    this.signer = Ed25519Keypair.fromSecretKey(Buffer.from(Config.SUI_PRIVATE_KEY, 'hex'));
  }

  /**
   * Determine network (mainnet or testnet) from RPC URL
   */
  private getNetworkFromUrl(url: string): 'mainnet' | 'testnet' {
    const urlLower = url.toLowerCase();
    
    if (urlLower.includes('mainnet')) {
      return 'mainnet';
    }
    

    return 'testnet';
  }

  /**
   * Store encrypted data on Walrus with metadata
   * @param data - Encrypted data as Uint8Array
   * @param options - Optional metadata and deletable flag
   * @returns { blobId, suiRef, metadata }
   */
  async store(
    data: Uint8Array,
    options?: {
      metadata?: Record<string, string>;
      deletable?: boolean;
    }
  ): Promise<{
    blobId: string;
    suiRef: string;
    metadata: any;
  }> {
    this.logger.info(`Storing ${data.length} bytes on Walrus`);

    try {
      // Create WalrusFile
      const file = WalrusFile.from({
        contents: data,
        identifier: 'encrypted-data.bin',
        tags: options?.metadata ?? {},
      });

      // Write file (single file quilt)
      const results = await this.suiClient.walrus.writeFiles({
        files: [file],
        epochs: 5, // Default 5 epochs
        deletable: options?.deletable ?? false,
        signer: this.signer,
      });

      const { id: blobId } = results[0];

      // Verify storage by computing hash
      const storedHash = this.computeHash(data);
      await this.verifyStorage(blobId, storedHash);

      this.logger.info(`Stored blob ID: ${blobId}`);

      return {
        blobId,
        suiRef: results.txDigest || '', 
        metadata: results[0].blobObject,
      };
    } catch (error) {
      this.logger.error('Storage failed', error);
      throw new Error(`Walrus storage error: ${error}`);
    }
  }

  /**
   * Retrieve data from Walrus by blob ID
   * @param blobId - Walrus blob ID
   * @returns Retrieved data as Uint8Array
   */
  async retrieve(blobId: string): Promise<Uint8Array> {
    this.logger.info(`Retrieving blob: ${blobId}`);

    try {
      const blob = await this.suiClient.walrus.readBlob({ blobId });
      this.logger.info(`Retrieved ${blob.length} bytes`);
      return blob;
    } catch (error) {
      this.logger.error('Retrieval failed', error);
      throw new Error(`Walrus retrieval error: ${error}`);
    }
  }

  /**
   * Get blob metadata from Sui
   * @param blobId - Walrus blob ID
   * @returns Blob metadata
   */
  async getBlobMetadata(blobId: string): Promise<any> {
    try {
      const metadata = await this.suiClient.walrus.getBlob({ blobId }).then((blob: { blobObject: any; }) => blob.blobObject);
      return metadata;
    } catch (error) {
      this.logger.error('Metadata fetch failed', error);
      throw error;
    }
  }

  /**
   * Verify storage by retrieving and hashing
   * @param blobId - Blob ID
   * @param expectedHash - Expected SHA-256 hash
   */
  private async verifyStorage(blobId: string, expectedHash: string): Promise<void> {
    const retrieved = await this.retrieve(blobId);
    const actualHash = this.computeHash(retrieved);
    if (actualHash !== expectedHash) {
      throw new Error('Storage verification failed: hash mismatch');
    }
    this.logger.info('Storage verified successfully');
  }

  /**
   * Compute SHA-256 hash
   * @param data - Data to hash
   * @returns Hex string hash
   */
  private computeHash(data: Uint8Array): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  // Additional production features: retries
  private async withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
    let attempts = 0;
    while (attempts < maxRetries) {
      try {
        return await fn();
      } catch (error) {
        attempts++;
        this.logger.warn(`Retry ${attempts}/${maxRetries}: ${error}`);
        if (attempts === maxRetries) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
      }
    }
    throw new Error('Max retries exceeded');
  }
}