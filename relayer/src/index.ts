import express, { Application } from 'express';
import { EventListener } from './services/EventListener';
import { SealZKHandler } from './services/SealZKHandler';
import { WormholeBridger } from './services/WormholeBridger';
import { FraudDetector } from './services/FraudDetector';
import { ReceiptGenerator } from './services/ReceiptGenerator';
import { Database } from './services/Database';
import { RedisQueue } from './services/RedisQueue';
import { MetricsCollector } from './services/MetricsCollector';
import { Logger } from './utils/Logger';
import { Config } from './config';
import { WalrusSDKClient } from './services/WalrusSDKClient';
import { SuiSDKClient } from './services/SuiClient';
import { Connection, Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY } from '@solana/web3.js';
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor';
import { ethers } from 'ethers';
import type { Idl } from '@coral-xyz/anchor';
import { Transaction } from '@mysten/sui/transactions';

class RelayerService {
  private app: Application;
  private eventListener: EventListener;
  private zkHandler: SealZKHandler;
  private wormholeBridger: WormholeBridger;
  private fraudDetector: FraudDetector;
  private receiptGenerator: ReceiptGenerator;
  private database: Database;
  private queue: RedisQueue;
  private metrics: MetricsCollector;
  private logger: Logger;
  private walrusClient: WalrusSDKClient;
  private suiClient: SuiSDKClient;
  private solanaKeypair: Keypair;

  constructor() {
    this.app = express();
    this.logger = new Logger('RelayerService');
    this.database = new Database();
    this.queue = new RedisQueue();
    this.metrics = new MetricsCollector();
    this.walrusClient = new WalrusSDKClient();
    this.suiClient = new SuiSDKClient();
    this.solanaKeypair = Keypair.fromSecretKey(Uint8Array.from(Buffer.from(Config.RELAYER_SOLANA_PRIVATE_KEY, 'hex')));
    
    this.eventListener = new EventListener(this.database, this.queue);
    this.zkHandler = new SealZKHandler();
    this.wormholeBridger = new WormholeBridger();
    this.fraudDetector = new FraudDetector(this.database);
    this.receiptGenerator = new ReceiptGenerator();
  }

  async start() {
    try {
      await this.database.connect();
      await this.queue.connect();
      await this.zkHandler.initialize();
      
      await this.eventListener.start();
      
      this.startJobProcessors();
      
      this.setupRoutes();
      const port = Config.PORT || 3000;
      this.app.listen(port, () => {
        this.logger.info(`Relayer service started on port ${port}`);
      });

      this.setupGracefulShutdown();
      
    } catch (error) {
      this.logger.error('Failed to start relayer service', error);
      process.exit(1);
    }
  }

  private startJobProcessors() {
    this.queue.process('storage-request', async (job) => {
      return await this.processStorageRequest(job.data);
    });

    this.queue.process('retrieval-request', async (job) => {
      return await this.processRetrievalRequest(job.data);
    });

    this.queue.process('fraud-check', async (job) => {
      return await this.fraudDetector.analyze(job.data);
    });
  }

  private async processStorageRequest(data: any) {
    const startTime = Date.now();
    const { requestId, originChain, user, dataHash, payment } = data;
    
    this.logger.info(`Processing storage request: ${requestId}`);
    
    try {
      // Fraud detection
      const fraudCheck = await this.fraudDetector.checkStorageRequest(data);
      if (fraudCheck.isFraudulent) {
        this.logger.warn(`Fraud detected for request ${requestId}: ${fraudCheck.reason}`);
        this.metrics.increment('fraud_detected');
        await this.markFailedOnOrigin(originChain, requestId);
        return { success: false, reason: fraudCheck.reason };
      }

      // Get uploaded encrypted data
      const fullRequest = await this.database.getStorageRequest(requestId) as any;
      if (!fullRequest?.encryptedDataBase64) {
        throw new Error('Encrypted data not uploaded');
      }
      const encryptedData = Buffer.from(fullRequest.encryptedDataBase64, 'base64');

      // Store on Walrus
      const storeResult = await this.walrusClient.store(encryptedData);

      // Generate ZK storage proof
      const storageProof = await this.zkHandler.generateStorageProof({
        dataHash: Buffer.from(dataHash.replace('0x', ''), 'hex'),
        blobId: storeResult.blobId,
        timestamp: Date.now(),
        encryptedData,
      });

      // Execute on Sui coordinator
      const suiTxHash = await this.suiClient.processStorageRequest({
        requestId,
        originChain,
        user,
        dataHash,
        walrusBlobId: storeResult.blobId,
        zkProof: storageProof.proofBytes,
        accessPolicyHash: '',
      });

      // Generate receipt
      const receipt = await this.receiptGenerator.createReceipt({
        requestId,
        walrusBlobId: storeResult.blobId,
        suiTxHash,
        dataHash,
        zkProof: Buffer.from(storageProof.proofBytes),
      });

      // Submit receipt to origin chain
      await this.submitReceiptToOrigin(originChain, requestId, receipt);

      // Bridge payment if not Sui
      if (originChain !== 'sui') {
        await this.wormholeBridger.withdrawPayment(originChain, requestId, payment);
        await this.wormholeBridger.bridgeToSui(originChain, payment);
      }

      // Update DB
      await this.database.updateStorageRequest(requestId, {
        status: 'confirmed',
        walrusBlobId: storeResult.blobId,
        suiTxHash,
        zkProofHash: this.hashData(Buffer.from(storageProof.proofBytes)),
        completedAt: new Date(),
      });

      this.metrics.increment('storage_requests_processed');
      const duration = (Date.now() - startTime) / 1000;
      this.metrics.recordProcessingTime(duration);
      this.logger.info(`Storage request completed: ${requestId}`);

      return { success: true, receipt };

    } catch (error) {
      this.logger.error(`Storage request failed: ${requestId}`, error);
      
      await this.database.updateStorageRequest(requestId, {
        status: 'failed',
        error: (error as Error).message,
        updatedAt: new Date(),
      });

      await this.markFailedOnOrigin(originChain, requestId);

      this.metrics.increment('storage_requests_failed');
      throw error;
    }
  }

  private async processRetrievalRequest(data: any) {
    const startTime = Date.now();
    const { retrievalId, storageRequestId, accessor, accessTokenHash, originChain } = data;
    
    this.logger.info(`Processing retrieval request: ${retrievalId}`);

    try {
      // Fraud check (similar)
      const fraudCheck = await this.fraudDetector.analyze(data);
      if (fraudCheck.isFraudulent) {
        throw new Error(fraudCheck.reason);
      }

      // Get storage request
      const storageRequest = await this.database.getStorageRequest(storageRequestId);
      if (!storageRequest) {
        throw new Error('Storage request not found');
      }

      // Generate ZK access proof
      const accessProof = await this.zkHandler.generateAccessProof({
        storageRequestId,
        accessor,
        accessToken: Buffer.from(accessTokenHash, 'hex'),
      });

      // Retrieve from Walrus
      const retrievedData = await this.walrusClient.retrieve(storageRequest.walrusBlobId);

      // Generate integrity proof
      const integrityProof = await this.zkHandler.generateIntegrityProof({
        originalHash: Buffer.from(storageRequest.dataHash, 'hex'),
        retrievedData,
      });

      // Update DB
      await this.database.updateRetrievalRequest(retrievalId, {
        status: 'completed',
        accessProofHash: this.hashData(Buffer.from(accessProof.proofBytes)),
        integrityProof: Buffer.from(integrityProof.proofBytes).toString('hex'),
        completedAt: new Date(),
      });

      this.metrics.increment('retrieval_requests_processed');
      const duration = (Date.now() - startTime) / 1000;
      this.metrics.recordProcessingTime(duration);
      this.logger.info(`Retrieval request completed: ${retrievalId}`);

      // Submit confirmation to origin (optional)
      await this.submitRetrievalConfirmation(originChain, retrievalId, integrityProof.proofBytes);

      return { success: true, data: retrievedData.toString(), proofs: { access: accessProof, integrity: integrityProof } };

    } catch (error) {
      this.logger.error(`Retrieval request failed: ${retrievalId}`, error);
      
      await this.database.updateRetrievalRequest(retrievalId, {
        status: 'failed',
        error: (error as Error).message,
        updatedAt: new Date(),
      });

      this.metrics.increment('retrieval_requests_failed');
      throw error;
    }
  }

  private async markFailedOnOrigin(chain: string, requestId: string) {
    this.logger.info(`Marking failed on ${chain}: ${requestId}`);
    try {
      if (chain === 'ethereum' || chain === 'polygon') {
        const providerUrl = chain === 'ethereum' ? Config.ETHEREUM_RPC_URL! : Config.POLYGON_RPC_URL!;
        const provider = new ethers.JsonRpcProvider(providerUrl);
        const wallet = new ethers.Wallet(Config.RELAYER_ETHEREUM_PRIVATE_KEY!, provider);
        const contractAddress = chain === 'ethereum' ? Config.ETHEREUM_CONTRACT_ADDRESS! : Config.POLYGON_CONTRACT_ADDRESS!;
        const abi = ['function markFailed(bytes32 _requestId) external'];
        const contract = new ethers.Contract(contractAddress, abi, wallet);
        const tx = await contract.markFailed(ethers.toUtf8Bytes(requestId));
        await tx.wait();
        this.logger.info(`Marked failed on ${chain}: ${tx.hash}`);
      } else if (chain === 'solana') {
        const connection = new Connection(Config.SOLANA_RPC_URL!, 'confirmed');
        const wallet = new Wallet(this.solanaKeypair);
        const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
        const programId = new PublicKey(Config.SOLANA_PROGRAM_ID!);
        const idl = { /* Paste the IDL JSON from the tool output here */ } as Idl;
        const program = new Program(idl, provider);
        
        // Derive accounts
        const state = PublicKey.findProgramAddressSync([Buffer.from('state')], programId)[0];
        const vault = PublicKey.findProgramAddressSync([Buffer.from('vault')], programId)[0];
        const requestKey = new PublicKey(requestId);
        const requestAccount = await (program.account as any)['request'].fetch(requestKey) as any;
        const userKey = requestAccount.user as PublicKey;
        
        await program.methods
          .markFailed()
          .accounts({
            state,
            request: requestKey,
            user: userKey,
            vault,
            relayer: this.solanaKeypair.publicKey,
          })
          .signers([this.solanaKeypair])
          .rpc();
        this.logger.info(`Marked failed on Solana`);
      } else if (chain === 'sui') {
        const tx = new Transaction();
        tx.moveCall({
          target: `${Config.SUI_COORDINATOR_PACKAGE_ID}::origin::mark_failed`,
          arguments: [
            tx.object(requestId),
          ],
        });
        const result = await (this.suiClient as any).client.signAndExecuteTransaction({
          transaction: tx,
          signer: (this.suiClient as any).keypair,
        });
        this.logger.info(`Marked failed on Sui: ${result.digest}`);
      }
    } catch (error) {
      this.logger.error(`Failed to mark failed on ${chain}`, error);
      throw error;
    }
  }

  private async submitReceiptToOrigin(chain: string, requestId: string, receipt: any) {
    this.logger.info(`Submitting receipt to ${chain}: ${requestId}`);
    try {
      const { walrusBlobId, suiTxHash, zkProof } = receipt;
      const proofHash = ethers.keccak256(zkProof);
      const blobIdHash = ethers.keccak256(ethers.toUtf8Bytes(walrusBlobId));
      const suiTxHashBytes = ethers.toUtf8Bytes(suiTxHash);
      const suiTxHashHash = ethers.keccak256(suiTxHashBytes);

      if (chain === 'ethereum' || chain === 'polygon') {
        const providerUrl = chain === 'ethereum' ? Config.ETHEREUM_RPC_URL! : Config.POLYGON_RPC_URL!;
        const provider = new ethers.JsonRpcProvider(providerUrl);
        const wallet = new ethers.Wallet(Config.RELAYER_ETHEREUM_PRIVATE_KEY!, provider);
        const contractAddress = chain === 'ethereum' ? Config.ETHEREUM_CONTRACT_ADDRESS! : Config.POLYGON_CONTRACT_ADDRESS!;
        const abi = [
          'function verifyReceipt(bytes32 _requestId, bytes32 _blobId, bytes32 _suiTxHash, bytes32 _proofHash, bytes memory _signature) external'
        ];
        const contract = new ethers.Contract(contractAddress, abi, wallet);
        
        const signature = receipt.signatures.evm;
        const tx = await contract.verifyReceipt(
          ethers.toUtf8Bytes(requestId),
          blobIdHash,
          suiTxHashHash,
          proofHash,
          signature
        );
        await tx.wait();
        this.logger.info(`Receipt submitted on ${chain}: ${tx.hash}`);
      } else if (chain === 'solana') {
        const connection = new Connection(Config.SOLANA_RPC_URL!, 'confirmed');
        const wallet = new Wallet(this.solanaKeypair);
        const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
        const programId = new PublicKey(Config.SOLANA_PROGRAM_ID!);
        const idl = { /* Paste the IDL JSON */ } as Idl;
        const program = new Program(idl, provider);
        
        const state = PublicKey.findProgramAddressSync([Buffer.from('state')], programId)[0];
        const requestKey = new PublicKey(requestId);
        
        const blobIdArr = Array.from(ethers.getBytes(blobIdHash));
        const suiTxArr = Array.from(ethers.getBytes(suiTxHashHash));
        const proofArr = Array.from(ethers.getBytes(proofHash));
        
        await program.methods
          .verifyReceipt(blobIdArr, suiTxArr, proofArr)
          .accounts({
            state,
            request: requestKey,
            relayer: this.solanaKeypair.publicKey,
            instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          })
          .signers([this.solanaKeypair])
          .rpc();
        this.logger.info(`Receipt submitted on Solana`);
      } else if (chain === 'sui') {
        const tx = new Transaction();
        tx.moveCall({
          target: `${Config.SUI_COORDINATOR_PACKAGE_ID}::origin::verify_receipt`,
          arguments: [
            tx.object(requestId),
            tx.pure.vector('u8', Array.from(ethers.getBytes(blobIdHash))),
            tx.pure.vector('u8', Array.from(ethers.getBytes(suiTxHashHash))),
            tx.pure.vector('u8', Array.from(ethers.getBytes(proofHash))),
            tx.pure.vector('u8', Array.from(Buffer.from(receipt.signatures.sui || receipt.signatures.evm, 'hex'))),
          ],
        });
        const result = await (this.suiClient as any).client.signAndExecuteTransaction({
          transaction: tx,
          signer: (this.suiClient as any).keypair,
        });
        this.logger.info(`Receipt submitted on Sui: ${result.digest}`);
      }
    } catch (error) {
      this.logger.error(`Failed to submit receipt on ${chain}`, error);
      throw error;
    }
  }

  private async submitRetrievalConfirmation(chain: string, retrievalId: string, integrityProof: Uint8Array) {
    this.logger.info(`Submitting retrieval confirmation to ${chain}: ${retrievalId}`);
    try {
      if (chain === 'ethereum' || chain === 'polygon') {
        const providerUrl = chain === 'ethereum' ? Config.ETHEREUM_RPC_URL! : Config.POLYGON_RPC_URL!;
        const provider = new ethers.JsonRpcProvider(providerUrl);
        const wallet = new ethers.Wallet(Config.RELAYER_ETHEREUM_PRIVATE_KEY!, provider);
        const contractAddress = chain === 'ethereum' ? Config.ETHEREUM_CONTRACT_ADDRESS! : Config.POLYGON_CONTRACT_ADDRESS!;
        const abi = ['function verifyRetrieval(bytes32 retrievalId, bytes integrityProof) external'];
        const contract = new ethers.Contract(contractAddress, abi, wallet);
        const tx = await contract.verifyRetrieval(ethers.toUtf8Bytes(retrievalId), integrityProof);
        await tx.wait();
        this.logger.info(`Retrieval confirmed on ${chain}: ${tx.hash}`);
      } else if (chain === 'solana') {
        const connection = new Connection(Config.SOLANA_RPC_URL!, 'confirmed');
        const wallet = new Wallet(this.solanaKeypair);
        const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
        const programId = new PublicKey(Config.SOLANA_PROGRAM_ID!);
        const idl = { /* Paste IDL */ } as Idl;
        const program = new Program(idl, provider);
        
        const state = PublicKey.findProgramAddressSync([Buffer.from('state')], programId)[0];
        const retrievalKey = new PublicKey(retrievalId);
        
        await program.methods
          .verifyRetrieval(Array.from(integrityProof))
          .accounts({
            state,
            retrieval: retrievalKey,
            relayer: this.solanaKeypair.publicKey,
          })
          .signers([this.solanaKeypair])
          .rpc();
        this.logger.info(`Retrieval confirmed on Solana`);
      } else if (chain === 'sui') {
        const tx = new Transaction();
        tx.moveCall({
          target: `${Config.SUI_COORDINATOR_PACKAGE_ID}::origin::verify_retrieval`,
          arguments: [
            tx.pure.string(retrievalId),
            tx.pure.vector('u8', Array.from(integrityProof)),
          ],
        });
        const result = await (this.suiClient as any).client.signAndExecuteTransaction({
          transaction: tx,
          signer: (this.suiClient as any).keypair,
        });
        this.logger.info(`Retrieval confirmed on Sui: ${result.digest}`);
      }
    } catch (error) {
      this.logger.error(`Failed to submit retrieval confirmation on ${chain}`, error);
      throw error;
    }
  }

  private setupRoutes() {
    this.app.use(express.json({ limit: '500mb' }));

    this.app.get('/health', (_req, res) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      });
    });

    this.app.get('/metrics', async (_req, res) => {
      const metrics = await this.metrics.getAll();
      res.json(metrics);
    });

    this.app.get('/storage/:requestId', async (req, res) => {
      try {
        const request = await this.database.getStorageRequest(req.params.requestId);
        if (!request) {
          return res.status(404).json({ error: 'Request not found' });
        }
        res.json(request);
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    });

    this.app.get('/retrieval/:retrievalId', async (req, res) => {
      try {
        const request = await this.database.getRetrievalRequest(req.params.retrievalId);
        if (!request) {
          return res.status(404).json({ error: 'Request not found' });
        }
        res.json(request);
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    });

    this.app.post('/upload', async (req, res) => {
      const { requestId, encryptedDataBase64} = req.body;
      if (!requestId || !encryptedDataBase64) {
        return res.status(400).json({ error: 'requestId and encryptedDataBase64 required' });
      }
      try {
        await this.database.uploadEncryptedData(requestId, encryptedDataBase64);
        res.json({ message: 'Upload successful' });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    });

    this.app.get('/estimate', (req, res) => {
      const { sizeBytes } = req.query;
      if (!sizeBytes || isNaN(Number(sizeBytes))) {
        return res.status(400).json({ error: 'sizeBytes required as number' });
      }
      const estimate = this.estimateFee(Number(sizeBytes));
      res.json(estimate);
    });

    this.app.post('/retry/:requestId', async (req, res) => {
      try {
        const request = await this.database.getStorageRequest(req.params.requestId);
        if (!request) {
          return res.status(404).json({ error: 'Request not found' });
        }
        
        await this.queue.add('storage-request', request);
        res.json({ message: 'Request queued for retry' });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    });
  }

  private estimateFee(dataSizeBytes: number): { walrusSui: number; gasSui: number; totalSui: number } {
    const walrusCostPerBytePerEpoch = 0.0000004;
    const epochs = 5;
    const walrusSui = (dataSizeBytes * walrusCostPerBytePerEpoch * epochs);
    const gasSui = 0.02;
    return {
      walrusSui,
      gasSui,
      totalSui: walrusSui + gasSui,
    };
  }

  private hashData(data: Buffer): string {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  private setupGracefulShutdown() {
    const shutdown = async (signal: string) => {
      this.logger.info(`Received ${signal}, shutting down gracefully`);
      
      try {
        await this.eventListener.stop();
        await this.queue.close();
        await this.database.disconnect();
        
        this.logger.info('Shutdown complete');
        process.exit(0);
      } catch (error) {
        this.logger.error('Error during shutdown', error);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }
}

const service = new RelayerService();
service.start().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});