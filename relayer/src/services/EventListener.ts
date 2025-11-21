// File: src/services/EventListener.ts

import { Connection, PublicKey } from '@solana/web3.js';
import { ethers } from 'ethers';
import { Database } from './Database';
import { RedisQueue } from './RedisQueue';
import { Logger } from '../utils/Logger';
import { Config } from '../config';

export class EventListener {
  private logger: Logger;
  private solanaConnection: Connection;
  private ethereumProvider: ethers.JsonRpcProvider;
  private processedTxs: Set<string> = new Set();
  private reorgDepth = 12; // Ethereum confirmations
  private solanaReorgDepth = 32; // Solana confirmations

  constructor(
    private database: Database,
    private queue: RedisQueue
  ) {
    this.logger = new Logger('EventListener');
    this.solanaConnection = new Connection(Config.SOLANA_RPC_URL, 'confirmed');
    this.ethereumProvider = new ethers.JsonRpcProvider(Config.ETHEREUM_RPC_URL);
  }

  async start() {
    this.logger.info('Starting event listeners');
    
    // Start Solana listener
    this.listenSolana();
    
    // Start Ethereum listener
    this.listenEthereum();
    
    // Start other EVM chains if configured
    if (Config.POLYGON_RPC_URL) {
      this.listenPolygon();
    }
  }

  async stop() {
    this.logger.info('Stopping event listeners');
    // Cleanup logic
  }

  private async listenSolana() {
    const programId = new PublicKey(Config.SOLANA_PROGRAM_ID);
    
    // Subscribe to program logs
    this.solanaConnection.onLogs(
      programId,
      async (logs, context) => {
        try {
          await this.processSolanaLogs(logs, context);
        } catch (error) {
          this.logger.error('Error processing Solana logs', error);
        }
      },
      'confirmed'
    );

    this.logger.info('Solana event listener started');
  }

  private async processSolanaLogs(logs: any, context: any) {
    const signature = logs.signature;
    
    // Check if already processed
    if (this.processedTxs.has(signature)) {
      return;
    }

    // Wait for confirmations
    await this.waitForSolanaConfirmations(signature);

    // Parse transaction
    const tx = await this.solanaConnection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });

    if (!tx) {
      this.logger.warn(`Transaction not found: ${signature}`);
      return;
    }

    // Extract events from logs
    const events = this.parseSolanaEvents(tx.meta?.logMessages || []);

    for (const event of events) {
      await this.handleEvent('solana', event);
    }

    this.processedTxs.add(signature);
  }

  private async waitForSolanaConfirmations(signature: string) {
    let confirmations = 0;
    
    while (confirmations < this.solanaReorgDepth) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const status = await this.solanaConnection.getSignatureStatus(signature);
      confirmations = status.value?.confirmations || 0;
    }
  }

  private parseSolanaEvents(logs: string[]): any[] {
    const events = [];
    
    for (const log of logs) {
      if (log.includes('StorageRequested')) {
        events.push(this.parseSolanaStorageRequested(log));
      } else if (log.includes('RetrievalRequested')) {
        events.push(this.parseSolanaRetrievalRequested(log));
      }
    }
    
    return events;
  }

  private parseSolanaStorageRequested(log: string): any {
    // Parse log message to extract event data
    // This is simplified - actual implementation would use proper parsing
    return {
      type: 'StorageRequested',
      requestId: 'parsed-request-id',
      user: 'parsed-user',
      dataHash: 'parsed-data-hash',
      paymentAmount: 'parsed-amount',
    };
  }

  private parseSolanaRetrievalRequested(log: string): any {
    return {
      type: 'RetrievalRequested',
      storageRequestId: 'parsed-storage-id',
      accessor: 'parsed-accessor',
      accessToken: 'parsed-token',
    };
  }

  private async listenEthereum() {
    const contract = new ethers.Contract(
      Config.ETHEREUM_CONTRACT_ADDRESS,
      [
        'event StorageRequested(bytes32 indexed requestId, address indexed user, bytes32 dataHash, uint256 paymentAmount, uint256 timestamp)',
        'event RetrievalRequested(bytes32 indexed storageRequestId, address indexed accessor, bytes32 accessTokenHash, uint256 timestamp)',
      ],
      this.ethereumProvider
    );

    // Storage events
    contract.on('StorageRequested', async (requestId, user, dataHash, paymentAmount, timestamp, event) => {
      try {
        await this.waitForEthereumConfirmations(event.blockNumber);
        
        await this.handleEvent('ethereum', {
          type: 'StorageRequested',
          requestId,
          user,
          dataHash,
          paymentAmount: paymentAmount.toString(),
          timestamp: timestamp.toString(),
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
        });
      } catch (error) {
        this.logger.error('Error processing Ethereum StorageRequested event', error);
      }
    });

    // Retrieval events
    contract.on('RetrievalRequested', async (storageRequestId, accessor, accessTokenHash, timestamp, event) => {
      try {
        await this.waitForEthereumConfirmations(event.blockNumber);
        
        await this.handleEvent('ethereum', {
          type: 'RetrievalRequested',
          storageRequestId,
          accessor,
          accessTokenHash,
          timestamp: timestamp.toString(),
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
        });
      } catch (error) {
        this.logger.error('Error processing Ethereum RetrievalRequested event', error);
      }
    });

    this.logger.info('Ethereum event listener started');
  }

  private async waitForEthereumConfirmations(blockNumber: number) {
    const targetBlock = blockNumber + this.reorgDepth;
    
    while (true) {
      const currentBlock = await this.ethereumProvider.getBlockNumber();
      if (currentBlock >= targetBlock) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }

  private async listenPolygon() {
    // Similar to Ethereum listener but for Polygon
    this.logger.info('Polygon event listener started');
  }

  private async handleEvent(chain: string, event: any) {
    const eventId = `${chain}-${event.transactionHash || event.requestId}`;
    
    // Check for duplicates
    const exists = await this.database.eventExists(eventId);
    if (exists) {
      this.logger.debug(`Event already processed: ${eventId}`);
      return;
    }

    this.logger.info(`New event: ${event.type} from ${chain}`);

    // Store event in database
    await this.database.saveEvent({
      id: eventId,
      chain,
      type: event.type,
      data: event,
      processedAt: new Date(),
    });

    // Queue for processing
    if (event.type === 'StorageRequested') {
      await this.queue.add('storage-request', {
        ...event,
        originChain: chain,
      });
    } else if (event.type === 'RetrievalRequested') {
      await this.queue.add('retrieval-request', {
        ...event,
        originChain: chain,
      });
    }

    // Queue fraud check
    await this.queue.add('fraud-check', {
      eventId,
      chain,
      event,
    });
  }
}