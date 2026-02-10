// ============================================================
// Provisions Deadline Dashboard — Client JS
// Supabase-backed, no framework, real-time updates
// ============================================================

// --- Configuration ---
const SUPABASE_URL = 'https://pzqeibaqlwmfglbiumjt.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB6cWVpYmFxbHdtZmdsYml1bWp0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ3NTU4MTgsImV4cCI6MjA4MDMzMTgxOH0.3_VThVzxBC9E1myb4_vclLt16660Pdn-C6ZI-kKiSsU';

// Wait for Supabase SDK to load (handles slow mobile connections)
let sb;
function initSupabase() {
  if (window.supabase && window.supabase.createClient) {
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return true;
  }
  return false;
}

// --- State ---
let currentUser = null;
let projects = [];
let editingProjectId = null;
let countdownInterval = null;

// --- Standard milestone template (days before deadline) ---
const MILESTONE_TEMPLATE = [
  { title: 'Questions Due', daysBeforeDeadline: 10 },
  { title: 'Team Assignments', daysBeforeDeadline: 8 },
  { title: 'Draft Complete', daysBeforeDeadline: 5 },
  { title: 'Internal Review', daysBeforeDeadline: 3 },
  { title: 'Final Edits', daysBeforeDeadline: 2 },
  { title: 'Final Submit', daysBeforeDeadline: 0 },
];

// --- Standard checklist items ---
const DEFAULT_CHECKLIST = [
  'Capability Statement',
  'Past Performance References',
  'Technical Approach',
  'Price/Cost Proposal',
  'SAM.gov Registration Verified',
  'Subcontracting Plan (if applicable)',
];

// --- DOM refs ---
const $ = (id) => document.getElementById(id);

const loginOverlay = $('loginOverlay');
const loginForm = $('loginForm');
const loginError = $('loginError');
const loginBtn = $('loginBtn');
const dashboardApp = $('dashboardApp');
const currentUserEl = $('currentUser');
const logoutBtn = $('logoutBtn');
const projectsGrid = $('projectsGrid');
const loadingSpinner = $('loadingSpinner');
const addProjectBtn = $('addProjectBtn');
const modalOverlay = $('modalOverlay');
const modalTitle = $('modalTitle');
const modalClose = $('modalClose');
const modalCancel = $('modalCancel');
const modalSave = $('modalSave');
const projectForm = $('projectForm');

// Urgency counters
const countOverdue = $('countOverdue');
const countDue7 = $('countDue7');
const countDue14 = $('countDue14');
const countActive = $('countActive');

// ============================================================
// Auth
// ============================================================

function checkAuth() {
  // onAuthStateChange is the sole auth handler.
  // INITIAL_SESSION fires after Supabase processes OAuth tokens from the URL hash,
  // which avoids the race condition where getSession() returns null before tokens are parsed.
  sb.auth.onAuthStateChange((event, session) => {
    if ((event === 'INITIAL_SESSION' || event === 'SIGNED_IN') && session) {
      if (!currentUser) {
        currentUser = session.user;
        showDashboard();
      }
    } else if (event === 'SIGNED_OUT' || (event === 'INITIAL_SESSION' && !session)) {
      currentUser = null;
      projects = [];
      if (countdownInterval) clearInterval(countdownInterval);
      showLogin();
    }
  });
}

function showLogin() {
  loginOverlay.style.display = 'flex';
  dashboardApp.classList.remove('visible');
}

async function showDashboard() {
  loginOverlay.style.display = 'none';
  dashboardApp.classList.add('visible');
  currentUserEl.textContent = currentUser.email.split('@')[0];
  await loadProjects();
  setupRealtimeSubscriptions();
  startCountdownTimer();
}

// Google OAuth login
$('googleLoginBtn').addEventListener('click', async () => {
  loginError.textContent = '';
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin + window.location.pathname,
    },
  });
  if (error) {
    loginError.textContent = error.message;
  }
});

// Email/password login
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  loginBtn.disabled = true;
  loginBtn.textContent = 'Signing in...';

  const email = $('loginEmail').value.trim();
  const password = $('loginPassword').value;

  const { data, error } = await sb.auth.signInWithPassword({ email, password });

  if (error) {
    loginError.textContent = error.message;
    loginBtn.disabled = false;
    loginBtn.textContent = 'Sign In';
    return;
  }

  currentUser = data.user;
  showDashboard();
});

logoutBtn.addEventListener('click', async () => {
  await sb.auth.signOut();
  currentUser = null;
  projects = [];
  if (countdownInterval) clearInterval(countdownInterval);
  showLogin();
});

// ============================================================
// Data Loading
// ============================================================

async function loadProjects() {
  const { data, error } = await sb
    .from('projects')
    .select(`
      *,
      milestones ( * ),
      checklist_items ( * )
    `)
    .in('status', ['active', 'submitted'])
    .order('response_deadline', { ascending: true });

  if (error) {
    console.error('Failed to load projects:', error);
    return;
  }

  projects = data || [];

  // Sort milestones and checklist by sort_order
  for (const p of projects) {
    if (p.milestones) p.milestones.sort((a, b) => a.sort_order - b.sort_order);
    if (p.checklist_items) p.checklist_items.sort((a, b) => a.sort_order - b.sort_order);
  }

  renderProjects();
  updateUrgencyCounts();
}

// ============================================================
// Real-time Subscriptions
// ============================================================

function setupRealtimeSubscriptions() {
  sb
    .channel('dashboard-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, () => loadProjects())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'milestones' }, () => loadProjects())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'checklist_items' }, () => loadProjects())
    .subscribe();
}

// ============================================================
// Rendering
// ============================================================

function getDaysUntil(deadline) {
  const now = new Date();
  const dl = new Date(deadline);
  return Math.ceil((dl - now) / 86400000);
}

function getUrgencyClass(daysLeft) {
  if (daysLeft < 0) return 'urgency-overdue';
  if (daysLeft <= 7) return 'urgency-red';
  if (daysLeft <= 14) return 'urgency-yellow';
  if (daysLeft <= 30) return 'urgency-green';
  return 'urgency-navy';
}

function formatCountdown(daysLeft) {
  if (daysLeft < 0) return { number: Math.abs(daysLeft), label: 'days overdue' };
  if (daysLeft === 0) return { number: 'TODAY', label: 'deadline' };
  if (daysLeft === 1) return { number: '1', label: 'day left' };
  return { number: daysLeft, label: 'days left' };
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function renderProjects() {
  if (loadingSpinner) loadingSpinner.remove();

  if (projects.length === 0) {
    projectsGrid.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <i class="fas fa-folder-open"></i>
        <h3>No Active Projects</h3>
        <p>Add your first project to start tracking deadlines.</p>
        <button class="add-project-btn" onclick="openAddModal()">
          <i class="fas fa-plus"></i> Add Project
        </button>
      </div>
    `;
    return;
  }

  projectsGrid.innerHTML = projects.map((p) => {
    const daysLeft = getDaysUntil(p.response_deadline);
    const urgency = getUrgencyClass(daysLeft);
    const countdown = formatCountdown(daysLeft);
    const deadlineDate = formatDate(p.response_deadline);
    const ownerClass = (p.owner || 'Chris').toLowerCase();

    const milestonesHtml = (p.milestones || []).map((m) => {
      const mDaysLeft = getDaysUntil(m.due_date);
      const dateClass = !m.completed && mDaysLeft < 0 ? 'overdue' : '';
      return `
        <div class="milestone-item ${m.completed ? 'completed' : ''}">
          <input type="checkbox" ${m.completed ? 'checked' : ''}
                 onchange="toggleMilestone('${m.id}', this.checked)" />
          <span>${escapeHtml(m.title)}</span>
          <span class="milestone-date ${dateClass}">${formatDate(m.due_date)}</span>
        </div>
      `;
    }).join('');

    const checklistHtml = (p.checklist_items || []).map((c) => `
      <div class="checklist-item ${c.completed ? 'completed' : ''}">
        <input type="checkbox" ${c.completed ? 'checked' : ''}
               onchange="toggleChecklist('${c.id}', this.checked)" />
        <span>${escapeHtml(c.label)}</span>
      </div>
    `).join('');

    const completedMilestones = (p.milestones || []).filter(m => m.completed).length;
    const totalMilestones = (p.milestones || []).length;
    const completedChecklist = (p.checklist_items || []).filter(c => c.completed).length;
    const totalChecklist = (p.checklist_items || []).length;

    return `
      <div class="project-card ${urgency}" data-project-id="${p.id}">
        <div class="card-header">
          <div class="card-header-left">
            <h3>${escapeHtml(p.title)}</h3>
            ${p.agency ? `<div class="card-agency">${escapeHtml(p.agency)}</div>` : ''}
            ${p.solicitation_number ? `<div class="card-sol">${escapeHtml(p.solicitation_number)}</div>` : ''}
          </div>
          <div class="card-actions">
            <button onclick="openEditModal('${p.id}')" title="Edit"><i class="fas fa-pen"></i></button>
            ${p.sam_link ? `<button onclick="window.open('${escapeHtml(p.sam_link)}', '_blank')" title="SAM.gov"><i class="fas fa-external-link-alt"></i></button>` : ''}
          </div>
        </div>

        <div class="card-countdown">
          <div class="countdown-number" data-deadline="${p.response_deadline}">${countdown.number}</div>
          <div class="countdown-label">${countdown.label} &middot; ${deadlineDate}</div>
        </div>

        <div class="card-meta">
          <div class="meta-item">
            <i class="fas fa-user"></i>
            <span class="owner-badge ${ownerClass}">${escapeHtml(p.owner || 'Chris')}</span>
          </div>
          ${p.priority && p.priority !== 'normal' ? `
            <div class="meta-item">
              <i class="fas fa-flag"></i>
              <span style="font-weight: 700; text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.5px; color: ${p.priority === 'critical' ? 'var(--accent-red)' : '#f59e0b'};">${p.priority}</span>
            </div>
          ` : ''}
          ${p.estimated_value ? `
            <div class="meta-item"><i class="fas fa-dollar-sign"></i> ${escapeHtml(p.estimated_value)}</div>
          ` : ''}
        </div>

        ${totalMilestones > 0 ? `
          <div class="card-section">
            <div class="card-section-title">Milestones (${completedMilestones}/${totalMilestones})</div>
            ${milestonesHtml}
          </div>
        ` : ''}

        ${totalChecklist > 0 ? `
          <div class="card-section">
            <div class="card-section-title">Documents (${completedChecklist}/${totalChecklist})</div>
            ${checklistHtml}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

function updateUrgencyCounts() {
  let overdue = 0, due7 = 0, due14 = 0, active = 0;
  for (const p of projects) {
    const days = getDaysUntil(p.response_deadline);
    active++;
    if (days < 0) overdue++;
    else if (days <= 7) due7++;
    else if (days <= 14) due14++;
  }
  countOverdue.textContent = overdue;
  countDue7.textContent = due7;
  countDue14.textContent = due14;
  countActive.textContent = active;
}

// ============================================================
// Countdown Timer — updates every minute
// ============================================================

function startCountdownTimer() {
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    document.querySelectorAll('.countdown-number[data-deadline]').forEach((el) => {
      const deadline = el.getAttribute('data-deadline');
      const daysLeft = getDaysUntil(deadline);
      const countdown = formatCountdown(daysLeft);
      el.textContent = countdown.number;
      const labelEl = el.nextElementSibling;
      if (labelEl) {
        labelEl.innerHTML = `${countdown.label} &middot; ${formatDate(deadline)}`;
      }
    });
    updateUrgencyCounts();
  }, 60000);
}

// ============================================================
// Toggle Milestone / Checklist
// ============================================================

async function toggleMilestone(id, completed) {
  const updates = { completed, completed_at: completed ? new Date().toISOString() : null };
  const { error } = await sb.from('milestones').update(updates).eq('id', id);
  if (error) console.error('Failed to update milestone:', error);
  await logActivity(null, completed ? 'Milestone completed' : 'Milestone unchecked', id);
}

async function toggleChecklist(id, completed) {
  const updates = { completed, completed_at: completed ? new Date().toISOString() : null };
  const { error } = await sb.from('checklist_items').update(updates).eq('id', id);
  if (error) console.error('Failed to update checklist:', error);
}

// Make globally accessible for inline handlers
window.toggleMilestone = toggleMilestone;
window.toggleChecklist = toggleChecklist;

// ============================================================
// Modal — Add / Edit
// ============================================================

function openAddModal() {
  editingProjectId = null;
  modalTitle.textContent = 'Add Project';
  projectForm.reset();
  $('formProjectId').value = '';
  $('formOwner').value = 'Chris';
  $('formPriority').value = 'normal';
  $('milestonesSection').style.display = 'none';
  $('checklistSection').style.display = 'none';
  $('deleteSection').style.display = 'none';
  modalSave.textContent = 'Save Project';
  modalOverlay.classList.add('visible');
}

async function openEditModal(projectId) {
  const project = projects.find((p) => p.id === projectId);
  if (!project) return;

  editingProjectId = projectId;
  modalTitle.textContent = 'Edit Project';
  $('formProjectId').value = projectId;
  $('formTitle').value = project.title || '';
  $('formAgency').value = project.agency || '';
  $('formSolicitation').value = project.solicitation_number || '';
  $('formOwner').value = project.owner || 'Chris';
  $('formPriority').value = project.priority || 'normal';
  $('formEstValue').value = project.estimated_value || '';
  $('formNaics').value = project.naics_code || '';
  $('formSetAside').value = project.set_aside || '';
  $('formSamLink').value = project.sam_link || '';
  $('formNotes').value = project.notes || '';

  // Format deadline for datetime-local input
  if (project.response_deadline) {
    const dl = new Date(project.response_deadline);
    const offset = dl.getTimezoneOffset();
    const local = new Date(dl.getTime() - offset * 60000);
    $('formDeadline').value = local.toISOString().slice(0, 16);
  }

  // Show milestones editor
  renderMilestonesEditor(project.milestones || []);
  $('milestonesSection').style.display = 'block';

  // Show checklist editor
  renderChecklistEditor(project.checklist_items || []);
  $('checklistSection').style.display = 'block';

  // Show delete section
  $('deleteSection').style.display = 'block';

  modalSave.textContent = 'Update Project';
  modalOverlay.classList.add('visible');
}

window.openAddModal = openAddModal;
window.openEditModal = openEditModal;

function renderMilestonesEditor(milestones) {
  const container = $('milestonesEditor');
  container.innerHTML = milestones.map((m) => {
    const dateVal = m.due_date ? m.due_date.slice(0, 10) : '';
    return `
    <div class="milestone-item" style="padding: 6px 0; display: flex; align-items: center; gap: 8px;">
      <input type="checkbox" ${m.completed ? 'checked' : ''} disabled />
      <span style="flex: 1;">${escapeHtml(m.title)}</span>
      <input type="date" value="${dateVal}" onchange="updateMilestoneDate('${m.id}', this.value)"
             style="padding: 4px 8px; border: 1px solid #e5e7eb; border-radius: 4px; font-size: 0.85rem; font-family: 'Inter', sans-serif;" />
    </div>`;
  }).join('');
}

async function updateMilestoneDate(id, dateStr) {
  if (!dateStr) return;
  const { error } = await sb.from('milestones').update({ due_date: new Date(dateStr).toISOString() }).eq('id', id);
  if (error) console.error('Failed to update milestone date:', error);
  await logActivity(null, 'Milestone date updated', id);
  await loadProjects();
}
window.updateMilestoneDate = updateMilestoneDate;

function renderChecklistEditor(items) {
  const container = $('checklistEditor');
  container.innerHTML = items.map((c) => `
    <div class="checklist-item" style="padding: 4px 0;">
      <input type="checkbox" ${c.completed ? 'checked' : ''} disabled />
      <span>${escapeHtml(c.label)}</span>
      <button type="button" onclick="deleteChecklistItem('${c.id}')"
              style="margin-left: auto; background: none; border: none; color: #9ca3af; cursor: pointer; font-size: 0.8rem;"
              title="Remove">&times;</button>
    </div>
  `).join('');
}

async function deleteChecklistItem(id) {
  const { error } = await sb.from('checklist_items').delete().eq('id', id);
  if (error) {
    console.error('Failed to delete checklist item:', error);
    return;
  }
  await loadProjects();
  if (editingProjectId) {
    const project = projects.find((p) => p.id === editingProjectId);
    if (project) renderChecklistEditor(project.checklist_items || []);
  }
}

window.deleteChecklistItem = deleteChecklistItem;

// Add checklist item button
$('addChecklistBtn').addEventListener('click', async () => {
  if (!editingProjectId) return;
  const input = $('newChecklistItem');
  const label = input.value.trim();
  if (!label) return;

  const project = projects.find((p) => p.id === editingProjectId);
  const sortOrder = (project?.checklist_items?.length || 0);

  const { error } = await sb.from('checklist_items').insert({
    project_id: editingProjectId,
    label,
    sort_order: sortOrder,
  });

  if (error) {
    console.error('Failed to add checklist item:', error);
    return;
  }

  input.value = '';
  await loadProjects();
  const updatedProject = projects.find((p) => p.id === editingProjectId);
  if (updatedProject) renderChecklistEditor(updatedProject.checklist_items || []);
});

function closeModal() {
  modalOverlay.classList.remove('visible');
  editingProjectId = null;
}

modalClose.addEventListener('click', closeModal);
modalCancel.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

// --- Save / Update ---

modalSave.addEventListener('click', async () => {
  const title = $('formTitle').value.trim();
  const deadline = $('formDeadline').value;

  if (!title || !deadline) {
    alert('Title and Deadline are required.');
    return;
  }

  modalSave.disabled = true;
  modalSave.textContent = 'Saving...';

  const projectData = {
    title,
    agency: $('formAgency').value.trim() || null,
    solicitation_number: $('formSolicitation').value.trim() || null,
    response_deadline: new Date(deadline).toISOString(),
    owner: $('formOwner').value,
    priority: $('formPriority').value,
    estimated_value: $('formEstValue').value.trim() || null,
    naics_code: $('formNaics').value.trim() || null,
    set_aside: $('formSetAside').value.trim() || null,
    sam_link: $('formSamLink').value.trim() || null,
    notes: $('formNotes').value.trim() || null,
  };

  if (editingProjectId) {
    // Update existing
    const { error } = await sb.from('projects').update(projectData).eq('id', editingProjectId);
    if (error) {
      console.error('Failed to update project:', error);
      alert('Failed to update project. Check console for details.');
      modalSave.disabled = false;
      modalSave.textContent = 'Update Project';
      return;
    }
    await logActivity(editingProjectId, 'Project updated');
  } else {
    // Create new
    projectData.created_by = currentUser.id;

    const { data, error } = await sb.from('projects').insert(projectData).select().single();
    if (error) {
      console.error('Failed to create project:', error);
      alert('Failed to create project. Check console for details.');
      modalSave.disabled = false;
      modalSave.textContent = 'Save Project';
      return;
    }

    // Auto-generate milestones
    const deadlineDate = new Date(deadline);
    const milestones = MILESTONE_TEMPLATE.map((m, i) => {
      const dueDate = new Date(deadlineDate);
      dueDate.setDate(dueDate.getDate() - m.daysBeforeDeadline);
      return {
        project_id: data.id,
        title: m.title,
        due_date: dueDate.toISOString(),
        sort_order: i,
      };
    });

    const { error: mError } = await sb.from('milestones').insert(milestones);
    if (mError) console.error('Failed to create milestones:', mError);

    // Auto-generate checklist
    const checklistItems = DEFAULT_CHECKLIST.map((label, i) => ({
      project_id: data.id,
      label,
      sort_order: i,
    }));

    const { error: cError } = await sb.from('checklist_items').insert(checklistItems);
    if (cError) console.error('Failed to create checklist:', cError);

    await logActivity(data.id, 'Project created');
  }

  closeModal();
  await loadProjects();
  modalSave.disabled = false;
});

// --- Archive ---

$('archiveBtn').addEventListener('click', async () => {
  if (!editingProjectId) return;
  const project = projects.find((p) => p.id === editingProjectId);
  if (!confirm(`Archive "${project?.title}"? It will be hidden from the active dashboard.`)) return;

  const { error } = await sb.from('projects').update({ status: 'archived' }).eq('id', editingProjectId);
  if (error) {
    console.error('Failed to archive project:', error);
    alert('Failed to archive project.');
    return;
  }

  await logActivity(editingProjectId, 'Project archived');
  closeModal();
  await loadProjects();
});

// ============================================================
// Add Project Button (top toolbar)
// ============================================================

addProjectBtn.addEventListener('click', openAddModal);

// ============================================================
// Activity Log
// ============================================================

async function logActivity(projectId, action, details = null) {
  await sb.from('activity_log').insert({
    project_id: projectId,
    action,
    details,
    performed_by: currentUser?.id || null,
  });
}


// ============================================================
// Utils
// ============================================================

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================
// Init — wait for Supabase SDK then boot
// ============================================================

function boot() {
  if (!initSupabase()) {
    // SDK not loaded yet, retry
    setTimeout(boot, 50);
    return;
  }
  checkAuth();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
