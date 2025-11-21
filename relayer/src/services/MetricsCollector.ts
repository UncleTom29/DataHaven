// File: src/services/MetricsCollector.ts

import { Registry, Counter, Gauge, Histogram } from 'prom-client';
import { Logger } from '../utils/Logger';

export class MetricsCollector {
  private logger: Logger;
  private registry: Registry;

  private storageRequestsProcessed: Counter;
  private storageRequestsFailed: Counter;
  private retrievalRequestsProcessed: Counter;
  private retrievalRequestsFailed: Counter;
  private fraudDetected: Counter;
  
  private processingTime: Histogram;
  private queueSize: Gauge;
  private activeConnections: Gauge;

  constructor() {
    this.logger = new Logger('MetricsCollector');
    this.registry = new Registry();

    // Initialize counters
    this.storageRequestsProcessed = new Counter({
      name: 'datahaven_storage_requests_processed_total',
      help: 'Total number of storage requests processed',
      registers: [this.registry],
    });

    this.storageRequestsFailed = new Counter({
      name: 'datahaven_storage_requests_failed_total',
      help: 'Total number of storage requests that failed',
      registers: [this.registry],
    });

    this.retrievalRequestsProcessed = new Counter({
      name: 'datahaven_retrieval_requests_processed_total',
      help: 'Total number of retrieval requests processed',
      registers: [this.registry],
    });

    this.retrievalRequestsFailed = new Counter({
      name: 'datahaven_retrieval_requests_failed_total',
      help: 'Total number of retrieval requests that failed',
      registers: [this.registry],
    });

    this.fraudDetected = new Counter({
      name: 'datahaven_fraud_detected_total',
      help: 'Total number of fraudulent requests detected',
      registers: [this.registry],
    });

    // Initialize histograms
    this.processingTime = new Histogram({
      name: 'datahaven_processing_time_seconds',
      help: 'Request processing time in seconds',
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
      registers: [this.registry],
    });

    // Initialize gauges
    this.queueSize = new Gauge({
      name: 'datahaven_queue_size',
      help: 'Current size of processing queues',
      labelNames: ['queue_name'],
      registers: [this.registry],
    });

    this.activeConnections = new Gauge({
      name: 'datahaven_active_connections',
      help: 'Number of active blockchain connections',
      labelNames: ['chain'],
      registers: [this.registry],
    });
  }

  increment(metric: string, labels?: any) {
    switch (metric) {
      case 'storage_requests_processed':
        this.storageRequestsProcessed.inc();
        break;
      case 'storage_requests_failed':
        this.storageRequestsFailed.inc();
        break;
      case 'retrieval_requests_processed':
        this.retrievalRequestsProcessed.inc();
        break;
      case 'retrieval_requests_failed':
        this.retrievalRequestsFailed.inc();
        break;
      case 'fraud_detected':
        this.fraudDetected.inc();
        break;
      default:
        this.logger.warn(`Unknown metric: ${metric}`);
    }
  }

  recordProcessingTime(duration: number) {
    this.processingTime.observe(duration);
  }

  setQueueSize(queueName: string, size: number) {
    this.queueSize.set({ queue_name: queueName }, size);
  }

  setActiveConnections(chain: string, count: number) {
    this.activeConnections.set({ chain }, count);
  }

  async getAll() {
    return await this.registry.metrics();
  }

  getRegistry() {
    return this.registry;
  }
}