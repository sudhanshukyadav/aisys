export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // POST /api/waitlist
    if (url.pathname === '/api/waitlist' && request.method === 'POST') {
      return handleWaitlist(request, env);
    }

    // GET /api/sites (Industrial Camera Portal)
    if (url.pathname === '/api/sites') {
      return jsonResponse({
        sites: [
          { siteId: 'AISYS-CAM-01', location: 'Plant 1 - Edge Monitor' },
          { siteId: 'AISYS-CAM-02', location: 'Logistics Facility - West' }
        ]
      });
    }

    // POST /api/login (Industrial Camera Portal)
    if (url.pathname === '/api/login' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }
      if (body.username === 'admin' && body.password === 'admin') {
        return jsonResponse({ status: 'success' }, 200);
      }
      return jsonResponse({ error: 'Invalid camera portal credentials' }, 401);
    }

    // Health Check
    if (url.pathname === '/api/health') {
      return jsonResponse({ status: 'ok', timestamp: Date.now() });
    }

    return new Response('Not Found', { status: 404 });
  },
};

async function handleWaitlist(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }
  const email = (body?.email ?? '').trim().toLowerCase();
  if (!email) return jsonResponse({ error: 'Email is required' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonResponse({ error: 'Please enter a valid email address' }, 400);

  if (env.WAITLIST_KV) {
    try {
      await env.WAITLIST_KV.put('waitlist:' + email + ':' + Date.now(), JSON.stringify({ email, joined: new Date().toISOString() }));
    } catch {}
  }
  return jsonResponse({ message: "You're on the list! We'll send your API key soon.", email }, 200);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
/**
 * Converts a JSON schema object into an array of CREATE TABLE SQL statements.
 * @param {Object} schemaConfig - The parsed JSON containing table and column definitions.
 * @returns {string[]} Array of SQL DDL queries.
 */
function buildCreateTableQueries(schemaConfig) {
  const queries = [];
  const tables = schemaConfig.tables || {};

  for (const [tableName, columns] of Object.entries(tables)) {
    const columnDefinitions = Object.entries(columns)
      .map(([colName, colType]) => `"${colName}" ${colType}`)
      .join(',\n    ');

    const query = `CREATE TABLE IF NOT EXISTS "${tableName}" (\n    ${columnDefinitions}\n);`;
    queries.push(query);
  }

  return queries;
}

/**
 * Executes the generated DDL statements on Cloudflare D1.
 * @param {D1Database} db - Cloudflare D1 binding (env.DB).
 * @param {Object} schemaConfig - The parsed JSON schema.
 */
async function initializeDatabaseFromSchema(db, schemaConfig) {
  const sqlStatements = buildCreateTableQueries(schemaConfig);
  const batchStatements = sqlStatements.map(sql => db.prepare(sql));
  
  await db.batch(batchStatements);
  return sqlStatements;
}
import schemaConfig from './schema.json'; // or receive it dynamically via POST /api/admin/init-schema

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Endpoint to initialize/verify table columns from JSON schema
    if (url.pathname === '/api/admin/init-schema' && request.method === 'POST') {
      const adminKey = request.headers.get('x-admin-key');
      if (adminKey !== 'aisys-admin-secret') {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      // Read custom JSON schema from the request body, or fallback to schemaConfig
      let customSchema = null;
      try { customSchema = await request.json(); } catch {}
      const targetSchema = customSchema?.tables ? customSchema : schemaConfig;

      try {
        const generatedSql = await initializeDatabaseFromSchema(env.DB, targetSchema);
        return jsonResponse({
          message: 'Database schema created successfully from JSON',
          generatedSql
        });
      } catch (err) {
        return jsonResponse({ error: 'Failed to initialize schema', details: err.message }, 500);
      }
    }

    // Endpoint called when "Security" menu is clicked to fill site dropdown
    if (url.pathname === '/api/sites' && request.method === 'GET') {
      try {
        const { results } = await env.DB.prepare(
          'SELECT site_id, location, name FROM sites ORDER BY name ASC'
        ).all();
        return jsonResponse({ sites: results || [] });
      } catch (err) {
        return jsonResponse({ error: 'Tables not ready. Initialize schema first.' }, 500);
      }
    }

    // Authenticate user against location, username, and password
    if (url.pathname === '/api/login' && request.method === 'POST') {
      return handleLogin(request, env);
    }

    // Waitlist route
    if (url.pathname === '/api/waitlist' && request.method === 'POST') {
      return handleWaitlist(request, env);
    }

    return new Response('Not Found', { status: 404 });
  }
};

async function handleLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const siteId = (body?.siteId ?? '').trim();
  const username = (body?.username ?? '').trim().toLowerCase();
  const password = body?.password ?? '';

  if (!siteId || !username || !password) {
    return jsonResponse({ error: 'Site/Location, Username, and Password are required.' }, 400);
  }

  const passwordHash = await hashPassword(password);

  // Authenticate user credentials matched to location/site
  const user = await env.DB.prepare(
    'SELECT user_id, site_id, username, role, allowed_cameras FROM users WHERE site_id = ? AND username = ? AND password_hash = ?'
  ).bind(siteId, username, passwordHash).first();

  if (!user) {
    return jsonResponse({ error: 'Invalid credentials or unauthorized location.' }, 401);
  }

  // Parse admin-controlled camera permissions
  let allowedCameras = [];
  try { allowedCameras = JSON.parse(user.allowed_cameras); } catch {}

  // Fetch permitted camera streams based on role and allowed_cameras
  let cameraQuery;
  if (user.role === 'admin' || allowedCameras.includes('*')) {
    cameraQuery = env.DB.prepare('SELECT camera_id, name, stream_url FROM cameras WHERE site_id = ?').bind(siteId);
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

async function hashPassword(plainText) {
  const enc = new TextEncoder().encode(plainText);
  const hashBuf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function handleWaitlist(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
  const email = (body?.email ?? '').trim().toLowerCase();
  if (env.WAITLIST_KV && email) {
    await env.WAITLIST_KV.put('waitlist:' + email + ':' + Date.now(), JSON.stringify({ email }));
  }
  return jsonResponse({ message: "You're on the list!", email });
}
