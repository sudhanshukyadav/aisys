// --- LOGIN HANDLER ---
  const loginForm = document.getElementById('loginForm');
  const loginErr = document.getElementById('loginErr');
  const loginSubmitBtn = document.getElementById('loginSubmitBtn');
  const securityModal = document.getElementById('securityModal');

  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      loginErr.textContent = '';
      loginSubmitBtn.disabled = true;
      loginSubmitBtn.textContent = 'Authenticating...';

      const payload = {
        locationId: document.getElementById('locationId').value.trim().toUpperCase(),
        username: document.getElementById('username').value.trim().toLowerCase(),
        password: document.getElementById('password').value
      };

      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (res.ok && data.status === 'success') {
          currentUserSession = data.user;
          sessionStorage.setItem('aisys_session', JSON.stringify(data.user));
          securityModal.classList.remove('open');

          if (data.user.role === 'admin') {
            openAdminExplorer();
          } else {
            window.location.href = '/live.html';
          }
        } else {
          const detailMsg = data.details ? ` (${data.details})` : '';
          loginErr.textContent = (data.error || 'Authentication failed.') + detailMsg;
        }
      } catch (err) {
        loginErr.textContent = 'Network or connection error: ' + (err.message || String(err));
      } finally {
        loginSubmitBtn.disabled = false;
        loginSubmitBtn.textContent = 'Authenticate';
      }
    });
  }
