// src/services/Database.ts
import { MongoClient, Db, Collection } from 'mongodb';
import { Logger } from '../utils/Logger';
import { Config } from '../config';

export class Database {
  private client: MongoClient;
  private db: Db | null = null;
  private logger: Logger;

  private storageRequests: Collection | null = null;
  private retrievalRequests: Collection | null = null;
  private events: Collection | null = null;
  private blacklist: Collection | null = null;

  constructor() {
    this.logger = new Logger('Database');
    this.client = new MongoClient(Config.MONGODB_URI);
  }

  async connect() {
    try {
      await this.client.connect();
      this.db = this.client.db(Config.MONGODB_DATABASE);
      
      this.storageRequests = this.db.collection('storage_requests');
      this.retrievalRequests = this.db.collection('retrieval_requests');
      this.events = this.db.collection('events');
      this.blacklist = this.db.collection('blacklist');

      await this.createIndexes();
      
      this.logger.info('Database connected');
    } catch (error) {
      this.logger.error('Connection failed', error);
      throw error;
    }
  }

  async disconnect() {
    await this.client.close();
    this.logger.info('Disconnected');
  }

  private async createIndexes() {
    await this.storageRequests!.createIndex({ requestId: 1 }, { unique: true });
    await this.storageRequests!.createIndex({ user: 1 });
    await this.storageRequests!.createIndex({ createdAt: -1 });
    await this.storageRequests!.createIndex({ status: 1 });
    
    await this.retrievalRequests!.createIndex({ retrievalId: 1 }, { unique: true });
    await this.retrievalRequests!.createIndex({ storageRequestId: 1 });
    await this.retrievalRequests!.createIndex({ accessor: 1 });
    
    await this.events!.createIndex({ id: 1 }, { unique: true });
    await this.events!.createIndex({ chain: 1, type: 1 });
    
    await this.blacklist!.createIndex({ address: 1 }, { unique: true });
    
    this.logger.info('Indexes created');
  }

  async saveStorageRequest(data: any) {
    return await this.storageRequests!.insertOne({
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async updateStorageRequest(requestId: string, updates: any) {
    return await this.storageRequests!.updateOne(
      { requestId },
      { $set: { ...updates, updatedAt: new Date() } }
    );
  }

  async getStorageRequest(requestId: string) {
    return await this.storageRequests!.findOne({ requestId });
  }

  async findStorageRequest(query: any) {
    return await this.storageRequests!.findOne(query);
  }

  async countStorageRequests(query: any) {
    return await this.storageRequests!.countDocuments(query);
  }

  async getStorageRequestHistory(user: string, days: number) {
    const cutoff = new Date(Date.now() - days * 24 * 3600000);
    return await this.storageRequests!.find({
      user,
      createdAt: { $gte: cutoff },
    }).toArray();
  }

  async uploadEncryptedData(requestId: string, encryptedDataBase64: string) {
    const updates: any = {
      encryptedDataBase64,
      status: 'uploaded',
      updatedAt: new Date(),
    };
    return await this.storageRequests!.updateOne(
      { requestId },
      { $set: updates }
    );
  }

  async saveRetrievalRequest(data: any) {
    return await this.retrievalRequests!.insertOne({
      ...data,
      createdAt: new Date(),
    });
  }

  async updateRetrievalRequest(retrievalId: string, updates: any) {
    return await this.retrievalRequests!.updateOne(
      { retrievalId },
      { $set: { ...updates, updatedAt: new Date() } }
    );
  }

  async getRetrievalRequest(retrievalId: string) {
    return await this.retrievalRequests!.findOne({ retrievalId });
  }

  async saveEvent(event: any) {
    return await this.events!.insertOne(event);
  }

  async eventExists(eventId: string) {
    const count = await this.events!.countDocuments({ id: eventId });
    return count > 0;
  }

  async isBlacklistedAddress(address: string) {
    const entry = await this.blacklist!.findOne({ address });
    return entry !== null;
  }

  async addToBlacklist(address: string, reason: string) {
    return await this.blacklist!.insertOne({
      address,
      reason,
      addedAt: new Date(),
    });
  }
}