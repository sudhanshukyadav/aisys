export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCors();
    }

    try {
      // ------------------------------------------------------------
      // 1. AUTHENTICATION & LOGIN (/api/auth/login or /api/login)
      // ------------------------------------------------------------
      if ((pathname === '/api/auth/login' || pathname === '/api/login') && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const rawLoc = (body.locationId || body.locationCode || body.location || '').trim();
        const username = (body.username || body.operator || body.user || '').trim();
        const password = String(body.password || '').trim();

        if (!rawLoc || !username || !password) {
          return jsonResponse({ error: 'Location code, username, and password are required.' }, 400);
        }

        const locUpper = rawLoc.toUpperCase();
        const locFlipped = locUpper.includes('-') ? locUpper.split('-').reverse().join('-') : locUpper;

        // Query user from D1
        const user = await env.DB.prepare(
          `SELECT * FROM users 
           WHERE (UPPER(location_id) = ? OR UPPER(location_id) = ?) 
             AND LOWER(username) = LOWER(?) 
           LIMIT 1`
        ).bind(locUpper, locFlipped, username).first();

        if (!user) {
          return jsonResponse({ error: 'Invalid location or username.' }, 401);
        }

        const isPasswordValid = await verifyPassword(password, user.password_hash);
        if (!isPasswordValid) {
          return jsonResponse({ error: 'Incorrect password.' }, 401);
        }

        const actualLocId = user.location_id;

        // Facility details
        const locationMeta = await env.DB.prepare(
          `SELECT location_id, description, address FROM locations WHERE location_id = ?`
        ).bind(actualLocId).first() || { location_id: actualLocId, description: 'Active Facility' };

        // Facility cameras
        const cameraRecords = await env.DB.prepare(
          `SELECT camera_id, location_id, name FROM cameras WHERE location_id = ? ORDER BY camera_id ASC`
        ).bind(actualLocId).all();

        const allCameras = cameraRecords.results || [];

        // Camera permissions
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
            allowedLower.includes(String(cam.camera_id).toLowerCase()) ||
            allowedLower.includes((cam.name || '').toLowerCase())
          );
        }

        return jsonResponse({
          success: true,
          token: `session_${user.user_id}_${Date.now()}`,
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
      // 2. UNIFIED SNAPSHOT RETRIEVAL (/api/snapshot/latest)
      // ------------------------------------------------------------
      if (pathname === '/api/snapshot/latest' && request.method === 'GET') {
        const rawLoc = (url.searchParams.get('location') || '').trim();
        const rawCam = (url.searchParams.get('cam') || url.searchParams.get('camera') || '').trim();

        if (!rawLoc || !rawCam) {
          return jsonResponse({ error: 'Parameters "location" and "cam" are required.' }, 400);
        }

        const locUpper = rawLoc.toUpperCase();
        const camTargets = new Set([rawCam, rawCam.toLowerCase(), rawCam.toUpperCase()]);

        // Resolve camera name <-> ID in D1
        if (env.DB) {
          try {
            const camRow = await env.DB.prepare(
              `SELECT camera_id, name FROM cameras 
               WHERE (camera_id = ? OR LOWER(name) = LOWER(?))
                 AND UPPER(location_id) = ? 
               LIMIT 1`
            ).bind(rawCam, rawCam, locUpper).first();

            if (camRow) {
              if (camRow.name) camTargets.add(camRow.name);
              if (camRow.camera_id) camTargets.add(String(camRow.camera_id));
            }
          } catch (e) {
            // Continue to R2 scan even if D1 is temporarily busy
          }
        }

        // Search both folder and flat-file conventions under HQ-AD/snapshots/
        let candidates = [];
        for (const target of camTargets) {
          const prefix = `${locUpper}/snapshots/${target}`;
          const list = await env.MEDIA_BUCKET.list({ prefix, limit: 100 });

          if (list.objects && list.objects.length > 0) {
            const matches = list.objects.filter(obj => {
              if (!/\.(jpe?g|png|webp)$/i.test(obj.key)) return false;
              // Matches: snapshots/apcam/..., snapshots/apcam.jpg, snapshots/apcam_*.jpg
              const regex = new RegExp(`[/_.-]|^${target}`, 'i');
              return regex.test(obj.key);
            });
            candidates.push(...matches);
          }
        }

        // Return a clean 200 SVG placeholder if no snapshot exists yet
        if (candidates.length === 0) {
          return new Response(generatePlaceholderSvg(locUpper, rawCam), {
            status: 200,
            headers: {
              'Content-Type': 'image/svg+xml',
              'Cache-Control': 'no-cache, no-store, must-revalidate',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }

        // Sort by upload timestamp descending (newest first)
        candidates.sort((a, b) => new Date(b.uploaded).getTime() - new Date(a.uploaded).getTime());
        const newestKey = candidates[0].key;

        const object = await env.MEDIA_BUCKET.get(newestKey);
        if (!object) {
          return jsonResponse({ error: 'Snapshot object missing from storage' }, 404);
        }

        const headers = new Headers();
        headers.set('Content-Type', object.httpMetadata?.contentType || 'image/jpeg');
        headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        headers.set('ETag', object.httpEtag);
        headers.set('Access-Control-Allow-Origin', '*');

        return new Response(object.body, { headers });
      }

      // ------------------------------------------------------------
      // 3. STATIC ASSETS & CLEAN ROUTING
      // ------------------------------------------------------------
      if (env.ASSETS) {
        let response = await env.ASSETS.fetch(request);
        if (response.status === 404 && !pathname.includes('.')) {
          const htmlUrl = new URL(request.url);
          htmlUrl.pathname = `${pathname}.html`;
          const htmlResponse = await env.ASSETS.fetch(new Request(htmlUrl, request));
          if (htmlResponse.status === 200) {
            return htmlResponse;
          }
        }
        return response;
      }

      return new Response('AISYS Edge API operational.', { status: 200 });

    } catch (err) {
      return jsonResponse({ error: err.message || 'Internal Edge Runtime Error' }, 500);
    }
  }
};

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------

async function verifyPassword(inputPassword, storedHash) {
  if (!inputPassword || !storedHash) return false;
  if (storedHash === inputPassword) return true;

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
