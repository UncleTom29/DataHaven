// File: src/services/FraudDetector.ts

import { Database } from './Database';
import { Logger } from '../utils/Logger';

interface FraudCheckResult {
  isFraudulent: boolean;
  reason?: string;
  score: number;
}

export class FraudDetector {
  private logger: Logger;
  private anomalyThreshold = 0.8;

  constructor(private database: Database) {
    this.logger = new Logger('FraudDetector');
    this.logger.info('FraudDetector initialized with rule-based detection');
  }

  async checkStorageRequest(data: any): Promise<FraudCheckResult> {
    this.logger.info(`Running fraud check for request: ${data.requestId}`);

    // Rule-based checks
    const ruleChecks = await this.runRuleBasedChecks(data);
    if (ruleChecks.isFraudulent) {
      return ruleChecks;
    }

    // Behavioral analysis
    const behaviorCheck = await this.analyzeBehavior(data);
    if (behaviorCheck.isFraudulent) {
      return behaviorCheck;
    }

    return { isFraudulent: false, score: 0 };
  }

  private async runRuleBasedChecks(data: any): Promise<FraudCheckResult> {
    // Check 1: Replay attack detection
    const existingRequest = await this.database.findStorageRequest({
      user: data.user,
      dataHash: data.dataHash,
      createdAt: { $gte: Date.now() - 3600000 }, // Last hour
    });

    if (existingRequest) {
      return {
        isFraudulent: true,
        reason: 'Duplicate request detected within 1 hour',
        score: 1.0,
      };
    }

    // Check 2: Suspicious payment amount
    if (parseFloat(data.paymentAmount || data.payment) > 1000000000) {
      return {
        isFraudulent: true,
        reason: 'Abnormally high payment amount',
        score: 0.95,
      };
    }

    // Check 3: Rate limiting
    const recentRequests = await this.database.countStorageRequests({
      user: data.user,
      createdAt: { $gte: Date.now() - 60000 }, // Last minute
    });

    if (recentRequests > 10) {
      return {
        isFraudulent: true,
        reason: 'Rate limit exceeded (>10 requests/min)',
        score: 0.9,
      };
    }

    // Check 4: Metadata size anomaly
    if (data.metadataEncrypted && Buffer.byteLength(data.metadataEncrypted) < 10) {
      return {
        isFraudulent: true,
        reason: 'Suspiciously small metadata size',
        score: 0.7,
      };
    }

    // Check 5: Known malicious addresses
    const isBlacklisted = await this.database.isBlacklistedAddress(data.user);
    if (isBlacklisted) {
      return {
        isFraudulent: true,
        reason: 'Address is blacklisted',
        score: 1.0,
      };
    }

    return { isFraudulent: false, score: 0 };
  }

  private async analyzeBehavior(data: any): Promise<FraudCheckResult> {
    // Get user's historical behavior
    const history = await this.database.getStorageRequestHistory(data.user, 30);

    if (history.length === 0) {
      // New user - no history to analyze
      return { isFraudulent: false, score: 0 };
    }

    // Calculate statistical metrics
    const amounts = history.map(h => parseFloat(h.paymentAmount || h.payment || '0'));
    const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const variance = amounts.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / amounts.length;
    const stdDev = Math.sqrt(variance);

    // Check if current payment is outlier (>3 standard deviations)
    const currentAmount = parseFloat(data.paymentAmount || data.payment);
    const zScore = stdDev > 0 ? Math.abs((currentAmount - mean) / stdDev) : 0;

    if (zScore > 3) {
      return {
        isFraudulent: true,
        reason: 'Payment amount is statistical outlier for this user',
        score: 0.85,
      };
    }

    // Check timing patterns
    const timestamps = history.map(h => new Date(h.createdAt).getTime());
    const intervals = [];
    for (let i = 1; i < timestamps.length; i++) {
      intervals.push(timestamps[i] - timestamps[i - 1]);
    }

    if (intervals.length > 0) {
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const lastInterval = Date.now() - timestamps[timestamps.length - 1];

      // Suspiciously rapid succession
      if (lastInterval < avgInterval / 10 && avgInterval > 0) {
        return {
          isFraudulent: true,
          reason: 'Abnormally rapid request succession',
          score: 0.75,
        };
      }
    }

    return { isFraudulent: false, score: 0 };
  }

  async analyze(data: any): Promise<FraudCheckResult> {
    return this.checkStorageRequest(data);
  }

  private hashToNumber(hash: string): number {
    const hex = hash.startsWith('0x') ? hash.slice(2) : hash;
    return parseInt(hex.slice(0, 8), 16);
  }
}