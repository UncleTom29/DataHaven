// File: src/services/RedisQueue.ts

import Bull, { Queue, Job } from 'bull';
import { Logger } from '../utils/Logger';
import { Config } from '../config';

export class RedisQueue {
  private logger: Logger;
  private queues: Map<string, Queue> = new Map();

  constructor() {
    this.logger = new Logger('RedisQueue');
  }

  async connect() {
    this.logger.info('Connecting to Redis');
    
    // Create queues
    this.createQueue('storage-request');
    this.createQueue('retrieval-request');
    this.createQueue('fraud-check');
    
    this.logger.info('Redis queues initialized');
  }

  private createQueue(name: string) {
    const queue = new Bull(name, {
      redis: {
        host: Config.REDIS_HOST,
        port: Config.REDIS_PORT,
        password: Config.REDIS_PASSWORD,
      },
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: 100,
        removeOnFail: 1000,
      },
    });

    this.queues.set(name, queue);
    
    queue.on('error', (error) => {
      this.logger.error(`Queue ${name} error`, error);
    });

    queue.on('failed', (job, error) => {
      this.logger.error(`Job ${job.id} in queue ${name} failed`, error);
    });

    queue.on('completed', (job) => {
      this.logger.info(`Job ${job.id} in queue ${name} completed`);
    });
  }

  async add(queueName: string, data: any, options?: any) {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }

    return await queue.add(data, options);
  }

  process(queueName: string, handler: (job: Job) => Promise<any>) {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }

    queue.process(async (job: Job) => {
      this.logger.info(`Processing job ${job.id} in queue ${queueName}`);
      return await handler(job);
    });
  }

  async close() {
    this.logger.info('Closing Redis queues');
    
    for (const [name, queue] of this.queues) {
      await queue.close();
      this.logger.info(`Queue ${name} closed`);
    }
  }

  async getJobCounts(queueName: string) {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }

    return await queue.getJobCounts();
  }

  async getQueue(queueName: string): Promise<Bull.Queue<any> | undefined> {
    return this.queues.get(queueName);
  }
}
