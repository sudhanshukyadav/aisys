document.addEventListener('DOMContentLoaded', () => {
  let currentUserSession = null;
  let cachedTables = {};
  let currentActiveTable = 'locations';

  const securityBtn = document.getElementById('securityBtn');
  const securityModal = document.getElementById('securityModal');
  const modalClose = document.getElementById('modalClose');
  const loginForm = document.getElementById('loginForm');
  const loginErr = document.getElementById('loginErr');
  const loginSubmitBtn = document.getElementById('loginSubmitBtn');

  const adminModal = document.getElementById('adminModal');
  const adminModalClose = document.getElementById('adminModalClose');
  const adminDataTable = document.getElementById('adminDataTable');
  const recordDrawer = document.getElementById('recordDrawer');
  const recordForm = document.getElementById('recordForm');
  const recordFormFields = document.getElementById('recordFormFields');
  const drawerTitle = document.getElementById('drawerTitle');

  // Open & Close Security Modal
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

  // Login Authentication Handler
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

          if (data.user.role === 'admin') {
            openAdminExplorer();
          } else {
            alert(`Welcome ${data.user.username} (${data.user.role}). Authorized cameras: ${data.user.cameras.length}`);
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

  // Admin Explorer Logic
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
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;">No records in ${currentActiveTable}</td></tr>`;
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
        { name: 'password', label: record ? 'Change Password (optional)' : 'Password', val: '', isPassword: true }
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
