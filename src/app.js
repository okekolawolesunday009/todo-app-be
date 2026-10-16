import express from 'express';

const TASK_LIST_CACHE_KEY = 'tasks:list';
const TASK_LIST_CACHE_TTL_SECONDS = 30;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_FIELDS = ['title', 'completed'];

function validateTaskInput(body, { partial = false } = {}) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be a JSON object.';
  }

  const keys = Object.keys(body);
  const unknownFields = keys.filter((key) => !TASK_FIELDS.includes(key));
  if (unknownFields.length > 0) {
    return `Unknown field${unknownFields.length === 1 ? '' : 's'}: ${unknownFields.join(', ')}.`;
  }

  if (partial && keys.length === 0) {
    return 'Provide at least one field to update.';
  }

  if (!partial && !Object.hasOwn(body, 'title')) {
    return 'A title is required.';
  }

  if (Object.hasOwn(body, 'title') &&
      (typeof body.title !== 'string' || body.title.trim().length === 0 || body.title.trim().length > 200)) {
    return 'Title must be a string containing 1 to 200 characters.';
  }

  if (Object.hasOwn(body, 'completed') && typeof body.completed !== 'boolean') {
    return 'Completed must be a boolean.';
  }

  return null;
}

function logCacheError(logger, operation, error) {
  logger.warn(`Redis cache ${operation} failed; continuing with PostgreSQL.`, error);
}

export function createApp({ pool, redis, logger = console }) {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', async (req, res) => {
    const dependencies = { postgres: 'ok', redis: 'ok' };

    try {
      await pool.query('SELECT 1');
    } catch (error) {
      dependencies.postgres = 'unavailable';
      logger.error('PostgreSQL health check failed.', error);
    }

    try {
      await redis.ping();
    } catch (error) {
      dependencies.redis = 'unavailable';
      logger.error('Redis health check failed.', error);
    }

    const healthy = Object.values(dependencies).every((status) => status === 'ok');
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      dependencies
    });
  });

  app.get('/api/tasks', async (req, res) => {
    let cacheStatus = 'MISS';

    try {
      const cachedTasks = await redis.get(TASK_LIST_CACHE_KEY);
      if (cachedTasks !== null) {
        try {
          const tasks = JSON.parse(cachedTasks);
          if (Array.isArray(tasks)) {
            res.set('X-Cache', 'HIT');
            return res.json(tasks);
          }
          throw new Error('Cached task list is not an array.');
        } catch (error) {
          logCacheError(logger, 'read', error);
          cacheStatus = 'MISS';
        }
      }
    } catch (error) {
      logCacheError(logger, 'read', error);
      cacheStatus = 'BYPASS';
    }

    const { rows } = await pool.query(
      'SELECT id, title, completed, created_at, updated_at FROM tasks ORDER BY created_at DESC'
    );

    if (cacheStatus !== 'BYPASS') {
      try {
        await redis.set(TASK_LIST_CACHE_KEY, JSON.stringify(rows), {
          EX: TASK_LIST_CACHE_TTL_SECONDS
        });
      } catch (error) {
        logCacheError(logger, 'write', error);
        cacheStatus = 'BYPASS';
      }
    }

    res.set('X-Cache', cacheStatus);
    res.json(rows);
  });

  app.post('/api/tasks', async (req, res) => {
    const validationError = validateTaskInput(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const { rows } = await pool.query(
      `INSERT INTO tasks (title, completed)
       VALUES ($1, $2)
       RETURNING id, title, completed, created_at, updated_at`,
      [req.body.title.trim(), req.body.completed ?? false]
    );

    await invalidateTaskListCache(redis, logger);
    res.status(201).json(rows[0]);
  });

  app.get('/api/tasks/:id', async (req, res) => {
    if (!UUID_PATTERN.test(req.params.id)) {
      return res.status(400).json({ error: 'Task ID must be a valid UUID.' });
    }

    const { rows } = await pool.query(
      'SELECT id, title, completed, created_at, updated_at FROM tasks WHERE id = $1',
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Task not found.' });
    }
    res.json(rows[0]);
  });

  app.put('/api/tasks/:id', async (req, res) => {
    if (!UUID_PATTERN.test(req.params.id)) {
      return res.status(400).json({ error: 'Task ID must be a valid UUID.' });
    }

    const validationError = validateTaskInput(req.body, { partial: true });
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const { rows } = await pool.query(
      `UPDATE tasks
       SET title = COALESCE($2, title),
           completed = COALESCE($3, completed),
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, title, completed, created_at, updated_at`,
      [req.params.id, req.body.title?.trim() ?? null, req.body.completed ?? null]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Task not found.' });
    }

    await invalidateTaskListCache(redis, logger);
    res.json(rows[0]);
  });

  app.delete('/api/tasks/:id', async (req, res) => {
    if (!UUID_PATTERN.test(req.params.id)) {
      return res.status(400).json({ error: 'Task ID must be a valid UUID.' });
    }

    const { rowCount } = await pool.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Task not found.' });
    }

    await invalidateTaskListCache(redis, logger);
    res.status(204).end();
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'Route not found.' });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      return next(error);
    }

    logger.error('Request failed.', error);
    if (error instanceof SyntaxError && Object.hasOwn(error, 'body')) {
      return res.status(400).json({ error: 'Request body must contain valid JSON.' });
    }
    if (error.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request body must not exceed 1 MB.' });
    }
    res.status(500).json({ error: 'Internal server error.' });
  });

  return app;
}

async function invalidateTaskListCache(redis, logger) {
  try {
    await redis.del(TASK_LIST_CACHE_KEY);
  } catch (error) {
    logCacheError(logger, 'invalidation', error);
  }
}
