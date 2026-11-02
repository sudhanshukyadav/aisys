document.addEventListener('DOMContentLoaded', () => {
  const sessionRaw = sessionStorage.getItem('aisys_session');
  if (!sessionRaw) {
    window.location.href = '/';
    return;
  }

  const user = JSON.parse(sessionRaw);
  const locationBadge = document.getElementById('locationBadge');
  const userPill = document.getElementById('userPill');
  const cameraGrid = document.getElementById('cameraGrid');
  const logoutBtn = document.getElementById('logoutBtn');

  // Display user & location metadata
  locationBadge.textContent = `${user.locationId} — ${user.location?.description || 'Active Facility'}`;
  userPill.textContent = `${user.username} (${user.role})`;

  // Logout handler
  logoutBtn.addEventListener('click', () => {
    sessionStorage.removeItem('aisys_session');
    window.location.href = '/';
  });

  // Render camera tiles
  const cameras = user.cameras || [];
  if (cameras.length === 0) {
    cameraGrid.innerHTML = `
      <div class="no-cams-alert">
        <h3>No Authorized Cameras</h3>
        <p>No video channels have been assigned to your profile for this location.</p>
      </div>
    `;
    return;
  }

  // Adjust default grid layout based on camera count
  if (cameras.length > 4) {
    setGrid(3);
  } else if (cameras.length > 1) {
    setGrid(2);
  } else {
    setGrid(1);
  }

// Inside public/live.js -> camera rendering loop:
cameras.forEach((cam, index) => {
    const tile = document.createElement('div');
    tile.className = 'camera-tile';
    tile.id = `tile-${cam.camera_id}`;

    tile.innerHTML = `
      <div class="camera-tile-header">
        <span class="cam-status-dot" id="dot-${index}"></span>
        <span class="cam-name">${cam.name} (${cam.camera_id})</span>
        <button type="button" class="fullscreen-tile-btn" title="Toggle Fullscreen">⛶</button>
      </div>
      <div class="video-container" id="video-container-${index}">
        <video id="video-${index}" playsinline autoplay muted></video>
      </div>
    `;

    cameraGrid.appendChild(tile);

    const videoEl = tile.querySelector(`#video-${index}`);
    const statusDot = tile.querySelector(`#dot-${index}`);

    // Pure dynamic URL — no database column required
    const streamEndpoint = `https://stream.aisys.cam/${user.locationId}/live/${cam.camera_id}/index.m3u8`;

    initLiveHlsPlayer(videoEl, statusDot, streamEndpoint);

    tile.querySelector('.fullscreen-tile-btn').addEventListener('click', () => {
      if (!document.fullscreenElement) {
        tile.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });
  });

  // Grid layout selector buttons
  document.querySelectorAll('.grid-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.grid-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      setGrid(parseInt(btn.dataset.grid, 10));
    });
  });

  function setGrid(columns) {
    cameraGrid.className = `camera-grid grid-${columns}`;
    document.querySelectorAll('.grid-btn').forEach(b => {
      b.classList.toggle('active', parseInt(b.dataset.grid, 10) === columns);
    });
  }

  function mountPlayer(container, url) {
    if (!url) {
      container.innerHTML = '<div class="stream-error">Stream URL Missing</div>';
      return;
    }

    // 1. Cloudflare Stream Iframe Embed
    if (url.includes('iframe.videodelivery.net')) {
      const iframe = document.createElement('iframe');
      iframe.src = `${url}?autoplay=true&muted=true&controls=true&preload=auto`;
      iframe.className = 'stream-player';
      iframe.allow = 'accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture;';
      iframe.allowFullscreen = true;
      container.appendChild(iframe);
      return;
    }

    // 2. Direct Video Element for HLS / MP4
    const video = document.createElement('video');
    video.className = 'stream-player';
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.controls = true;
    container.appendChild(video);

    // If HLS (.m3u8), initialize HLS.js
    if (url.includes('.m3u8')) {
      if (Hls.isSupported()) {
        const hls = new Hls({ lowLatencyMode: true, backBufferLength: 30 });
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, () => {
          video.poster = '';
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Native Safari/iOS HLS
        video.src = url;
      }
    } else {
      // Standard MP4 or direct video stream
      video.src = url;
    }
  }
});
