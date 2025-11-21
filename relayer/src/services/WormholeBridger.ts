// src/services/WormholeBridger.ts
import { Wormhole, routes, TransferState, Signer, ChainAddress, Chain, wormhole } from '@wormhole-foundation/sdk';
import evm from '@wormhole-foundation/sdk/evm';
import solana from '@wormhole-foundation/sdk/solana';
import sui from '@wormhole-foundation/sdk/sui';
import { getEvmSignerForKey } from '@wormhole-foundation/sdk-evm';
import { getSolanaSigner } from '@wormhole-foundation/sdk-solana';
import { getSuiSigner } from '@wormhole-foundation/sdk-sui';
import { MayanRoute } from '@mayanfinance/wormhole-sdk-route';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { ethers } from 'ethers';
import { Logger } from '../utils/Logger';
import { Config } from '../config';

export class WormholeBridger {
  private logger: Logger;
  private wh: Wormhole<'Mainnet'> | null = null;


  constructor() {
    this.logger = new Logger('WormholeBridger');
    this.initWormhole();
  }

  private async initWormhole() {
    try {
      this.wh = await wormhole('Mainnet', [evm, solana, sui]);
      this.logger.info('Wormhole initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize Wormhole', error);
      throw error;
    }
  }

  /**
   * Withdraw payment from origin contract
   */
  async withdrawPayment(chain: string, _requestId: string, paymentAmount: string): Promise<void> {
    if (chain === 'sui') {
      this.logger.info('Skipping withdraw for Sui chain');
      return;
    }

    try {
      const provider = new ethers.JsonRpcProvider(Config.ETHEREUM_RPC_URL!);
      const wallet = new ethers.Wallet(Config.RELAYER_ETHEREUM_PRIVATE_KEY!, provider);

      const contractAddress = Config.ETHEREUM_CONTRACT_ADDRESS!;
      const abi = ['function withdraw(uint256 _amount) external'];
      const contract = new ethers.Contract(contractAddress, abi, wallet);

      const tx = await contract.withdraw(ethers.parseEther(paymentAmount));
      await tx.wait();
      
      this.logger.info(`Withdrew ${paymentAmount} from ${chain}`);
    } catch (error) {
      this.logger.error(`Failed to withdraw from ${chain}`, error);
      throw error;
    }
  }

  /**
   * Bridge tokens from origin chain to Sui using Mayan Route
   */
  async bridgeToSui(originChain: string, paymentAmount: string): Promise<void> {
    if (originChain === 'sui') {
      this.logger.info('Already on Sui, skipping bridge');
      return;
    }

    if (!this.wh) {
      throw new Error('Wormhole not initialized');
    }

    try {
      this.logger.info(`Initiating Mayan bridge from ${originChain} to Sui for amount ${paymentAmount}`);

      // Map network names to Wormhole chains
      const sourceChainName = this.mapToWormholeChain(originChain);
      const destChainName = 'Sui' as Chain;

      // Get chain contexts
      const sendChain = this.wh.getChain(sourceChainName);
      const destChain = this.wh.getChain(destChainName);

      // Define tokens (native tokens)
      const sourceToken = Wormhole.tokenId(sendChain.chain, 'native');
      const destinationToken = Wormhole.tokenId(destChain.chain, 'native');

      // Create transfer request
      const transferRequest = await routes.RouteTransferRequest.create(this.wh, {
        source: sourceToken,
        destination: destinationToken,
      });

      this.logger.info('Transfer request created');

      // Initialize Mayan route
      const mayanRoute = new MayanRoute(this.wh as unknown as any);
      this.logger.info('Mayan route initialized');

      // Get signers
      const senderSigner = await this.getSigner(sendChain, originChain);
      const receiverAddress = Wormhole.chainAddress(destChainName, Config.SUI_RECIPIENT_ADDRESS!);

      // Prepare transfer parameters
      const transferParams = {
        amount: paymentAmount,
        options: mayanRoute.getDefaultOptions(),
      };

      this.logger.info('Validating transfer parameters...');

      // Validate transfer (cast transferRequest to any to avoid cross-package type mismatch)
      const validated = await mayanRoute.validate(transferRequest as unknown as any, transferParams);
      if (!validated.valid) {
        throw new Error(`Validation failed: ${validated.error?.message || 'Unknown error'}`);
      }

      this.logger.info('Transfer validated successfully');

      // Get quote (cast transferRequest to any for the same reason)
      const quote = await mayanRoute.quote(transferRequest as unknown as any, validated.params as any);
      if (!quote.success) {
        throw new Error(`Failed to get quote: ${quote.error.message}`);
      }

      this.logger.info(`Quote received - Estimated output: ${quote.params?.amount || 'Calculating...'}`);

      // Initiate the transfer (cast transferRequest to any)
      this.logger.info('Initiating transfer via Mayan...');
      const receipt = await mayanRoute.initiate(
        transferRequest as unknown as any,
        senderSigner,
        quote,
        receiverAddress as any
      );

      const txId = receipt.originTxs?.[0]?.txid || 'Unknown';
      this.logger.info(`Transfer initiated! Transaction ID: ${txId}`);

      // Track the transfer
      this.logger.info('Tracking transfer progress...');
      
      let lastState: TransferState | undefined;
      
      for await (const trackingReceipt of mayanRoute.track(receipt as any)) {
        const state = trackingReceipt.state;
        
        // Only log if state changed
        if (state !== lastState) {
          lastState = state;
          const stateMessage = this.getTransferStateMessage(state);
          this.logger.info(stateMessage);
        }
        
        // Break if completed or failed
        if (state === TransferState.DestinationFinalized) {
          this.logger.info('✅ Bridge completed successfully!');
          break;
        } else if (state === TransferState.Failed) {
          throw new Error('Bridge transaction failed');
        }
      }

      // Generate scan URL
      const scanUrl = receipt.originTxs?.[0]?.txid 
        ? `https://wormholescan.io/#/tx/${receipt.originTxs[0].txid}`
        : 'N/A';

      this.logger.info(`View on Wormhole Scan: ${scanUrl}`);

    } catch (error) {
      this.logger.error('Mayan bridge to Sui failed', error);
      throw error;
    }
  }

  /**
   * Map network names to Wormhole chain names (only Ethereum, Solana, Sui)
   */
  private mapToWormholeChain(network: string): Chain {
    const chainMap: Record<string, Chain> = {
      'ethereum': 'Ethereum',
      'solana': 'Solana',
      'sui': 'Sui'
    };
    
    const normalized = network.toLowerCase();
    const chain = chainMap[normalized];
    
    if (!chain) {
      throw new Error(`Unsupported network: ${network}. Only Ethereum, Solana, and Sui are supported.`);
    }
    
    return chain;
  }

  /**
   * Get signer for a specific chain (Ethereum, Solana, or Sui)
   */
  private async getSigner(chain: any, networkName: string): Promise<Signer> {
    const chainName = chain.chain as string;

    if (chainName === 'Ethereum') {
      // Ethereum chain
      const rpcUrl = await chain.getRpc();
      const privateKey = Config.RELAYER_ETHEREUM_PRIVATE_KEY!;
      return await getEvmSignerForKey(rpcUrl, privateKey);
      
    } else if (chainName === 'Solana') {
      // Solana chain
      const privateKey = Config.RELAYER_SOLANA_PRIVATE_KEY!;
      
      // Convert hex private key to bytes
      let secretKeyBytes: Buffer;
      try {
        secretKeyBytes = Buffer.from(privateKey, 'hex');
      } catch (error) {
        this.logger.error('Failed to decode Solana private key from hex', error);
        throw new Error('Invalid Solana private key format');
      }

      // Validate key length (should be 64 bytes for full secret key)
      if (secretKeyBytes.length !== 64) {
        throw new Error(`Invalid Solana secret key length: ${secretKeyBytes.length} bytes (expected 64)`);
      }

      // Validate keypair matches expected address
      try {
        const tempKeypair = Keypair.fromSecretKey(secretKeyBytes);
        this.logger.info(`Solana public key: ${tempKeypair.publicKey.toBase58()}`);
      } catch (keyError) {
        this.logger.error('Solana keypair validation failed', keyError);
        throw new Error('Invalid Solana private key');
      }

      // Encode as base58 for Wormhole SDK
      const base58PrivateKey = bs58.encode(secretKeyBytes);
      
      const rpcUrl = await chain.getRpc();
      return await getSolanaSigner(rpcUrl, base58PrivateKey);
      
    } else if (chainName === 'Sui') {
      // Sui chain
      const privateKey = Config.SUI_PRIVATE_KEY!;
      const rpcUrl = await chain.getRpc();
      return await getSuiSigner(rpcUrl, privateKey);
      
    } else {
      throw new Error(`Unsupported chain: ${chainName}. Only Ethereum, Solana, and Sui are supported.`);
    }
  }

  /**
   * Get transfer state message (for logging)
   */
  private getTransferStateMessage(state: TransferState): string {
    const messages: Record<number, string> = {
      [TransferState.Created]: '🔵 Transfer created',
      [TransferState.SourceInitiated]: '🟡 Source transaction initiated',
      [TransferState.SourceFinalized]: '🟢 Source transaction confirmed',
      [TransferState.Attested]: '📝 Transfer verified by guardians',
      [TransferState.DestinationInitiated]: '🟡 Processing on destination chain',
      [TransferState.DestinationFinalized]: '✅ Transfer complete!',
      [TransferState.Failed]: '❌ Transfer failed',
      [TransferState.Refunded]: '🔄 Transfer refunded',
    };
    return messages[state] || `📊 Status: ${state}`;
  }
}