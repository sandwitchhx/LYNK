import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { config } from './config.js';
import { api, errorHandler } from './routes.js';
import { HttpError } from './errors.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.nodeEnv === 'production' ? 1 : false);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'", 'ws:', 'wss:'],
        objectSrc: ["'none'"], frameAncestors: ["'none'"]
      }
    }, crossOriginEmbedderPolicy: false
  }));
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origin === config.clientUrl) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.use(cookieParser());
  app.get('/health', (req, res) => res.json({ status: 'ok', service: 'lynk-api', timestamp: new Date().toISOString() }));
  app.use('/api', api);
  app.get('/', (req, res) => res.sendFile(path.join(config.root, 'index.html')));
  app.get('/tickets/:ticketId', (req, res) => res.sendFile(path.join(config.root, 'index.html')));
  app.get('/styles.css', (req, res) => res.sendFile(path.join(config.root, 'styles.css')));
  app.get('/app.js', (req, res) => res.sendFile(path.join(config.root, 'app.js')));
  app.use('/uploads', (req, res, next) => next(new HttpError(404, 'Not found.', 'NOT_FOUND')));
  app.use((req, res, next) => next(new HttpError(404, 'Not found.', 'NOT_FOUND')));
  app.use(errorHandler);
  return app;
}
