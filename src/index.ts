import http from 'http';
import { createApp } from './app';
import { env } from './config/env';
import { connectDatabase } from './config/database';
import { ensureAssignmentListBackfill } from './services/assignmentListSync';
import { createSocketServer } from './socket/remoteCallSocket';
import { setSocketServer } from './services/realtimeNotify';

const app = createApp();
const httpServer = http.createServer(app);

async function start() {
  try {
    await connectDatabase();
    void ensureAssignmentListBackfill().catch((err) => {
      console.warn('[leads] assignment list backfill failed', err instanceof Error ? err.message : err);
    });
    const io = createSocketServer(httpServer);
    setSocketServer(io);
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
