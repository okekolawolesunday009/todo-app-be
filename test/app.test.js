import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';

const taskId = 'd9428888-122b-4afc-ae58-4f5c8b7a83c1';
const task = {
  id: taskId,
  title: 'Learn Docker',
  completed: false,
  created_at: '2026-10-09T12:00:00.000Z',
  updated_at: '2026-10-09T12:00:00.000Z'
};
const logEntries = [];
const logger = {
  warn: (...args) => logEntries.push(['warn', ...args]),
  error: (...args) => logEntries.push(['error', ...args])
};

let storedTask;
let cacheValue;
let pool;
let redis;
let baseUrl;
let server;

before(async () => {
  storedTask = null;
  cacheValue = null;
  pool = {
    async query(sql, values = []) {
      if (sql === 'SELECT 1') {
        return { rows: [{ '?column?': 1 }] };
      }
      if (sql.startsWith('SELECT id, title') && sql.includes('ORDER BY')) {
        return { rows: storedTask ? [storedTask] : [] };
      }
      if (sql.startsWith('INSERT INTO tasks')) {
        storedTask = { ...task, title: values[0], completed: values[1] };
        return { rows: [storedTask] };
      }
      if (sql.startsWith('SELECT id, title') && sql.includes('WHERE id')) {
        return { rows: storedTask?.id === values[0] ? [storedTask] : [] };
      }
      if (sql.startsWith('UPDATE tasks')) {
        if (!storedTask || storedTask.id !== values[0]) {
          return { rows: [] };
        }
        storedTask = {
          ...storedTask,
          title: values[1] ?? storedTask.title,
          completed: values[2] ?? storedTask.completed
        };
        return { rows: [storedTask] };
      }
      if (sql.startsWith('DELETE FROM tasks')) {
        const found = storedTask?.id === values[0];
        storedTask = found ? null : storedTask;
        return { rowCount: found ? 1 : 0 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  redis = {
    async get() {
      return cacheValue;
    },
    async set(_key, value) {
      cacheValue = value;
    },
    async del() {
      cacheValue = null;
    },
    async ping() {
      return 'PONG';
    }
  };

  server = createApp({ pool, redis, logger }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

test('health reports healthy dependencies', async () => {
  const response = await fetch(`${baseUrl}/api/health`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: 'ok',
    dependencies: { postgres: 'ok', redis: 'ok' }
  });
});

test('CRUD operations persist task data and invalidate cached lists', async () => {
  const createResponse = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '  Learn Docker  ' })
  });
  assert.equal(createResponse.status, 201);
  assert.equal((await createResponse.json()).title, 'Learn Docker');

  const firstListResponse = await fetch(`${baseUrl}/api/tasks`);
  assert.equal(firstListResponse.headers.get('x-cache'), 'MISS');
  assert.equal((await firstListResponse.json())[0].title, 'Learn Docker');

  const cachedListResponse = await fetch(`${baseUrl}/api/tasks`);
  assert.equal(cachedListResponse.headers.get('x-cache'), 'HIT');

  const updateResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ completed: true })
  });
  assert.equal(updateResponse.status, 200);
  assert.equal((await updateResponse.json()).completed, true);
  assert.equal(cacheValue, null);

  const itemResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`);
  assert.equal(itemResponse.status, 200);
  assert.equal((await itemResponse.json()).completed, true);

  const deleteResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`, { method: 'DELETE' });
  assert.equal(deleteResponse.status, 204);

  const missingResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`);
  assert.equal(missingResponse.status, 404);
});

test('rejects invalid task input and identifiers', async () => {
  const invalidBody = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '   ' })
  });
  assert.equal(invalidBody.status, 400);

  const invalidId = await fetch(`${baseUrl}/api/tasks/not-a-uuid`);
  assert.equal(invalidId.status, 400);

  const emptyUpdate = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(emptyUpdate.status, 400);
});

test('replaces malformed cached task data after reading PostgreSQL', async () => {
  cacheValue = '{"unexpected":true}';

  const response = await fetch(`${baseUrl}/api/tasks`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-cache'), 'MISS');
  assert.deepEqual(await response.json(), []);
  assert.equal(cacheValue, '[]');
});

test('falls back to PostgreSQL and logs when Redis is unavailable', async () => {
  redis.get = async () => {
    throw new Error('Redis unavailable');
  };

  const response = await fetch(`${baseUrl}/api/tasks`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-cache'), 'BYPASS');
  assert.ok(logEntries.some(([level, message]) =>
    level === 'warn' && message.includes('Redis cache read failed')
  ));
});
