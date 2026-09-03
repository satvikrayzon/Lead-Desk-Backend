import { createApp } from './app';
import { env } from './config/env';
import { connectDatabase } from './config/database';

const app = createApp();

async function start() {
  try {
    await connectDatabase();
    app.listen(env.PORT, () => {
      console.log(`Lead Recorder API running on port ${env.PORT} [${env.NODE_ENV}]`);
      console.log(`Health: ${env.API_BASE_URL}/health`);
      console.log(`API base: ${env.API_BASE_URL}/api`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();

export { app };
