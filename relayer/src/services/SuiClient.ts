// src/services/SuiClient.ts
import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Logger } from '../utils/Logger';
import { Config } from '../config';

export class SuiSDKClient {
  private logger: Logger;
  private client: SuiClient;
  private keypair: Ed25519Keypair;
  private coordinatorPackageId: string;

  constructor() {
    this.logger = new Logger('SuiClient');
    this.client = new SuiClient({
      url: Config.SUI_RPC_URL,
    });
    this.keypair = Ed25519Keypair.fromSecretKey(
      Buffer.from(Config.SUI_PRIVATE_KEY, 'hex')
    );
    this.coordinatorPackageId = Config.SUI_COORDINATOR_PACKAGE_ID;
  }

  /**
   * Process storage request on Sui coordinator
   * @param params - Storage parameters
   * @returns Sui transaction digest
   */
  async processStorageRequest(params: {
    requestId: string;
    originChain: string;
    user: string;
    dataHash: string;
    walrusBlobId: string;
    zkProof: Uint8Array;
    accessPolicyHash: string;
  }): Promise<string> {
    this.logger.info('Processing storage request on Sui');

    return await this.withRetry(async () => {
      const tx = new Transaction();

      // Set gas budget conservatively
      tx.setGasBudget(100_000_000);

      // Execute move call
      tx.moveCall({
        target: `${this.coordinatorPackageId}::coordinator::process_storage_request`,
        arguments: [
          tx.pure.string(params.requestId),
          tx.pure.u8(this.chainNameToId(params.originChain)),
          tx.pure.address(params.user),
          tx.pure.vector('u8', Array.from(Buffer.from(params.dataHash, 'hex'))),
          tx.pure.string(params.walrusBlobId),
          tx.pure.vector('u8', Array.from(params.zkProof)),
     
        ],
      });

      // Sign and execute
      const result = await this.client.signAndExecuteTransaction({
        transaction: tx,
        signer: this.keypair,
        options: {
          showEffects: true,
          showEvents: true,
          showObjectChanges: true,
        },
      }); 

      // Check status
      if (result.effects?.status.status !== 'success') {
        throw new Error(`Transaction failed: ${result.effects?.status.error}`);
      } 

      this.logger.info(`Processed: ${result.digest}`);
      return result.digest;
    });
  }

  /**
   * Validate access policy on Sui
   * @param storageRequestId - Request ID
   * @param accessor - Accessor address
   * @param accessToken - Token bytes
   * @returns True if access granted
   */
  async validateAccessPolicy(
    storageRequestId: string,
    accessor: string,
    accessToken: Uint8Array
  ): Promise<boolean> {
    this.logger.info('Validating access policy on Sui');

    return await this.withRetry(async () => {
      const tx = new Transaction();

      tx.moveCall({
        target: `${this.coordinatorPackageId}::coordinator::validate_access`,
        arguments: [
          tx.pure.string(storageRequestId),
          tx.pure.address(accessor),
          tx.pure.vector('u8', Array.from(accessToken)),
        ],
      });

      const result = await this.client.signAndExecuteTransaction({
        transaction: tx,
        signer: this.keypair,
        options: {
          showEffects: true,
        },
      });

      if (result.effects?.status.status !== 'success') {
        throw new Error('Access validation failed');
      }

      // Assume the move call returns a bool event or something; parse accordingly
      // For example, check events
      const hasAccess = result.events?.some(event => event.type === 'AccessGranted'); // Adjust based on actual event

      return hasAccess ?? false;
    });
  }

  /**
   * Get storage request object from Sui
   * @param requestId - Object ID
   * @returns Object content
   */
  async getStorageRequest(requestId: string): Promise<any> {
    return await this.withRetry(async () => {
      const response = await this.client.getObject({
        id: requestId,
        options: {
          showContent: true,
          showType: true,
        },
      });

      if (!response.data) {
        throw new Error('Object not found');
      }

      return response.data.content;
    });
  }

  /**
   * Query events from Sui
   * @param params - Query parameters
   * @returns Array of events
   */
  async queryEvents(params: {
    eventType: string;
    sender?: string;
    limit?: number;
  }): Promise<any[]> {
    return await this.withRetry(async () => {
      const events = await this.client.queryEvents({
        query: {
          MoveEventType: params.eventType,
          Sender: params.sender,
        },
        limit: params.limit || 50,
        order: 'descending',
      });

      return events.data;
    });
  }

  /**
   * Get current epoch
   * @returns Current epoch number
   */
  async getCurrentEpoch(): Promise<number> {
    return await this.withRetry(async () => {
      const systemState = await this.client.getLatestSuiSystemState();
      return parseInt(systemState.epoch);
    });
  }

  /**
   * Get account balance
   * @param address - Optional address, defaults to relayer
   * @returns Balance string
   */
  async getBalance(address?: string): Promise<string> {
    return await this.withRetry(async () => {
      const addr = address || this.keypair.toSuiAddress();
      const balance = await this.client.getBalance({
        owner: addr,
      });
      return balance.totalBalance;
    });
  }

  private chainNameToId(chain: string): number {
    const mapping: Record<string, number> = {
      ethereum: 1,
      solana: 2,
      polygon: 3,
    };
    return mapping[chain] || 0;
  }

  // Retry wrapper for production resilience
  private async withRetry<T>(fn: () => Promise<T>, maxRetries = 3, delayMs = 1000): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;
        this.logger.warn(`Attempt ${attempt} failed: ${error}. Retrying in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        delayMs *= 2; // Exponential backoff
      }
    }
    this.logger.error(`Max retries exceeded`, lastError);
    throw lastError;
  }
}