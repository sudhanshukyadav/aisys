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
