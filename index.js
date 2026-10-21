import express from 'express';
import { createServer } from 'node:http';
import { createApp } from './server/app.js';
import { attachWebSocketServer } from './server/realtime.js';

// Vercel detects this root Express entry point and serves the whole app through
// one Node.js function. Export the HTTP server so the existing WebSocket upgrade
// handler can run on Vercel's WebSocket-capable Node runtime too.
const app = createApp(express());
const server = createServer(app);
attachWebSocketServer(server);

export default server;
