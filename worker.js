export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Authentication & Registration
    if (url.pathname === '/api/login' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

      try {
        const result = await env.DB.authenticateOrRegisterUser(body.locationId, body.username, body.password);
        if (result.success) {
          return jsonResponse({ status: 'success', isNewUser: result.isNewUser, user: result.user }, 200);
        }
        return jsonResponse({ error: result.error }, result.status || 401);
      } catch (err) {
        console.error('Database RPC error:', err);
        return jsonResponse({ error: 'Database service unavailable', details: err?.message || String(err) }, 502);
      }
    }

    // 2. Admin: Get all records from all tables
    if (url.pathname === '/api/admin/tables' && request.method === 'GET') {
      const adminUserId = request.headers.get('x-admin-userid');
      try {
        const result = await env.DB.adminGetAllTables(adminUserId);
        return jsonResponse(result, result.status || (result.success ? 200 : 403));
      } catch (err) {
        console.error('Database RPC error:', err);
        return jsonResponse({ error: 'Database service unavailable', details: err?.message || String(err) }, 502);
      }
    }

    // 3. Admin: Insert or update records
    if (url.pathname === '/api/admin/tables/save' && request.method === 'POST') {
      const adminUserId = request.headers.get('x-admin-userid');
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

      try {
        const result = await env.DB.adminSaveRecord(adminUserId, body.table, body.data, !!body.isUpdate);
        return jsonResponse(result, result.status || (result.success ? 200 : 400));
      } catch (err) {
        console.error('Database RPC error:', err);
        return jsonResponse({ error: 'Database service unavailable', details: err?.message || String(err) }, 502);
      }
    }

    // 4. Waitlist submissions
    if (url.pathname === '/api/waitlist' && request.method === 'POST') {
      return handleWaitlist(request, env);
    }

    // 5. Health Check
    if (url.pathname === '/api/health') {
      return jsonResponse({ status: 'ok', timestamp: Date.now() });
    }

    return new Response('Not Found', { status: 404 });
  }
};

async function handleWaitlist(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }
  const email = (body?.email ?? '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse({ error: 'Valid email required' }, 400);
  }
  if (env.WAITLIST_KV) {
    try {
      await env.WAITLIST_KV.put('waitlist:' + email + ':' + Date.now(), JSON.stringify({ email }));
    } catch {}
  }
  return jsonResponse({ message: "You're on the list!", email });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
