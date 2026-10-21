import http from 'node:http';
import { createApp } from './app.js';
import { attachWebSocketServer } from './realtime.js';
import { config } from './config.js';
import { bootstrapAdminFromEnvironment } from './admin-bootstrap.js';
import './db.js';

if (process.env.RENDER === 'true') {
  const result = await bootstrapAdminFromEnvironment();
  if (result === 'CREATED') console.log('Created the configured Render bootstrap admin.');
}

export const app = createApp();
export const server = http.createServer(app);
export const wss = attachWebSocketServer(server);

if (process.env.NODE_ENV !== 'test') {
  server.listen(config.port, () => console.log(`LYNK API and web app listening on port ${config.port}`));
}

function shutdown() {
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
