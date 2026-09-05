import http from 'http';
import { createApp } from './app';
import { env } from './config/env';
import { connectDatabase } from './config/database';
import { createSocketServer } from './socket/remoteCallSocket';

const app = createApp();
const httpServer = http.createServer(app);

async function start() {
  try {
    await connectDatabase();
    createSocketServer(httpServer);
    httpServer.listen(env.PORT, () => {
      console.log(`Lead Recorder API running on port ${env.PORT} [${env.NODE_ENV}]`);
      console.log(`Health: ${env.API_BASE_URL}/health`);
      console.log(`API base: ${env.API_BASE_URL}/api`);
      console.log(`Socket.IO path: ${env.API_BASE_URL}/socket.io`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();

export { app, httpServer };
