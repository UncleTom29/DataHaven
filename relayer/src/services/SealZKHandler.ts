// src/services/SealZKHandler.ts
import { SealClient, SessionKey} from '@mysten/seal';
import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Logger } from '../utils/Logger';
import { Config } from '../config';
import * as crypto from 'crypto';

interface StorageProofInputs {
  dataHash: Uint8Array;
  blobId: string;
  timestamp: number;
  encryptedData: Uint8Array;
}

interface AccessProofInputs {
  storageRequestId: string;
  accessor: string;
  accessToken: Uint8Array;
}

interface IntegrityProofInputs {
  originalHash: Uint8Array;
  retrievedData: Uint8Array;
}

export class SealZKHandler {
  private logger: Logger;
  private sealClient: SealClient;
  private suiClient: SuiClient;
  private signer: Ed25519Keypair;

  constructor() {
    this.logger = new Logger('SealZKHandler');
    this.suiClient = new SuiClient({ url: getFullnodeUrl('testnet') });
    this.signer = Ed25519Keypair.fromSecretKey(Buffer.from(Config.SUI_PRIVATE_KEY, 'hex'));

    const serverObjectIds = [
      "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75",
      "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8"
    ];

    this.sealClient = new SealClient({
      suiClient: this.suiClient,
      serverConfigs: serverObjectIds.map((id) => ({
        objectId: id,
        weight: 1,
      })),
      verifyKeyServers: false,
    });
  }

  async initialize() {
    this.logger.info('SealZKHandler initialized');
  }

  /**
   * Generate storage attestation proof using encryption
   * @param inputs - Storage inputs
   * @returns Proof bytes (encrypted object)
   */
  async generateStorageProof(inputs: StorageProofInputs): Promise<{ proofBytes: Uint8Array }> {
    this.logger.info('Generating storage proof');

    try {
      const { encryptedObject, key: backupKey } = await this.sealClient.encrypt({
        threshold: 2, // Example threshold
        packageId: Config.SEAL_CONTRACT_ID,
        id: inputs.blobId,
        data: inputs.encryptedData,
      });

      // Log backup key securely if needed
      this.logger.debug(`Backup key generated (do not log in prod): ${backupKey}`);

      return { proofBytes: encryptedObject };
    } catch (error) {
      this.logger.error('Storage proof failed', error);
      throw error;
    }
  }

  /**
   * Generate access proof using session key
   * @param inputs - Access inputs
   * @returns Proof bytes
   */
  async generateAccessProof(inputs: AccessProofInputs): Promise<{ proofBytes: Uint8Array }> {
    this.logger.info('Generating access proof');

    try {
      // Create session key
      const sessionKey = await SessionKey.create({
        address: inputs.accessor,
        packageId: Config.SEAL_CONTRACT_ID,
        ttlMin: 10,
        suiClient: this.suiClient,
      });

      const message = sessionKey.getPersonalMessage();
      const { signature } = await this.signer.signPersonalMessage(message);
      sessionKey.setPersonalMessageSignature(signature);

      // Create approve tx
      const tx = new Transaction();
      tx.moveCall({
        target: `${Config.SEAL_CONTRACT_ID}::seal::seal_approve`,
        arguments: [
          tx.pure.vector("u8", Buffer.from(inputs.storageRequestId, 'hex')),
    
        ],
      });

      const txBytes = await tx.build({ client: this.suiClient, onlyTransactionKind: true });

      // Fetch keys (proof)
      const derivedKeys = (await this.sealClient.fetchKeys({
        ids: [inputs.storageRequestId],
        txBytes,
        sessionKey,
        threshold: 2,
      })) as Record<string, string> | undefined;

      // Serialize as proof
      const proofParts: number[] = Object.values(derivedKeys ?? {}).flatMap(k => Array.from(Buffer.from(k, 'hex')));
      const proofBytes = new Uint8Array(proofParts);

      return { proofBytes };
    } catch (error) {
      this.logger.error('Access proof failed', error);
      throw error;
    }
  }

  /**
   * Generate integrity proof (hash verification)
   * @param inputs - Integrity inputs
   * @returns Proof bytes (hashed verification)
   */
  async generateIntegrityProof(inputs: IntegrityProofInputs): Promise<{ proofBytes: Uint8Array }> {
    this.logger.info('Generating integrity proof');

    try {
      const retrievedHash = crypto.createHash('sha256').update(inputs.retrievedData).digest();
      if (!retrievedHash.equals(inputs.originalHash)) {
        throw new Error('Integrity check failed: hash mismatch');
      }

      // Simple proof: concatenated hashes
      const proofBytes = new Uint8Array([...inputs.originalHash, ...retrievedHash]);

      return { proofBytes };
    } catch (error) {
      this.logger.error('Integrity proof failed', error);
      throw error;
    }
  }

  // Additional: Decrypt for retrieval
  async decryptData(encryptedBytes: Uint8Array, sessionKey: SessionKey, txBytes: Uint8Array): Promise<Uint8Array> {
    return await this.sealClient.decrypt({
      data: encryptedBytes,
      sessionKey,
      txBytes,
    });
  }

  // Production: Retry wrapper
  private async withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
    let attempts = 0;
    while (attempts < maxRetries) {
      try {
        return await fn();
      } catch (error) {
        attempts++;
        this.logger.warn(`Retry ${attempts}: ${error}`);
        if (attempts === maxRetries) throw error;
        await new Promise(resolve => setTimeout(resolve, 2000 * attempts));
      }
    }
    throw new Error('Retries exceeded');
  }
}