import pg from 'pg';
import { createClient } from 'redis';
import { createApp } from './app.js';
import dotenv from 'dotenv';

dotenv.config({ path: process.env.APP_PATH?.concat('/.env') || './.env', override: true });

const { Pool } = pg;
const port = Number.parseInt(process.env.PORT ?? '3000', 10);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

const pool = new Pool({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number.parseInt(process.env.DB_PORT ?? '5432', 10),
  user: process.env.DB_USER ?? 'tasks',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME ?? 'tasks',
  connectionTimeoutMillis: 3000
});
const redis = createClient({
  url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  socket: {
    reconnectStrategy(retries) {
      return Math.min(retries * 100, 3000);
    }
  }
});

redis.on('error', (error) => {
  console.error('Redis client error.', error);
});

const app = createApp({ pool, redis });
let server;
let shuttingDown = false;

async function closeServer(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.info(`Received ${signal}; shutting down.`);

  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  await Promise.all([pool.end(), redis.isOpen ? redis.quit() : Promise.resolve()]);
}

process.on('SIGTERM', () => {
  closeServer('SIGTERM').catch((error) => {
    console.error('Graceful shutdown failed.', error);
    process.exitCode = 1;
  });
});
process.on('SIGINT', () => {
  closeServer('SIGINT').catch((error) => {
    console.error('Graceful shutdown failed.', error);
    process.exitCode = 1;
  });
});

try {
  await pool.query('SELECT 1');
  await redis.connect();
  server = app.listen(port, '0.0.0.0', () => {
    console.info(`Todo API listening on port ${port}.`);
  });
} catch (error) {
  console.error('API startup failed; verify PostgreSQL and Redis are healthy.', error);
  await Promise.allSettled([pool.end(), redis.isOpen ? redis.quit() : Promise.resolve()]);
  process.exitCode = 1;
}
