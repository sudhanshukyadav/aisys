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
