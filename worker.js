export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle CORS preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    // 1. Authentication & Auto-Registration
    if (url.pathname === '/api/login' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      try {
        const result = await env.DB.authenticateOrRegisterUser(
          body.locationId,
          body.username,
          body.password
        );

        if (result.success) {
          return jsonResponse({
            status: 'success',
            isNewUser: result.isNewUser,
            user: result.user
          }, 200);
        }

        return jsonResponse({ error: result.error }, result.status || 401);
      } catch (err) {
        console.error('Database RPC error (/api/login):', err);
        return jsonResponse({
          error: 'Database service unavailable',
          details: err?.message || String(err)
        }, 502);
      }
    }

    // 2. Admin: Retrieve all tables (locations, cameras, users)
    if (url.pathname === '/api/admin/tables' && request.method === 'GET') {
      const adminUserId = request.headers.get('x-admin-userid');

      try {
        const result = await env.DB.adminGetAllTables(adminUserId);
        return jsonResponse(result, result.status || (result.success ? 200 : 403));
      } catch (err) {
        console.error('Database RPC error (/api/admin/tables):', err);
        return jsonResponse({
          error: 'Database service unavailable',
          details: err?.message || String(err)
        }, 502);
      }
    }

    // 3. Admin: Insert or Update table records
    if (url.pathname === '/api/admin/tables/save' && request.method === 'POST') {
      const adminUserId = request.headers.get('x-admin-userid');
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      try {
        const result = await env.DB.adminSaveRecord(
          adminUserId,
          body.table,
          body.data,
          !!body.isUpdate
        );
        return jsonResponse(result, result.status || (result.success ? 200 : 400));
      } catch (err) {
        console.error('Database RPC error (/api/admin/tables/save):', err);
        return jsonResponse({
          error: 'Database service unavailable',
          details: err?.message || String(err)
        }, 502);
      }
    }

    // 4. Latest Camera Snapshot from R2
    if (url.pathname === '/api/snapshot/latest' && request.method === 'GET') {
      const loc = (url.searchParams.get('location') || '').toUpperCase().trim();
      const cam = (url.searchParams.get('cam') || '').toUpperCase().trim();

      if (!loc || !cam) {
        return jsonResponse({ error: 'location and cam query parameters are required' }, 400);
      }

      if (!env.MEDIA_BUCKET) {
        return jsonResponse({ error: "R2 binding 'MEDIA_BUCKET' is not configured on gateway" }, 500);
      }

      try {
        // Search SNAPSHOTS directory first, then fallback to SNAP
        let prefix = `${loc}/SNAPSHOTS/${cam}/`;
        let listed = await env.MEDIA_BUCKET.list({ prefix, limit: 25 });

        if (!listed.objects || listed.objects.length === 0) {
          prefix = `${loc}/SNAP/${cam}/`;
          listed = await env.MEDIA_BUCKET.list({ prefix, limit: 25 });
        }

        // Fallback placeholder SVG if no snapshot has been pushed to R2 yet
        if (!listed.objects || listed.objects.length === 0) {
          const placeholderSvg = `
            <svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
              <rect width="100%" height="100%" fill="#0a0e17"/>
              <circle cx="320" cy="150" r="32" fill="#151d2e"/>
              <path d="M308 142h24v16h-24zM314 136h12v4h-12z" fill="#38bdf8"/>
              <text x="50%" y="210" fill="#64748b" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif" font-size="16" text-anchor="middle" font-weight="600">Awaiting Camera Snapshot</text>
              <text x="50%" y="235" fill="#334155" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif" font-size="12" text-anchor="middle">${escapeHtml(loc)} / ${escapeHtml(cam)}</text>
            </svg>
          `.trim();

          return new Response(placeholderSvg, {
            status: 200,
            headers: {
              'Content-Type': 'image/svg+xml',
              'Cache-Control': 'no-cache, no-store, must-revalidate',
              ...corsHeaders()
            }
          });
        }

        // Get the most recent snapshot by upload timestamp
        const latestMeta = listed.objects.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded))[0];
        const snapshotObject = await env.MEDIA_BUCKET.get(latestMeta.key);

        if (!snapshotObject) {
          return jsonResponse({ error: 'Snapshot object could not be retrieved' }, 404);
        }

        return new Response(snapshotObject.body, {
          status: 200,
          headers: {
            'Content-Type': snapshotObject.httpMetadata?.contentType || 'image/jpeg',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'X-Snapshot-Time': latestMeta.uploaded.toISOString(),
            ...corsHeaders()
          }
        });
      } catch (err) {
        console.error('R2 retrieval error (/api/snapshot/latest):', err);
        return jsonResponse({
          error: 'Failed to retrieve snapshot from storage',
          details: err?.message || String(err)
        }, 500);
      }
    }

    // 5. Landing Page Waitlist Submissions
    if (url.pathname === '/api/waitlist' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      const email = (body?.email ?? '').trim().toLowerCase();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return jsonResponse({ error: 'A valid email address is required' }, 400);
      }

      if (env.WAITLIST_KV) {
        try {
          await env.WAITLIST_KV.put(
            `waitlist:${email}:${Date.now()}`,
            JSON.stringify({ email, submittedAt: new Date().toISOString() })
          );
        } catch (err) {
          console.error('Waitlist KV write error:', err);
        }
      }

      return jsonResponse({ message: "You're on the list!", email }, 200);
    }

    // 6. System Health Check
    if (url.pathname === '/api/health') {
      return jsonResponse({
        status: 'ok',
        service: 'aisys-gateway',
        timestamp: Date.now()
      }, 200);
    }

    return new Response('Not Found', {
      status: 404,
      headers: corsHeaders()
    });
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-userid'
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders()
    }
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
// Fallback: Serve static assets (HTML, JS, CSS) from public/
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', {
      status: 404,
      headers: corsHeaders()
    });
  
