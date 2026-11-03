export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    // 2. Direct Media Upload to R2 (for S: Drive Sync Watcher)
    // Format: PUT /upload/:location/:category/:cam/:fileName
    if (url.pathname.startsWith('/upload/') && request.method === 'PUT') {
      const token = request.headers.get('x-media-token');
      if (token !== 'aisys-media-secret-key') {
        return jsonResponse({ error: 'Unauthorized: Invalid media upload token' }, 401);
      }

      if (!env.MEDIA_BUCKET) {
        return jsonResponse({ error: "R2 binding 'MEDIA_BUCKET' not configured" }, 500);
      }

      const pathSegments = url.pathname.slice('/upload/'.length).split('/');
      if (pathSegments.length < 4) {
        return jsonResponse({
          error: 'Expected path format: /upload/:locationCode/:category/:camName/:fileName'
        }, 400);
      }

      const locationCode = decodeURIComponent(pathSegments[0]).trim().toUpperCase();
      const rawCategory  = decodeURIComponent(pathSegments[1]).trim().toUpperCase();
      const camName      = decodeURIComponent(pathSegments[2]).trim().toUpperCase();
      const fileName     = decodeURIComponent(pathSegments.slice(3).join('/'));

      // Reject LIVE feeds (ephemeral HLS belongs in RAM on the RTMP server)
      if (rawCategory === 'LIVE') {
        return jsonResponse({
          error: "The 'LIVE' category is ephemeral and served via RTMP/HLS; it cannot be stored in R2."
        }, 400);
      }

      const validCategories = new Set(['MOTION', 'SNAPSHOTS', 'SNAP']);
      if (!validCategories.has(rawCategory)) {
        return jsonResponse({
          error: `Invalid category '${rawCategory}'. Accepted storage categories: MOTION, SNAPSHOTS, SNAP.`
        }, 400);
      }

      const normalizedCategory = rawCategory === 'SNAP' ? 'SNAPSHOTS' : rawCategory;
      const r2Key = `${locationCode}/${normalizedCategory}/${camName}/${fileName}`;

      const ext = fileName.split('.').pop()?.toLowerCase();
      const contentTypeMap = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        webp: 'image/webp',
        mp4: 'video/mp4',
        mkv: 'video/x-matroska'
      };

      try {
        await env.MEDIA_BUCKET.put(r2Key, request.body, {
          httpMetadata: { contentType: contentTypeMap[ext] || 'application/octet-stream' },
          customMetadata: {
            uploadedAt: new Date().toISOString(),
            locationCode,
            category: normalizedCategory,
            camName
          }
        });

        return jsonResponse({ status: 'success', key: r2Key }, 201);
      } catch (err) {
        console.error('R2 upload error:', err);
        return jsonResponse({ error: 'Failed to write to R2', details: err.message }, 500);
      }
    }

    // 3. Latest Camera Snapshot from R2
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
        // Search across common category naming variations
        const prefixes = [
          `${loc}/SNAPSHOTS/${cam}/`,
          `${loc}/snapshots/${cam}/`,
          `${loc}/SNAP/${cam}/`,
          `${loc}/snap/${cam}/`
        ];

        let matchedObjects = [];
        for (const prefix of prefixes) {
          const listed = await env.MEDIA_BUCKET.list({ prefix, limit: 30 });
          if (listed.objects && listed.objects.length > 0) {
            matchedObjects.push(...listed.objects);
          }
        }

        // Return clean placeholder SVG if no snapshot uploaded yet
        if (matchedObjects.length === 0) {
          const placeholderSvg = `
            <svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
              <rect width="100%" height="100%" fill="#0a0e17"/>
              <circle cx="320" cy="140" r="32" fill="#151d2e"/>
              <path d="M308 132h24v16h-24zM314 126h12v4h-12z" fill="#38bdf8"/>
              <text x="50%" y="200" fill="#94a3b8" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="16" text-anchor="middle" font-weight="600">Awaiting Camera Snapshot</text>
              <text x="50%" y="225" fill="#475569" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="13" text-anchor="middle">${escapeHtml(loc)} / ${escapeHtml(cam)}</text>
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

        // Sort descending by upload time to pull the latest image
        const latestMeta = matchedObjects.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded))[0];
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

    // 4. User Authentication & Registration via RPC
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

    // 5. Admin: Read All Database Tables
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

    // 6. Admin: Save / Update Records
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

    // 7. Landing Page Waitlist
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

    // 8. Health Check
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
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-userid, x-media-token'
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
