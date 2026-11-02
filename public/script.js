document.addEventListener('DOMContentLoaded', () => {
  let currentUserSession = null;
  let cachedTables = {};
  let currentActiveTable = 'locations';

  // --- Element Selectors ---
  const securityBtn = document.getElementById('securityBtn');
  const securityModal = document.getElementById('securityModal');
  const modalClose = document.getElementById('modalClose');
  const loginForm = document.getElementById('loginForm');
  const loginErr = document.getElementById('loginErr');
  const loginSubmitBtn = document.getElementById('loginSubmitBtn');

  const waitlistForm = document.getElementById('waitlistForm');
  const waitlistEmail = document.getElementById('waitlistEmail');
  const waitlistSubmitBtn = document.getElementById('waitlistSubmitBtn');
  const waitlistMsg = document.getElementById('waitlistMsg');

  const adminModal = document.getElementById('adminModal');
  const adminModalClose = document.getElementById('adminModalClose');
  const adminDataTable = document.getElementById('adminDataTable');
  const recordDrawer = document.getElementById('recordDrawer');
  const recordForm = document.getElementById('recordForm');
  const recordFormFields = document.getElementById('recordFormFields');
  const drawerTitle = document.getElementById('drawerTitle');

  // --- Waitlist Handler ---
  if (waitlistForm) {
    waitlistForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      waitlistSubmitBtn.disabled = true;
      waitlistMsg.textContent = 'Submitting...';
      waitlistMsg.style.color = '#38bdf8';

      try {
        const res = await fetch('/api/waitlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: waitlistEmail.value })
        });
        const data = await res.json();
        if (res.ok) {
          waitlistMsg.textContent = data.message || 'You are on the list!';
          waitlistMsg.style.color = '#4ade80';
          waitlistEmail.value = '';
        } else {
          waitlistMsg.textContent = data.error || 'Failed to submit.';
          waitlistMsg.style.color = '#f87171';
        }
      } catch (err) {
        waitlistMsg.textContent = 'Network error.';
        waitlistMsg.style.color = '#f87171';
      } finally {
        waitlistSubmitBtn.disabled = false;
      }
    });
  }

  // --- Modal Open/Close Controls ---
  if (securityBtn) {
    securityBtn.addEventListener('click', (e) => {
      e.preventDefault();
      securityModal.classList.add('open');
      loginErr.textContent = '';
    });
  }
  if (modalClose) {
    modalClose.addEventListener('click', () => securityModal.classList.remove('open'));
  }
  if (adminModalClose) {
    adminModalClose.addEventListener('click', () => adminModal.classList.remove('open'));
  }

  window.addEventListener('click', (e) => {
    if (e.target === securityModal) securityModal.classList.remove('open');
    if (e.target === adminModal) adminModal.classList.remove('open');
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      securityModal.classList.remove('open');
      adminModal.classList.remove('open');
    }
  });

  // --- Login Handler ---
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      loginErr.textContent = '';
      loginSubmitBtn.disabled = true;
      loginSubmitBtn.textContent = 'Authenticating...';

      const payload = {
        locationId: document.getElementById('locationId').value,
        username: document.getElementById('username').value,
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
          securityModal.classList.remove('open');

         // Store user session data in browser
        sessionStorage.setItem('aisys_session', JSON.stringify(data.user));

        if (data.user.role === 'admin') {
        // If admin has configured cameras, ask whether to open streams or database editor
          if (confirm('Authentication successful. Open Live Video Stream view?\n(Cancel opens Database Explorer)')) {
           window.location.href = '/live.html';
          } else {
            openAdminExplorer();
          }
} else {
  // Direct operators and viewers straight to live monitor
  window.location.href = '/live.html';
}
        } else {
          loginErr.textContent = data.error || 'Authentication failed.';
        }
      } catch (err) {
        loginErr.textContent = 'Error connecting to database service.';
      } finally {
        loginSubmitBtn.disabled = false;
        loginSubmitBtn.textContent = 'Authenticate';
      }
    });
  }

  // --- Admin Explorer Controller ---
  async function openAdminExplorer() {
    adminModal.classList.add('open');
    await loadAdminTables();
  }

  async function loadAdminTables() {
    const res = await fetch('/api/admin/tables', {
      headers: { 'x-admin-userid': currentUserSession.userId }
    });
    const result = await res.json();
    if (result.success) {
      cachedTables = result.tables;
      renderCurrentTable();
    } else {
      alert(result.error);
    }
  }

  function renderCurrentTable() {
    const thead = adminDataTable.querySelector('thead');
    const tbody = adminDataTable.querySelector('tbody');
    thead.innerHTML = '';
    tbody.innerHTML = '';

    const rows = cachedTables[currentActiveTable] || [];
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 2rem;">No records in ${currentActiveTable}</td></tr>`;
      return;
    }

    const columns = Object.keys(rows[0]);
    thead.innerHTML = `<tr>${columns.map(c => `<th>${c}</th>`).join('')}<th>Actions</th></tr>`;

    tbody.innerHTML = rows.map((row, idx) => `
      <tr>
        ${columns.map(c => `<td>${escapeHtml(String(row[c] ?? ''))}</td>`).join('')}
        <td><button class="table-edit-btn" data-index="${idx}">Edit</button></td>
      </tr>
    `).join('');

    tbody.querySelectorAll('.table-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => openEditor(rows[btn.dataset.index]));
    });
  }

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentActiveTable = btn.dataset.table;
      recordDrawer.classList.add('hidden');
      renderCurrentTable();
    });
  });

  function openEditor(record = null) {
    recordDrawer.classList.remove('hidden');
    drawerTitle.textContent = record ? `Update ${currentActiveTable} Record` : `Append to ${currentActiveTable}`;
    recordForm.dataset.isUpdate = record ? 'true' : 'false';

    let fields = [];
    if (currentActiveTable === 'locations') {
      fields = [
        { name: 'location_id', label: 'Location ID', val: record?.location_id || '', readOnly: !!record },
        { name: 'description', label: 'Description', val: record?.description || '' },
        { name: 'address', label: 'Address', val: record?.address || '' }
      ];
    } else if (currentActiveTable === 'cameras') {
      fields = [
        { name: 'camera_id', label: 'Camera ID', val: record?.camera_id || '', readOnly: !!record },
        { name: 'location_id', label: 'Location ID', val: record?.location_id || '' },
        { name: 'name', label: 'Camera Name', val: record?.name || '' },
        { name: 'stream_url', label: 'Stream URL', val: record?.stream_url || '' }
      ];
    } else if (currentActiveTable === 'users') {
      fields = [
        { name: 'location_id', label: 'Location ID', val: record?.location_id || '', readOnly: !!record },
        { name: 'username', label: 'Username', val: record?.username || '', readOnly: !!record },
        { name: 'role', label: 'Role (admin/superuser/operator/viewer)', val: record?.role || 'viewer' },
        { name: 'allowed_cameras', label: 'Allowed Cameras (JSON array)', val: record?.allowed_cameras || '[]' },
        { name: 'password', label: record ? 'Change Password (leave blank to keep)' : 'Password', val: '', isPassword: true }
      ];
    }

    recordFormFields.innerHTML = fields.map(f => `
      <div class="form-group">
        <label>${f.label}</label>
        <input 
          type="${f.isPassword ? 'password' : 'text'}" 
          name="${f.name}" 
          value="${escapeHtml(f.val)}" 
          ${f.readOnly ? 'readonly style="opacity:0.6"' : 'required'} 
        />
      </div>
    `).join('');
  }

  document.getElementById('addRowBtn').addEventListener('click', () => openEditor(null));
  document.getElementById('cancelDrawerBtn').addEventListener('click', () => recordDrawer.classList.add('hidden'));
  document.getElementById('refreshTablesBtn').addEventListener('click', loadAdminTables);

  recordForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(recordForm);
    const dataObj = {};
    formData.forEach((val, key) => { dataObj[key] = val; });

    const isUpdate = recordForm.dataset.isUpdate === 'true';

    const res = await fetch('/api/admin/tables/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-userid': currentUserSession.userId
      },
      body: JSON.stringify({
        table: currentActiveTable,
        data: dataObj,
        isUpdate
      })
    });

    const result = await res.json();
    if (result.success) {
      recordDrawer.classList.add('hidden');
      await loadAdminTables();
    } else {
      alert(result.error);
    }
  });

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
});
