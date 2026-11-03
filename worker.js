// ============================================================
// AISYS EDGE WORKER (aisys/worker.js)
// Zero-Disk Live HLS, R2 Snapshots, Multi-Tenant Auth, D1 Admin
// ============================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Global CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCors();
    }

    try {
      // ------------------------------------------------------------
      // 1. AUTHENTICATION & LOGIN
      // ------------------------------------------------------------
      if ((pathname === '/api/auth/login' || pathname === '/api/login') && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const rawLoc = (body.locationId || body.location || '').trim();
        const username = (body.username || '').trim();
        const password = String(body.password || '');

        if (!rawLoc || !username || !password) {
          return jsonResponse({ error: 'Location ID, username, and password are required.' }, 400);
        }

        const locUpper = rawLoc.toUpperCase();
        const locFlipped = locUpper.includes('-') ? locUpper.split('-').reverse().join('-') : locUpper;

        // Query user in D1 (case-insensitive for username, supports HQ-AD or AD-HQ)
        const user = await env.DB.prepare(
          `SELECT * FROM users 
           WHERE (UPPER(location_id) = ? OR UPPER(location_id) = ?) 
             AND LOWER(username) = LOWER(?) 
           LIMIT 1`
        ).bind(locUpper, locFlipped, username).first();

        if (!user) {
          return jsonResponse({ error: 'Invalid location or username.' }, 401);
        }

        // Verify password (supports both plaintext seeds and SHA-256 hashes)
        const isPasswordValid = await verifyPassword(password, user.password_hash);
        if (!isPasswordValid) {
          return jsonResponse({ error: 'Incorrect password.' }, 401);
        }

        const actualLocId = user.location_id;

        // Fetch facility metadata
        const locationMeta = await env.DB.prepare(
          `SELECT location_id, description, address FROM locations WHERE location_id = ?`
        ).bind(actualLocId).first() || { location_id: actualLocId, description: 'Facility Active' };

        // Fetch cameras for this facility (schema contains NO stream_url column)
        const cameraRecords = await env.DB.prepare(
          `SELECT camera_id, location_id, name FROM cameras WHERE location_id = ?`
        ).bind(actualLocId).all();

        const allCameras = cameraRecords.results || [];

        // Parse user permissions
        let allowedCameras = ['*'];
        try {
          allowedCameras = JSON.parse(user.allowed_cameras || '["*"]');
        } catch {
          allowedCameras = ['*'];
        }

        let authorizedCameras = allCameras;
        if (!allowedCameras.includes('*') && user.role !== 'admin') {
          const allowedLower = allowedCameras.map(a => String(a).toLowerCase());
          authorizedCameras = allCameras.filter(cam =>
            allowedLower.includes(cam.camera_id.toLowerCase()) ||
            allowedLower.includes((cam.name || '').toLowerCase())
          );
        }

        return jsonResponse({
          success: true,
          user: {
            userId: user.user_id,
            username: user.username,
            role: user.role,
            locationId: actualLocId,
            location: locationMeta,
            cameras: authorizedCameras
          }
        });
      }

      // ------------------------------------------------------------
      // 2. R2 LATEST SNAPSHOT SYNCHRONIZATION
      // ------------------------------------------------------------
      if (pathname === '/api/snapshot/latest' && request.method === 'GET') {
        const rawLoc = (url.searchParams.get('location') || '').trim();
        const rawCam = (url.searchParams.get('cam') || url.searchParams.get('camera') || '').trim();

        if (!rawLoc || !rawCam) {
          return jsonResponse({ error: 'Parameters "location" and "cam" are required.' }, 400);
        }

        const locUpper = rawLoc.toUpperCase();
        const locLower = rawLoc.toLowerCase();
        const camUpper = rawCam.toUpperCase();
        const camLower = rawCam.toLowerCase();

        // Support inverted location codes (HQ-AD <-> AD-HQ)
        const locVariants = [locUpper, locLower];
        if (locUpper.includes('-')) {
          const flipped = locUpper.split('-').reverse().join('-');
          locVariants.push(flipped, flipped.toLowerCase());
        }

        // Query variants for R2 folder structures
        const prefixes = [];
        for (const loc of locVariants) {
          prefixes.push(
            `${loc}/snapshots/${camLower}/`,
            `${loc}/snapshots/${camUpper}/`,
            `${loc}/snapshots/${rawCam}/`,
            `${loc}/SNAPSHOTS/${camLower}/`,
            `${loc}/SNAPSHOTS/${camUpper}/`,
            `${loc}/snap/${camLower}/`,
            `${loc}/snap/${camUpper}/`
          );
        }

        let candidates = [];
        for (const prefix of prefixes) {
          const list = await env.MEDIA_BUCKET.list({ prefix, limit: 30 });
          if (list.objects && list.objects.length > 0) {
            const imageObjects = list.objects.filter(obj =>
              /\.(jpe?g|png|webp)$/i.test(obj.key)
            );
            candidates.push(...imageObjects);
            if (candidates.length > 0) break; // Found matches in current prefix
          }
        }

        if (candidates.length === 0) {
          return new Response(generatePlaceholderSvg(rawLoc, rawCam), {
            status: 404,
            headers: {
              'Content-Type': 'image/svg+xml',
              'Cache-Control': 'no-cache, no-store, must-revalidate',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }

        // Sort descending by uploaded timestamp
        candidates.sort((a, b) => new Date(b.uploaded).getTime() - new Date(a.uploaded).getTime());
        const latestKey = candidates[0].key;

        const object = await env.MEDIA_BUCKET.get(latestKey);
        if (!object) {
          return jsonResponse({ error: 'Object key missing from storage' }, 404);
        }

        const headers = new Headers();
        headers.set('Content-Type', object.httpMetadata?.contentType || 'image/jpeg');
        headers.set('Cache-Control', 'public, max-age=1, s-maxage=1, must-revalidate');
        headers.set('ETag', object.httpEtag);
        headers.set('Access-Control-Allow-Origin', '*');

        return new Response(object.body, { headers });
      }

      // ------------------------------------------------------------
      // 3. ADMIN TABLE EXPLORER ENDPOINTS
      // ------------------------------------------------------------
      if (pathname === '/api/admin/tables' && request.method === 'GET') {
        const tablesQuery = await env.DB.prepare(
          `SELECT name FROM sqlite_master 
           WHERE type='table' 
             AND name NOT LIKE 'sqlite_%' 
             AND name NOT LIKE '_cf_%'
           ORDER BY name ASC`
        ).all();

        return jsonResponse({ tables: (tablesQuery.results || []).map(r => r.name) });
      }

      if (pathname === '/api/admin/table-data' && request.method === 'GET') {
        const tableName = (url.searchParams.get('table') || '').trim();
        const allowedTables = ['locations', 'cameras', 'users'];

        if (!allowedTables.includes(tableName)) {
          return jsonResponse({ error: 'Unauthorized or invalid table name.' }, 400);
        }

        const schemaQuery = await env.DB.prepare(`PRAGMA table_info(${tableName})`).all();
        const rowsQuery = await env.DB.prepare(`SELECT * FROM ${tableName} LIMIT 100`).all();

        return jsonResponse({
          columns: schemaQuery.results || [],
          rows: rowsQuery.results || []
        });
      }

      if (pathname === '/api/admin/update-row' && request.method === 'POST') {
        const { table, pkColumn, pkValue, updates } = await request.json().catch(() => ({}));
        const allowedTables = ['locations', 'cameras', 'users'];

        if (!allowedTables.includes(table) || !pkColumn || pkValue === undefined || !updates) {
          return jsonResponse({ error: 'Malformed update payload.' }, 400);
        }

        // Exclude illegal columns
        const keys = Object.keys(updates).filter(k => k !== 'created_at');
        if (keys.length === 0) {
          return jsonResponse({ error: 'No fields to update.' }, 400);
        }

        const setClause = keys.map(k => `${k} = ?`).join(', ');
        const values = keys.map(k => updates[k]);
        values.push(pkValue);

        await env.DB.prepare(`UPDATE ${table} SET ${setClause} WHERE ${pkColumn} = ?`)
          .bind(...values)
          .run();

        return jsonResponse({ success: true });
      }

      // ------------------------------------------------------------
      // 4. STATIC ASSET / SPA DISPATCH
      // ------------------------------------------------------------
      if (env.ASSETS) {
        return await env.ASSETS.fetch(request);
      }

      return new Response('AISYS Edge API operational.', { status: 200 });

    } catch (err) {
      return jsonResponse({ error: err.message || 'Internal Edge Runtime Error' }, 500);
    }
  }
};

// ============================================================
// HELPER UTILITIES
// ============================================================

async function verifyPassword(inputPassword, storedHash) {
  if (!inputPassword || !storedHash) return false;
  
  // 1. Plaintext direct match
  if (storedHash === inputPassword) return true;

  // 2. SHA-256 hex match
  const encoder = new TextEncoder();
  const data = encoder.encode(inputPassword);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return storedHash.toLowerCase() === hashHex.toLowerCase();
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}

function handleCors() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400'
    }
  });
}

function generatePlaceholderSvg(location, camera) {
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
    <rect width="100%" height="100%" fill="#0a0f1d"/>
    <rect x="2" y="2" width="636" height="356" fill="none" stroke="#1e293b" stroke-width="2"/>
    <circle cx="320" cy="150" r="32" fill="none" stroke="#38bdf8" stroke-width="3" opacity="0.6"/>
    <circle cx="320" cy="150" r="8" fill="#38bdf8" opacity="0.8"/>
    <text x="320" y="215" fill="#f8fafc" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="15" font-weight="600" text-anchor="middle">Awaiting Snapshot</text>
    <text x="320" y="240" fill="#64748b" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="12" text-anchor="middle">${location} / ${camera}</text>
  </svg>
  `.trim();
}
