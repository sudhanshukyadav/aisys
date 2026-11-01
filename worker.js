import schemaConfig from './schema.json';

let isDbInitialized = false;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Health check
    if (url.pathname === '/api/health') {
      return jsonResponse({ status: 'ok', timestamp: Date.now() });
    }

    // 2. Fetch site list for the modal dropdown
    if (url.pathname === '/api/sites' && request.method === 'GET') {
      if (!env.DB) {
        return jsonResponse({ error: "D1 database binding 'DB' is missing in wrangler.json" }, 500);
      }
      try {
        await ensureSchema(env.DB);
        const { results } = await env.DB.prepare(
          'SELECT site_id, location, name FROM sites ORDER BY name ASC'
        ).all();
        return jsonResponse({ sites: results || [] });
      } catch (err) {
        return jsonResponse({ error: 'Database query failed', details: err.message }, 500);
      }
    }

    // 3. User authentication & role-based camera access
    if (url.pathname === '/api/login' && request.method === 'POST') {
      if (!env.DB) {
        return jsonResponse({ error: "D1 database binding 'DB' is missing in wrangler.json" }, 500);
      }
      return handleLogin(request, env);
    }

    // 4. Waitlist submissions
    if (url.pathname === '/api/waitlist' && request.method === 'POST') {
      return handleWaitlist(request, env);
    }

    // 5. Explicit admin schema check/migration endpoint
    if (url.pathname === '/api/admin/init-schema' && request.method === 'POST') {
      const adminKey = request.headers.get('x-admin-key');
      if (adminKey !== 'aisys-admin-secret') {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }
      if (!env.DB) {
        return jsonResponse({ error: "D1 database binding 'DB' is missing in wrangler.json" }, 500);
      }

      let customSchema = null;
      try { customSchema = await request.json(); } catch {}
      const targetSchema = customSchema?.tables ? customSchema : schemaConfig;

      try {
        const result = await createMissingTables(env.DB, targetSchema);
        return jsonResponse(result);
      } catch (err) {
        return jsonResponse({ error: 'Failed to initialize schema', details: err.message }, 500);
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};

// --- SCHEMA & TABLE MANAGEMENT ---

async function ensureSchema(db) {
  if (isDbInitialized) return;
  await createMissingTables(db, schemaConfig);
  isDbInitialized = true;
}

async function createMissingTables(db, schemaDefinition) {
  const targetTables = Object.keys(schemaDefinition.tables || {});
  if (targetTables.length === 0) {
    return { status: 'noop', created: [], skipped: [] };
  }

  // Inspect existing SQLite tables
  const { results } = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'"
  ).all();

  const existingTables = new Set((results || []).map(r => r.name));
  const tablesToCreate = targetTables.filter(name => !existingTables.has(name));
  const tablesSkipped = targetTables.filter(name => existingTables.has(name));

  // If all tables in schema.json exist, do nothing
  if (tablesToCreate.length === 0) {
    return {
      status: 'already_exists',
      message: 'Schema already exists. No tables were created.',
      created: [],
      skipped: tablesSkipped
    };
  }

  // Build and execute DDL only for missing tables
  const statements = [];
  for (const tableName of tablesToCreate) {
    const columns = schemaDefinition.tables[tableName];
    const columnDefinitions = Object.entries(columns)
      .map(([colName, colType]) => `"${colName}" ${colType}`)
      .join(',\n    ');

    statements.push(`CREATE TABLE "${tableName}" (\n    ${columnDefinitions}\n);`);
  }

  await db.batch(statements.map(sql => db.prepare(sql)));

  return {
    status: 'created',
    message: `Created ${tablesToCreate.length} missing table(s).`,
    created: tablesToCreate,
    skipped: tablesSkipped
  };
}

// --- AUTHENTICATION & LOGIN ---

async function handleLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }

  const siteId = (body?.siteId ?? '').trim();
  const username = (body?.username ?? '').trim().toLowerCase();
  const password = body?.password ?? '';

  if (!siteId || !username || !password) {
    return jsonResponse({ error: 'Site/Location, Username, and Password are required.' }, 400);
  }

  await ensureSchema(env.DB);
  const passwordHash = await hashPassword(password);

  // Authenticate user credentials scoped to location/site
  const user = await env.DB.prepare(
    'SELECT user_id, site_id, username, role, allowed_cameras FROM users WHERE site_id = ? AND username = ? AND password_hash = ?'
  ).bind(siteId, username, passwordHash).first();

  if (!user) {
    return jsonResponse({ error: 'Invalid credentials or unauthorized location.' }, 401);
  }

  // Parse admin-controlled camera permissions
  let allowedCameras = [];
  try { allowedCameras = JSON.parse(user.allowed_cameras); } catch {}

  // Resolve authorized camera feeds
  let cameraQuery;
  if (user.role === 'admin' || allowedCameras.includes('*')) {
    cameraQuery = env.DB.prepare(
      'SELECT camera_id, name, stream_url FROM cameras WHERE site_id = ?'
    ).bind(siteId);
  } else {
    const placeholders = allowedCameras.map(() => '?').join(',');
    cameraQuery = env.DB.prepare(
      `SELECT camera_id, name, stream_url FROM cameras WHERE site_id = ? AND camera_id IN (${placeholders})`
    ).bind(siteId, ...allowedCameras);
  }

  const { results: cameras } = await cameraQuery.all();

  return jsonResponse({
    status: 'success',
    user: {
      userId: user.user_id,
      username: user.username,
      siteId: user.site_id,
      role: user.role,
      cameras: cameras || []
    }
  });
}

// --- UTILITIES ---

async function hashPassword(plainText) {
  const enc = new TextEncoder().encode(plainText);
  const hashBuf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function handleWaitlist(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }

  const email = (body?.email ?? '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse({ error: 'Please enter a valid email address.' }, 400);
  }

  if (env.WAITLIST_KV) {
    try {
      await env.WAITLIST_KV.put('waitlist:' + email + ':' + Date.now(), JSON.stringify({ email, joined: new Date().toISOString() }));
    } catch {}
  }

  return jsonResponse({ message: "You're on the list! We'll send your API key soon.", email });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
