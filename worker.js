export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Fetch sites for login modal dropdown
    if (url.pathname === '/api/sites' && request.method === 'GET') {
      try {
        const sites = await env.DB_SERVICE.getSites();
        return jsonResponse({ sites });
      } catch (err) {
        return jsonResponse({ error: 'Database service unavailable' }, 502);
      }
    }

    // 2. User authentication via aisys-db
    if (url.pathname === '/api/login' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

      try {
        const result = await env.DB_SERVICE.authenticateUser(body.siteId, body.username, body.password);
        if (result.success) {
          return jsonResponse({ status: 'success', user: result.user }, 200);
        }
        return jsonResponse({ error: result.error }, result.status || 401);
      } catch (err) {
        return jsonResponse({ error: 'Authentication service error' }, 502);
      }
    }

    // 3. Waitlist submissions (KV)
    if (url.pathname === '/api/waitlist' && request.method === 'POST') {
      return handleWaitlist(request, env);
    }

    // 4. Health check
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
