import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function fromRoot(value) { return path.isAbsolute(value) ? value : path.resolve(root, value); }

export const config = Object.freeze({
  root,
  port: Number(process.env.PORT || 5002),
  clientUrl: process.env.CLIENT_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:5002',
  databasePath: process.env.DATABASE_URL === ':memory:' ? ':memory:' : process.env.DATABASE_URL ? fromRoot(process.env.DATABASE_URL) : fromRoot('./data/lynk.sqlite'),
  jwtSecret: process.env.JWT_SECRET || 'development-only-change-this-secret-before-deployment',
  uploadDir: fromRoot(process.env.UPLOAD_DIR || './data/uploads'),
  maxFileSize: Number(process.env.MAX_FILE_SIZE || 10 * 1024 * 1024),
  ackTimeoutMs: Number(process.env.ACK_TIMEOUT_MS || 3000),
  maxRetries: Number(process.env.MAX_RETRIES || 3),
  heartbeatIntervalMs: Number(process.env.HEARTBEAT_INTERVAL_MS || 15000),
  cookieSecure: process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
  nodeEnv: process.env.NODE_ENV || 'development'
});

if (config.nodeEnv === 'production' && (config.jwtSecret.length < 32 || config.jwtSecret === 'development-only-change-this-secret-before-deployment' || config.jwtSecret.includes('replace-with-'))) {
  throw new Error('JWT_SECRET must be configured for production.');
}
