import mongoose, { connect } from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import Worker from '../models/worker.Model.js';
import HomeOwner from '../models/homeOwner.Model.js';
import Notification from '../models/notification.Model.js';
import WorkerNotification from '../models/workerNotification.Model.js';
import AdminNotification from '../models/adminNotification.Model.js';

// Get current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load the backend environment file.
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Avoid infinite buffering of queries when network connection drops
mongoose.set('bufferTimeoutMS', 30000);

// Connection lifecycle event listeners
mongoose.connection.on('disconnected', () => {
  console.warn('[MongoDB] Connection disconnected. MongoDB driver is attempting reconnection...');
});

mongoose.connection.on('reconnected', () => {
  console.info('[MongoDB] Connection successfully re-established.');
});

mongoose.connection.on('error', (err) => {
  console.error('[MongoDB] Connection error:', err?.message || err);
});

const connectDB = async () => {
  try {
    const mongoUrl = process.env.MONGO_URL || process.env.MONGO_URI;
    if (!mongoUrl) {
      throw new Error('MONGO_URL (or MONGO_URI) is not defined in the backend .env file');
    }

    const useTls = String(process.env.MONGO_TLS || '').toLowerCase() === 'true';
    const allowInvalidCerts =
      String(process.env.MONGO_TLS_ALLOW_INVALID || '').toLowerCase() === 'true';
    const allowInvalidHostnames =
      String(process.env.MONGO_TLS_ALLOW_INVALID_HOSTNAMES || '').toLowerCase() === 'true';
    const serverSelectionTimeoutMs = process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS
      ? Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS)
      : 10000;

    const options = {
      maxPoolSize: 20,
      minPoolSize: 2,
      socketTimeoutMS: 75000,
      connectTimeoutMS: 15000,
      heartbeatFrequencyMS: 10000,
      maxIdleTimeMS: 30000,
      serverSelectionTimeoutMS: serverSelectionTimeoutMs,
    };

    if (useTls) options.tls = true;
    if (allowInvalidCerts) options.tlsAllowInvalidCertificates = true;
    if (allowInvalidHostnames) options.tlsAllowInvalidHostnames = true;

    const conn = await connect(mongoUrl, options);
    try {
      await Promise.all([
        Worker.init(),
        HomeOwner.init(),
        Notification.init(),
        WorkerNotification.init(),
        AdminNotification.init(),
      ]);
      await Promise.all([
        Worker.collection.dropIndex('phone_1').catch(() => {}),
        HomeOwner.collection.dropIndex('phone_1').catch(() => {}),
      ]);
    } catch (indexError) {
      console.warn('Worker index creation warning:', indexError?.message || indexError);
    }
    console.log(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error('MongoDB connection error:', error?.message || error);
    if (error?.reason) {
      console.error('MongoDB connection reason:', error.reason);
    }
    if (error?.cause) {
      console.error('MongoDB connection cause:', error.cause);
    }
    process.exit(1);
  }
};

export default connectDB;
