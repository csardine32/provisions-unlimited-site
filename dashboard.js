// ============================================================
// Provisions Opportunity Hub — Client JS
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
let currentView = null;
let scannerInitialized = false;
let projectsInitialized = false;
let adhocAnalyses = [];
let adhocInitialized = false;
let showAllAdhoc = false;
let pendingAdhocId = null;

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
  document.body.classList.remove('is-admin');
  currentView = null;
  scannerInitialized = false;
  projectsInitialized = false;
  adhocInitialized = false;
  adhocAnalyses = [];
  showAllAdhoc = false;
  pendingAdhocId = null;
}

async function showDashboard() {
  loginOverlay.style.display = 'none';
  dashboardApp.classList.add('visible');
  currentUserEl.textContent = currentUser.email.split('@')[0];

  // Set admin role on body
  document.body.classList.toggle('is-admin', isAdmin());

  // Setup real-time subscriptions once
  setupRealtimeSubscriptions();

  // Navigate to the hash route (defaults to scanner)
  const hash = window.location.hash.slice(1) || 'scanner';
  navigateTo(hash);
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
    .on('postgres_changes', { event: '*', schema: 'public', table: 'scanner_opportunities' }, () => loadTopOpportunities())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'opportunity_feedback' }, () => {
      loadUserFeedback().then(() => loadTopOpportunities());
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'opportunity_dismissals' }, () => {
      loadUserDismissals().then(() => loadTopOpportunities());
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'adhoc_analyses' }, () => {
      if (adhocInitialized) loadAdhocAnalyses();
    })
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
  pendingAdhocId = null;
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

    // Link adhoc analysis if this was a "pursue unmatched" flow
    if (pendingAdhocId) {
      await sb.from('adhoc_analyses').update({
        status: 'pursued',
        project_id: data.id,
      }).eq('id', pendingAdhocId);
      pendingAdhocId = null;
      loadAdhocAnalyses();
    }
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
// Top Opportunities Widget
// ============================================================

const topOppsSection = $('topOppsSection');
const topOppsToggle = $('topOppsToggle');
const topOppsBody = $('topOppsBody');
const topOppsCount = $('topOppsCount');
const topOppsTableBody = $('topOppsTableBody');
const dismissedLink = $('dismissedLink');

// Per-user state
let userDismissals = new Set();
let userFeedback = {};     // { notice_id: 'up'|'down' }
let userPreferences = null; // computed from feedback history
let allOpportunities = [];  // unfiltered list from Supabase

// Toggle collapse
if (topOppsToggle) {
  topOppsToggle.addEventListener('click', () => {
    topOppsSection.classList.toggle('collapsed');
  });
}

// --- Load user's dismissals and feedback ---

async function loadUserDismissals() {
  const { data } = await sb
    .from('opportunity_dismissals')
    .select('notice_id')
    .eq('user_id', currentUser.id);
  userDismissals = new Set((data || []).map(d => d.notice_id));
}

async function loadUserFeedback() {
  const { data } = await sb
    .from('opportunity_feedback')
    .select('notice_id, rating')
    .eq('user_id', currentUser.id);
  userFeedback = {};
  for (const row of (data || [])) {
    userFeedback[row.notice_id] = row.rating;
  }
  buildPreferences();
}

// --- Preference profile (client-side only) ---

function buildPreferences() {
  const liked = Object.entries(userFeedback).filter(([, r]) => r === 'up');
  if (liked.length < 2) { userPreferences = null; return; }

  const likedNoticeIds = new Set(liked.map(([id]) => id));
  const likedOpps = allOpportunities.filter(o => likedNoticeIds.has(o.notice_id));

  const agencyCounts = {};
  const naicsCounts = {};
  const setAsideCounts = {};

  for (const o of likedOpps) {
    if (o.agency) agencyCounts[o.agency] = (agencyCounts[o.agency] || 0) + 1;
    if (o.naics_code) naicsCounts[o.naics_code] = (naicsCounts[o.naics_code] || 0) + 1;
    if (o.set_aside) setAsideCounts[o.set_aside] = (setAsideCounts[o.set_aside] || 0) + 1;
  }

  // Consider a preference "signal" if it appears in >=2 liked opps
  const threshold = 2;
  userPreferences = {
    agencies: new Set(Object.entries(agencyCounts).filter(([, c]) => c >= threshold).map(([k]) => k)),
    naics: new Set(Object.entries(naicsCounts).filter(([, c]) => c >= threshold).map(([k]) => k)),
    setAsides: new Set(Object.entries(setAsideCounts).filter(([, c]) => c >= threshold).map(([k]) => k)),
  };
}

function matchesPreferences(opp) {
  if (!userPreferences) return false;
  return (
    (opp.agency && userPreferences.agencies.has(opp.agency)) ||
    (opp.naics_code && userPreferences.naics.has(opp.naics_code)) ||
    (opp.set_aside && userPreferences.setAsides.has(opp.set_aside))
  );
}

// --- Score "Why" (click-to-expand inline) ---

function buildReasonsHtml(aiReasonsJson, noticeId) {
  if (!aiReasonsJson) return '';
  try {
    const reasons = JSON.parse(aiReasonsJson);
    if (!Array.isArray(reasons) || reasons.length === 0) return '';
    const items = reasons.slice(0, 4).map(r =>
      `<li>${escapeHtml(String(r))}</li>`
    ).join('');
    return `<ul class="opp-reasons" id="reasons-${escapeHtml(noticeId)}">${items}</ul>`;
  } catch { return ''; }
}

function toggleReasons(noticeId) {
  const el = document.getElementById('reasons-' + noticeId);
  if (el) el.classList.toggle('open');
}

window.toggleReasons = toggleReasons;

// --- Main render ---

async function loadTopOpportunities() {
  const { data, error } = await sb
    .from('scanner_opportunities')
    .select('*')
    .order('last_score', { ascending: false });

  if (error) {
    console.error('Failed to load top opportunities:', error);
    topOppsSection.style.display = 'block';
    topOppsTableBody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:40px;color:var(--accent-red);font-weight:600;">Error loading opportunities: ${escapeHtml(error.message || 'Unknown error')}</td></tr>`;
    return;
  }

  allOpportunities = data || [];

  if (allOpportunities.length === 0) {
    topOppsSection.style.display = 'block';
    topOppsTableBody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:#9ca3af;font-weight:600;">No opportunities found</td></tr>';
    return;
  }

  // Re-compute preferences whenever we reload
  buildPreferences();

  // Check which notice_ids are already tracked as projects
  const trackedNoticeIds = new Set(
    projects.filter(p => p.notice_id).map(p => p.notice_id)
  );

  // Filter out dismissed
  const visible = allOpportunities.filter(o => !userDismissals.has(o.notice_id));
  const dismissedCount = allOpportunities.length - visible.length;

  topOppsCount.textContent = visible.length;
  topOppsSection.style.display = 'block';

  topOppsTableBody.innerHTML = visible.map((opp) => {
    const scoreClass = opp.last_score >= 80 ? 'score-green' : opp.last_score >= 60 ? 'score-yellow' : 'score-red';
    const deadlineStr = opp.response_deadline ? formatDate(opp.response_deadline) : '';
    const daysLeft = opp.response_deadline ? getDaysUntil(opp.response_deadline) : null;
    const deadlineClass = daysLeft !== null && daysLeft <= 7 ? 'opp-deadline-urgent' : '';
    const isTracked = trackedNoticeIds.has(opp.notice_id);
    const prefMatch = matchesPreferences(opp);

    const summaryHtml = opp.ai_summary
      ? `<div class="opp-summary">${escapeHtml(opp.ai_summary)}</div>`
      : '';

    const reasonsHtml = buildReasonsHtml(opp.ai_reasons_json, opp.notice_id);

    const actionHtml = isTracked
      ? `<span class="opp-tracking-badge"><i class="fas fa-check"></i> Tracked</span>`
      : `<button class="opp-track-btn" onclick="trackOpportunity('${escapeHtml(opp.notice_id)}')">Track</button>`;

    // Feedback buttons
    const rating = userFeedback[opp.notice_id];
    const thumbUpClass = rating === 'up' ? 'active' : '';
    const thumbDownClass = rating === 'down' ? 'active' : '';

    const feedbackHtml = `
      <span class="opp-feedback-btns">
        <button class="opp-thumb ${thumbUpClass}" onclick="toggleFeedback('${escapeHtml(opp.notice_id)}', 'up')" title="Thumbs up"><i class="fas fa-thumbs-up"></i></button>
        <button class="opp-thumb ${thumbDownClass}" onclick="toggleFeedback('${escapeHtml(opp.notice_id)}', 'down')" title="Thumbs down"><i class="fas fa-thumbs-down"></i></button>
      </span>`;

    const valueHtml = opp.estimated_value ? escapeHtml(opp.estimated_value) : '';

    return `
      <tr${prefMatch ? ' class="opp-pref-match"' : ''}>
        <td>
          <span class="opp-score-badge ${scoreClass}${reasonsHtml ? ' has-reasons' : ''}" ${reasonsHtml ? `onclick="toggleReasons('${escapeHtml(opp.notice_id)}')"` : ''}>${Math.round(opp.last_score)}</span>
        </td>
        <td class="opp-title-cell">
          ${prefMatch ? '<span class="opp-pref-indicator" title="Matches your preferences"><i class="fas fa-star"></i></span>' : ''}
          ${opp.ui_link
            ? `<a class="opp-title-link" href="${escapeHtml(opp.ui_link)}" target="_blank" rel="noopener">${escapeHtml(opp.title)}</a>`
            : `<span class="opp-title-link">${escapeHtml(opp.title)}</span>`
          }
          ${summaryHtml}
          ${reasonsHtml}
        </td>
        <td>${escapeHtml(opp.agency || '')}</td>
        <td class="opp-value-cell">${valueHtml}</td>
        <td class="opp-deadline-cell ${deadlineClass}">${deadlineStr}${daysLeft !== null && daysLeft <= 14 ? ` <small>(${daysLeft}d)</small>` : ''}</td>
        <td><span class="opp-set-aside">${escapeHtml(opp.set_aside || '')}</span></td>
        <td>${actionHtml} ${feedbackHtml}</td>
        <td><button class="opp-dismiss-btn" onclick="dismissOpportunity('${escapeHtml(opp.notice_id)}')" title="Dismiss"><i class="fas fa-times"></i></button></td>
      </tr>
    `;
  }).join('');

  // Show/hide dismissed link
  if (dismissedCount > 0) {
    dismissedLink.style.display = 'block';
    dismissedLink.innerHTML = `<a href="#" onclick="showDismissed(event)">Show ${dismissedCount} dismissed</a>`;
  } else {
    dismissedLink.style.display = 'none';
  }

}

// --- Dismiss ---

async function dismissOpportunity(noticeId) {
  const { error } = await sb.from('opportunity_dismissals').upsert({
    user_id: currentUser.id,
    notice_id: noticeId,
  }, { onConflict: 'user_id,notice_id' });

  if (error) {
    console.error('Failed to dismiss:', error);
    return;
  }
  userDismissals.add(noticeId);
  await loadTopOpportunities();
}

async function undismissOpportunity(noticeId) {
  await sb.from('opportunity_dismissals')
    .delete()
    .eq('user_id', currentUser.id)
    .eq('notice_id', noticeId);
  userDismissals.delete(noticeId);
  await loadTopOpportunities();
}

function showDismissed(e) {
  e.preventDefault();
  userDismissals.clear();
  loadTopOpportunities();
}

window.dismissOpportunity = dismissOpportunity;
window.undismissOpportunity = undismissOpportunity;
window.showDismissed = showDismissed;

// --- Feedback (thumbs up/down) ---

async function toggleFeedback(noticeId, rating) {
  const current = userFeedback[noticeId];

  if (current === rating) {
    // Remove rating
    await sb.from('opportunity_feedback')
      .delete()
      .eq('user_id', currentUser.id)
      .eq('notice_id', noticeId);
    delete userFeedback[noticeId];
  } else {
    // Upsert rating
    const { error } = await sb.from('opportunity_feedback').upsert({
      user_id: currentUser.id,
      notice_id: noticeId,
      rating,
    }, { onConflict: 'user_id,notice_id' });
    if (error) {
      console.error('Failed to save feedback:', error);
      return;
    }
    userFeedback[noticeId] = rating;
  }

  buildPreferences();
  await loadTopOpportunities();
}

window.toggleFeedback = toggleFeedback;

/**
 * Track an opportunity — promotes it to a full dashboard project
 * with auto-generated milestones and document checklist.
 */
async function trackOpportunity(noticeId) {
  // Find the opportunity data
  const { data: opp, error: fetchError } = await sb
    .from('scanner_opportunities')
    .select('*')
    .eq('notice_id', noticeId)
    .single();

  if (fetchError || !opp) {
    console.error('Failed to fetch opportunity:', fetchError);
    alert('Failed to load opportunity data.');
    return;
  }

  // Create project
  const projectData = {
    title: opp.title,
    agency: opp.agency || null,
    solicitation_number: opp.solicitation_number || null,
    notice_id: opp.notice_id,
    response_deadline: opp.response_deadline,
    owner: 'Chris',
    status: 'active',
    priority: opp.last_score >= 80 ? 'high' : 'normal',
    naics_code: opp.naics_code || null,
    set_aside: opp.set_aside || null,
    sam_link: opp.ui_link || null,
    notes: opp.ai_summary || null,
    created_by: currentUser.id,
  };

  const { data: project, error: projectError } = await sb
    .from('projects')
    .insert(projectData)
    .select()
    .single();

  if (projectError) {
    console.error('Failed to create project:', projectError);
    alert('Failed to create project. It may already be tracked.');
    return;
  }

  // Auto-generate milestones
  if (opp.response_deadline) {
    const deadlineDate = new Date(opp.response_deadline);
    const milestones = MILESTONE_TEMPLATE.map((m, i) => {
      const dueDate = new Date(deadlineDate);
      dueDate.setDate(dueDate.getDate() - m.daysBeforeDeadline);
      return {
        project_id: project.id,
        title: m.title,
        due_date: dueDate.toISOString(),
        sort_order: i,
      };
    });

    const { error: mError } = await sb.from('milestones').insert(milestones);
    if (mError) console.error('Failed to create milestones:', mError);
  }

  // Auto-generate document checklist
  const checklistItems = DEFAULT_CHECKLIST.map((label, i) => ({
    project_id: project.id,
    label,
    sort_order: i,
  }));

  const { error: cError } = await sb.from('checklist_items').insert(checklistItems);
  if (cError) console.error('Failed to create checklist:', cError);

  // Log activity
  await logActivity(project.id, 'Tracked from Top Opportunities', `notice_id: ${opp.notice_id}, score: ${opp.last_score}`);

  // Reload both lists
  await loadProjects();
  await loadTopOpportunities();
}

window.trackOpportunity = trackOpportunity;

// ============================================================
// Deep Dive Slide-Out Panel
// ============================================================

const deepDivePanel = $('deepDivePanel');
const deepDiveBackdrop = $('deepDiveBackdrop');
const deepDiveTitle = $('deepDiveTitle');
const deepDiveBody = $('deepDiveBody');
const deepDiveActions = $('deepDiveActions');
const deepDiveClose = $('deepDiveClose');

function openDeepDive(noticeId) {
  const opp = allOpportunities.find(o => o.notice_id === noticeId);
  if (!opp) return;

  deepDiveTitle.textContent = opp.title || 'Opportunity Details';

  // Build sections
  let html = '';
  html += renderDDScorecard(opp);
  html += renderDDReasons(opp);
  html += renderDDRisks(opp);
  html += renderDDSkillsets(opp);
  html += renderDDKeyDates(opp);
  html += renderDDMustCheck(opp);
  html += renderDDAttachments(opp);
  html += renderDDDescription(opp);
  deepDiveBody.innerHTML = html;

  // Action bar
  deepDiveActions.innerHTML = `
    <button class="dd-btn dd-btn-pursue" onclick="ddPursue('${escapeHtml(opp.notice_id)}')">Pursue</button>
    <button class="dd-btn dd-btn-pass" onclick="ddPass('${escapeHtml(opp.notice_id)}')">Pass</button>
    ${opp.ui_link ? `<button class="dd-btn dd-btn-sam" onclick="window.open('${escapeHtml(opp.ui_link)}', '_blank')">SAM.gov</button>` : ''}
  `;

  deepDivePanel.classList.add('open');
  deepDiveBackdrop.classList.add('visible');
}

function closeDeepDive() {
  deepDivePanel.classList.remove('open');
  deepDiveBackdrop.classList.remove('visible');
}

// Close handlers
deepDiveClose.addEventListener('click', closeDeepDive);
deepDiveBackdrop.addEventListener('click', closeDeepDive);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && deepDivePanel.classList.contains('open')) {
    closeDeepDive();
  }
});

window.openDeepDive = openDeepDive;
window.closeDeepDive = closeDeepDive;

// --- Section Renderers ---

function renderDDScorecard(opp) {
  const score = Math.round(opp.last_score || 0);
  const scoreClass = score >= 80 ? 'score-green' : score >= 60 ? 'score-yellow' : 'score-red';
  const fitLabel = opp.last_fit_label || '';
  const eligibility = opp.ai_is_relevant != null
    ? (opp.ai_is_relevant ? '<span style="color:#10b981;"><i class="fas fa-check-circle"></i> Relevant</span>' : '<span style="color:#f59e0b;"><i class="fas fa-exclamation-triangle"></i> Low relevance</span>')
    : '';
  const value = opp.estimated_value ? `<span><i class="fas fa-dollar-sign"></i> ${escapeHtml(opp.estimated_value)}</span>` : '';

  return `
    <div class="deep-dive-section">
      <h3><i class="fas fa-chart-bar"></i> Scorecard</h3>
      <div class="dd-scorecard">
        <div class="dd-score-badge ${scoreClass}">${score}</div>
        <div class="dd-fit-label">${escapeHtml(fitLabel)}</div>
        <div class="dd-meta-row">
          ${eligibility}
          ${value}
          ${opp.set_aside ? `<span><i class="fas fa-tag"></i> ${escapeHtml(opp.set_aside)}</span>` : ''}
          ${opp.naics_code ? `<span>${escapeHtml(opp.naics_code)}</span>` : ''}
        </div>
      </div>
    </div>`;
}

function renderDDReasons(opp) {
  if (!opp.ai_reasons_json) return '';
  try {
    const reasons = JSON.parse(opp.ai_reasons_json);
    if (!Array.isArray(reasons) || reasons.length === 0) return '';
    const items = reasons.map(r => `<li>${escapeHtml(String(r))}</li>`).join('');
    return `
      <div class="deep-dive-section">
        <h3><i class="fas fa-thumbs-up"></i> Why It Scored Well</h3>
        <ul class="dd-reasons">${items}</ul>
      </div>`;
  } catch { return ''; }
}

function renderDDRisks(opp) {
  if (!opp.ai_risks_json) {
    return `
      <div class="deep-dive-section">
        <h3><i class="fas fa-exclamation-triangle"></i> Risks</h3>
        <div class="dd-empty-text">No risk analysis available</div>
      </div>`;
  }
  try {
    const risks = JSON.parse(opp.ai_risks_json);
    if (!Array.isArray(risks) || risks.length === 0) {
      return `
        <div class="deep-dive-section">
          <h3><i class="fas fa-exclamation-triangle"></i> Risks</h3>
          <div class="dd-risks-empty"><i class="fas fa-check-circle"></i> No significant risks identified</div>
        </div>`;
    }
    const items = risks.map(r => `<li>${escapeHtml(String(r))}</li>`).join('');
    return `
      <div class="deep-dive-section">
        <h3><i class="fas fa-exclamation-triangle"></i> Risks</h3>
        <ul class="dd-risks">${items}</ul>
      </div>`;
  } catch { return ''; }
}

function renderDDSkillsets(opp) {
  if (!opp.ai_skillsets_json) return '';
  try {
    const skills = JSON.parse(opp.ai_skillsets_json);
    if (!Array.isArray(skills) || skills.length === 0) return '';
    const chips = skills.map(s => `<span class="dd-chip">${escapeHtml(String(s))}</span>`).join('');
    return `
      <div class="deep-dive-section">
        <h3><i class="fas fa-tools"></i> Required Skillsets</h3>
        <div class="dd-skills">${chips}</div>
      </div>`;
  } catch { return ''; }
}

function renderDDKeyDates(opp) {
  let dates = [];

  // Always include response deadline
  if (opp.response_deadline) {
    dates.push({ label: 'Response Deadline', date: opp.response_deadline });
  }

  if (opp.ai_key_dates_json) {
    try {
      const parsed = JSON.parse(opp.ai_key_dates_json);
      if (Array.isArray(parsed)) {
        for (const d of parsed) {
          // Avoid duplicate deadline
          if (d.label && d.date && d.label.toLowerCase() !== 'response deadline') {
            dates.push(d);
          }
        }
      }
    } catch { /* ignore parse errors */ }
  }

  if (dates.length === 0) return '';

  const items = dates.map(d => {
    const dateStr = d.date ? formatDate(d.date) : escapeHtml(String(d.date || ''));
    return `<li><span class="dd-date-label">${escapeHtml(String(d.label))}</span><span class="dd-date-value">${dateStr}</span></li>`;
  }).join('');

  return `
    <div class="deep-dive-section">
      <h3><i class="fas fa-calendar-alt"></i> Key Dates</h3>
      <ul class="dd-dates">${items}</ul>
    </div>`;
}

function renderDDMustCheck(opp) {
  if (!opp.ai_must_check_json) return '';
  try {
    const items = JSON.parse(opp.ai_must_check_json);
    if (!Array.isArray(items) || items.length === 0) return '';
    const listItems = items.map(item => `<li>${escapeHtml(String(item))}</li>`).join('');
    return `
      <div class="deep-dive-section">
        <h3><i class="fas fa-clipboard-check"></i> Must Check</h3>
        <ul class="dd-must-check">${listItems}</ul>
      </div>`;
  } catch { return ''; }
}

function renderDDAttachments(opp) {
  // If we already have a full analysis, render it
  if (opp.attachment_analysis_json) {
    return renderAttachmentAnalysis(opp);
  }

  // If resource links exist, show the analyze button
  let resourceLinks = [];
  if (opp.resource_links_json) {
    try { resourceLinks = JSON.parse(opp.resource_links_json); } catch {}
  }

  if (resourceLinks.length > 0) {
    const docCount = resourceLinks.length;
    return `
      <div class="deep-dive-section">
        <h3><i class="fas fa-paperclip"></i> Attachment Analysis</h3>
        <div class="dd-analyze-container" id="ddAnalyzeContainer-${escapeHtml(opp.notice_id)}">
          <button class="dd-analyze-btn" onclick="analyzeAttachment('${escapeHtml(opp.notice_id)}')">
            <i class="fas fa-file-pdf"></i> Analyze ${docCount} Attachment${docCount > 1 ? 's' : ''}
          </button>
          <div class="dd-analyze-hint">Downloads solicitation docs from SAM.gov and runs AI analysis</div>
        </div>
      </div>`;
  }

  return `
    <div class="deep-dive-section">
      <h3><i class="fas fa-paperclip"></i> Attachment Analysis</h3>
      <div class="dd-empty-text">No attachments available on SAM.gov</div>
    </div>`;
}

function renderAttachmentAnalysis(opp) {
  let analysis;
  try {
    analysis = typeof opp.attachment_analysis_json === 'string'
      ? JSON.parse(opp.attachment_analysis_json)
      : opp.attachment_analysis_json;
  } catch {
    return `
      <div class="deep-dive-section">
        <h3><i class="fas fa-paperclip"></i> Attachment Analysis</h3>
        <div class="dd-empty-text">Analysis data could not be parsed</div>
      </div>`;
  }

  // If it's a raw_analysis fallback, show as text
  if (analysis.raw_analysis) {
    return `
      <div class="deep-dive-section">
        <h3><i class="fas fa-paperclip"></i> Attachment Analysis</h3>
        <div class="dd-attachment-summary">${escapeHtml(analysis.raw_analysis)}</div>
      </div>`;
  }

  let html = '<div class="deep-dive-section"><h3><i class="fas fa-paperclip"></i> Attachment Analysis</h3>';

  if (analysis.scope_of_work) {
    html += `<div class="dd-analysis-block">
      <div class="dd-analysis-label"><i class="fas fa-bullseye"></i> Scope of Work</div>
      <p class="dd-analysis-text">${escapeHtml(analysis.scope_of_work)}</p>
    </div>`;
  }

  if (Array.isArray(analysis.key_requirements) && analysis.key_requirements.length) {
    html += `<div class="dd-analysis-block">
      <div class="dd-analysis-label"><i class="fas fa-list-check"></i> Key Requirements</div>
      <ul class="dd-analysis-list">${analysis.key_requirements.map(r => `<li>${escapeHtml(String(r))}</li>`).join('')}</ul>
    </div>`;
  }

  if (Array.isArray(analysis.required_qualifications) && analysis.required_qualifications.length) {
    html += `<div class="dd-analysis-block">
      <div class="dd-analysis-label"><i class="fas fa-certificate"></i> Required Qualifications</div>
      <ul class="dd-analysis-list">${analysis.required_qualifications.map(r => `<li>${escapeHtml(String(r))}</li>`).join('')}</ul>
    </div>`;
  }

  if (analysis.period_of_performance) {
    html += `<div class="dd-analysis-block">
      <div class="dd-analysis-label"><i class="fas fa-clock"></i> Period of Performance</div>
      <p class="dd-analysis-text">${escapeHtml(analysis.period_of_performance)}</p>
    </div>`;
  }

  if (Array.isArray(analysis.evaluation_criteria) && analysis.evaluation_criteria.length) {
    html += `<div class="dd-analysis-block">
      <div class="dd-analysis-label"><i class="fas fa-scale-balanced"></i> Evaluation Criteria</div>
      <ul class="dd-analysis-list">${analysis.evaluation_criteria.map(r => `<li>${escapeHtml(String(r))}</li>`).join('')}</ul>
    </div>`;
  }

  if (Array.isArray(analysis.compliance_requirements) && analysis.compliance_requirements.length) {
    html += `<div class="dd-analysis-block">
      <div class="dd-analysis-label"><i class="fas fa-shield-halved"></i> Compliance Requirements</div>
      <ul class="dd-analysis-list">${analysis.compliance_requirements.map(r => `<li>${escapeHtml(String(r))}</li>`).join('')}</ul>
    </div>`;
  }

  if (Array.isArray(analysis.red_flags) && analysis.red_flags.length) {
    html += `<div class="dd-analysis-block dd-analysis-red-flags">
      <div class="dd-analysis-label"><i class="fas fa-triangle-exclamation"></i> Red Flags / Concerns</div>
      <ul class="dd-analysis-list dd-red-flag-list">${analysis.red_flags.map(r => `<li>${escapeHtml(String(r))}</li>`).join('')}</ul>
    </div>`;
  }

  if (analysis.bid_readiness) {
    html += `<div class="dd-analysis-block">
      <div class="dd-analysis-label"><i class="fas fa-rocket"></i> Bid Readiness Assessment</div>
      <p class="dd-analysis-text">${escapeHtml(analysis.bid_readiness)}</p>
    </div>`;
  }

  html += '</div>';
  return html;
}

async function analyzeAttachment(noticeId) {
  const container = document.getElementById('ddAnalyzeContainer-' + noticeId);
  if (!container) return;

  // Show loading state
  container.innerHTML = `
    <button class="dd-analyze-btn dd-analyze-loading" disabled>
      <span class="dd-analyze-spinner"></span> Analyzing...
    </button>
    <div class="dd-analyze-hint">Downloading and analyzing solicitation docs — this may take 15-30 seconds</div>`;

  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/analyze-attachment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${(await sb.auth.getSession()).data.session?.access_token}`,
      },
      body: JSON.stringify({ notice_id: noticeId }),
    });

    const result = await response.json();

    if (!response.ok) {
      container.innerHTML = `
        <div class="dd-analyze-error">
          <i class="fas fa-exclamation-circle"></i> ${escapeHtml(result.error || 'Analysis failed')}
        </div>
        <button class="dd-analyze-btn" onclick="analyzeAttachment('${escapeHtml(noticeId)}')" style="margin-top: 8px;">
          <i class="fas fa-redo"></i> Retry
        </button>`;
      return;
    }

    // Cache in local state so re-opening doesn't re-fetch
    const opp = allOpportunities.find(o => o.notice_id === noticeId);
    if (opp) {
      opp.attachment_analysis_json = JSON.stringify(result.analysis);
      opp.attachment_analyzed_at = result.analyzed_at;
    }

    // Re-render the entire section
    const section = container.closest('.deep-dive-section');
    if (section) {
      const tempOpp = { ...opp, attachment_analysis_json: JSON.stringify(result.analysis) };
      section.outerHTML = renderAttachmentAnalysis(tempOpp);
    }
  } catch (err) {
    console.error('Attachment analysis failed:', err);
    container.innerHTML = `
      <div class="dd-analyze-error">
        <i class="fas fa-exclamation-circle"></i> Network error — check your connection
      </div>
      <button class="dd-analyze-btn" onclick="analyzeAttachment('${escapeHtml(noticeId)}')" style="margin-top: 8px;">
        <i class="fas fa-redo"></i> Retry
      </button>`;
  }
}

window.analyzeAttachment = analyzeAttachment;

function renderDDDescription(opp) {
  if (!opp.description_excerpt) return '';
  const truncated = opp.description_excerpt.length >= 1990;
  return `
    <div class="deep-dive-section">
      <h3><i class="fas fa-file-alt"></i> Description</h3>
      <div class="dd-description" id="ddDescText">${escapeHtml(opp.description_excerpt)}</div>
      ${truncated ? '<button class="dd-desc-toggle" onclick="toggleDDDescription()">Show more...</button>' : ''}
    </div>`;
}

function toggleDDDescription() {
  const el = document.getElementById('ddDescText');
  const btn = el?.nextElementSibling;
  if (!el) return;
  el.classList.toggle('expanded');
  if (btn) btn.textContent = el.classList.contains('expanded') ? 'Show less' : 'Show more...';
}
window.toggleDDDescription = toggleDDDescription;

// --- Action Buttons ---

async function ddPursue(noticeId) {
  const { error } = await sb
    .from('scanner_opportunities')
    .update({ pursuit_status: 'interested' })
    .eq('notice_id', noticeId);

  if (error) {
    console.error('Failed to update pursuit status:', error);
    return;
  }

  closeDeepDive();
  showDDToast('Marked as Interested');
  await loadTopOpportunities();
}

async function ddPass(noticeId) {
  await dismissOpportunity(noticeId);
  closeDeepDive();
}

function showDDToast(message) {
  let toast = document.querySelector('.dd-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'dd-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

window.ddPursue = ddPursue;
window.ddPass = ddPass;

// --- Row Click Handler ---

if (topOppsTableBody) {
  topOppsTableBody.addEventListener('click', (e) => {
    // Ignore clicks on interactive elements
    const target = e.target.closest('a, button, .opp-thumb, .opp-dismiss-btn, .opp-track-btn, .opp-score-badge.has-reasons, .opp-tracking-badge');
    if (target) return;

    const row = e.target.closest('tr');
    if (!row) return;

    // Find notice_id from the row — extract from dismiss button onclick
    const dismissBtn = row.querySelector('.opp-dismiss-btn');
    if (!dismissBtn) return;
    const onclickAttr = dismissBtn.getAttribute('onclick') || '';
    const match = onclickAttr.match(/dismissOpportunity\('([^']+)'\)/);
    if (match) {
      openDeepDive(match[1]);
    }
  });
}

// ============================================================
// View Router
// ============================================================

const views = {
  scanner: { el: () => $('viewScanner'), init: initScannerView },
  projects: { el: () => $('viewProjects'), init: initProjectsView },
  analyze: { el: () => $('viewAnalyze'), init: initAnalyzeView, adminOnly: true },
};

const ADMIN_EMAILS = ['csardine@provisionsunlimited.net', 'csardine32@gmail.com'];

function isAdmin() {
  if (!currentUser) return false;
  return ADMIN_EMAILS.includes((currentUser.email || '').toLowerCase());
}

function navigateTo(viewName) {
  if (!views[viewName]) viewName = 'scanner';
  if (views[viewName].adminOnly && !isAdmin()) viewName = 'scanner';

  // Hide all views
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));

  // Deactivate all sidebar links
  document.querySelectorAll('.sidebar-link').forEach(l => l.classList.remove('active'));

  // Show target view
  const view = views[viewName];
  const el = view.el();
  if (el) el.classList.add('active');

  // Activate sidebar link
  const link = document.querySelector(`.sidebar-link[data-view="${viewName}"]`);
  if (link) link.classList.add('active');

  // Update mobile nav
  document.querySelectorAll('.mobile-nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === viewName);
  });

  // Update hash without triggering hashchange
  if (window.location.hash.slice(1) !== viewName) {
    history.replaceState(null, '', '#' + viewName);
  }

  // Initialize view if needed
  if (view.init && currentView !== viewName) {
    view.init();
  }
  currentView = viewName;
}

async function initScannerView() {
  // Show loading state immediately
  topOppsSection.style.display = 'block';
  topOppsTableBody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:#9ca3af;font-weight:600;">Loading opportunities...</td></tr>';

  try {
    if (!scannerInitialized) {
      await Promise.all([loadUserDismissals(), loadUserFeedback()]);
      scannerInitialized = true;
    }
    await loadTopOpportunities();
  } catch (err) {
    console.error('[Scanner] initScannerView error:', err);
    topOppsTableBody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:40px;color:var(--accent-red);font-weight:600;">Failed to load opportunities. Check console for details.</td></tr>`;
  }
}

async function initProjectsView() {
  if (!projectsInitialized) {
    projectsInitialized = true;
  }
  await loadProjects();
  startCountdownTimer();
}

function initAnalyzeView() {
  const dropZone = $('dropZone');
  const fileInput = $('fileInput');

  if (!dropZone || dropZone._initialized) return;
  dropZone._initialized = true;

  dropZone.addEventListener('click', () => fileInput.click());

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleAdHocFile(file);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleAdHocFile(fileInput.files[0]);
    fileInput.value = '';
  });

  if (!adhocInitialized) {
    adhocInitialized = true;
    loadAdhocAnalyses();
  }
}

const TEXT_EXTENSIONS = ['.txt', '.csv', '.md', '.json', '.xml', '.tsv', '.log'];
const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.zip', ...TEXT_EXTENSIONS];

async function handleAdHocFile(file) {
  const ext = '.' + file.name.split('.').pop().toLowerCase();

  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    showDDToast('Unsupported file type. Supported: PDF, DOCX, TXT, CSV, ZIP, etc.');
    return;
  }

  const resultDiv = $('analyzeResult');
  resultDiv.innerHTML = `
    <div class="analyze-loading">
      <span class="dd-analyze-spinner"></span>
      Analyzing ${escapeHtml(file.name)}... (15-30 seconds)
    </div>`;

  let body;

  try {
    if (ext === '.zip') {
      body = await handleZipFile(file);

    } else if (ext === '.pdf') {
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      for (const b of bytes) binary += String.fromCharCode(b);
      body = { pdf_base64: btoa(binary), filename: file.name };

    } else if (ext === '.docx') {
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      if (!result.value || !result.value.trim()) throw new Error('Could not extract text from DOCX');
      body = { text_content: result.value, filename: file.name };

    } else {
      const text = await file.text();
      if (!text.trim()) throw new Error('File is empty');
      body = { text_content: text, filename: file.name };
    }
  } catch (err) {
    resultDiv.innerHTML = `
      <div class="dd-analyze-error">
        <i class="fas fa-exclamation-circle"></i> ${escapeHtml(err.message)}
      </div>`;
    return;
  }

  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/analyze-adhoc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${(await sb.auth.getSession()).data.session?.access_token}`,
      },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Analysis failed');

    const fakeOpp = { attachment_analysis_json: JSON.stringify(result.analysis) };
    const matchHtml = result.matched_opportunity
      ? `<span class="adhoc-match-badge"><i class="fas fa-link"></i> Matched: ${escapeHtml(result.matched_opportunity.title || result.matched_opportunity.notice_id)}</span>`
      : '';
    resultDiv.innerHTML = `
      <div class="analyze-result-header">
        <i class="fas fa-check-circle" style="color:#10b981;"></i>
        <strong>${escapeHtml(file.name)}</strong>
        ${matchHtml}
      </div>
      ${renderAttachmentAnalysis(fakeOpp)}`;
    loadAdhocAnalyses();
  } catch (err) {
    resultDiv.innerHTML = `
      <div class="dd-analyze-error">
        <i class="fas fa-exclamation-circle"></i> ${escapeHtml(err.message)}
      </div>`;
  }
}

async function handleZipFile(file) {
  const zip = await JSZip.loadAsync(file);
  const parts = [];
  let pdfData = null;

  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const name = path.split('/').pop().toLowerCase();
    const ext = '.' + name.split('.').pop();

    if (ext === '.pdf' && !pdfData) {
      const ab = await entry.async('arraybuffer');
      const bytes = new Uint8Array(ab);
      let binary = '';
      for (const b of bytes) binary += String.fromCharCode(b);
      pdfData = { base64: btoa(binary), name: path };
    } else if (ext === '.docx') {
      const ab = await entry.async('arraybuffer');
      const result = await mammoth.extractRawText({ arrayBuffer: ab });
      if (result.value?.trim()) parts.push(`=== ${path} ===\n${result.value}`);
    } else if (TEXT_EXTENSIONS.includes(ext)) {
      const text = await entry.async('text');
      if (text.trim()) parts.push(`=== ${path} ===\n${text}`);
    }
  }

  if (parts.length > 0) {
    return { text_content: parts.join('\n\n'), filename: file.name };
  }
  if (pdfData) {
    return { pdf_base64: pdfData.base64, filename: `${file.name} → ${pdfData.name}` };
  }
  throw new Error('No supported files found inside ZIP');
}

// ============================================================
// Recent Adhoc Analyses
// ============================================================

async function loadAdhocAnalyses() {
  const { data, error } = await sb
    .from('adhoc_analyses')
    .select('*')
    .eq('user_id', currentUser.id)
    .order('analyzed_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error('Failed to load adhoc analyses:', error);
    return;
  }

  adhocAnalyses = data || [];
  renderAdhocAnalysesList();
}

function renderAdhocAnalysesList() {
  const container = $('recentAnalyses');
  if (!container) return;

  const active = adhocAnalyses.filter(a => a.status === 'active');
  const dismissed = adhocAnalyses.filter(a => a.status === 'dismissed');
  const pursued = adhocAnalyses.filter(a => a.status === 'pursued');
  const visibleItems = showAllAdhoc ? [...active, ...pursued, ...dismissed] : [...active, ...pursued];

  if (adhocAnalyses.length === 0) {
    container.innerHTML = '';
    return;
  }

  const rows = visibleItems.map(a => {
    const displayTitle = a.title || a.filename;
    const dateStr = new Date(a.analyzed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const isDismissed = a.status === 'dismissed';
    const isPursued = a.status === 'pursued';

    const matchBadge = a.matched_notice_id
      ? `<span class="adhoc-match-badge"><i class="fas fa-link"></i> Linked</span>`
      : `<span class="adhoc-no-match-badge"><i class="fas fa-unlink"></i> No match</span>`;

    let actionsHtml = '';
    if (isDismissed) {
      actionsHtml = `<button class="adhoc-action-btn adhoc-undo-btn" onclick="undismissAdhocAnalysis('${a.id}')" title="Restore"><i class="fas fa-undo"></i></button>`;
    } else if (isPursued) {
      actionsHtml = `<span class="adhoc-pursued-badge"><i class="fas fa-check"></i> Pursued</span>`;
    } else {
      const pursueHandler = a.matched_notice_id
        ? `pursueAdhocMatched('${a.id}', '${escapeHtml(a.matched_notice_id)}')`
        : `pursueAdhocUnmatched('${a.id}')`;
      actionsHtml = `
        <button class="adhoc-action-btn adhoc-pursue-btn" onclick="event.stopPropagation(); ${pursueHandler}" title="Pursue"><i class="fas fa-rocket"></i></button>
        <button class="adhoc-action-btn adhoc-dismiss-btn" onclick="event.stopPropagation(); dismissAdhocAnalysis('${a.id}')" title="Dismiss"><i class="fas fa-times"></i></button>`;
    }

    return `
      <div class="adhoc-row${isDismissed ? ' adhoc-dismissed' : ''}" onclick="viewAdhocAnalysis('${a.id}')">
        <div class="adhoc-row-info">
          <div class="adhoc-row-title">${escapeHtml(displayTitle)}</div>
          <div class="adhoc-row-meta">
            <span>${escapeHtml(a.filename)}</span>
            <span>${dateStr}</span>
            ${matchBadge}
          </div>
        </div>
        <div class="adhoc-row-actions">
          ${actionsHtml}
        </div>
      </div>`;
  }).join('');

  const dismissedLinkHtml = !showAllAdhoc && dismissed.length > 0
    ? `<div class="adhoc-dismissed-link"><a href="#" onclick="showDismissedAnalyses(event)">Show ${dismissed.length} dismissed</a></div>`
    : showAllAdhoc && dismissed.length > 0
      ? `<div class="adhoc-dismissed-link"><a href="#" onclick="showDismissedAnalyses(event)">Hide dismissed</a></div>`
      : '';

  container.innerHTML = `
    <div class="adhoc-recent-header">
      <h3>Recent Analyses</h3>
      <span class="adhoc-count-badge">${active.length + pursued.length}</span>
    </div>
    <div class="adhoc-list">
      ${rows || '<div style="padding:24px;text-align:center;color:#9ca3af;">No analyses yet</div>'}
    </div>
    ${dismissedLinkHtml}`;
}

function viewAdhocAnalysis(id) {
  const analysis = adhocAnalyses.find(a => a.id === id);
  if (!analysis) return;

  const resultDiv = $('analyzeResult');
  let parsed;
  try {
    parsed = JSON.parse(analysis.analysis_json);
  } catch {
    parsed = { raw_analysis: analysis.analysis_json };
  }

  const fakeOpp = { attachment_analysis_json: JSON.stringify(parsed) };
  const matchHtml = analysis.matched_notice_id
    ? `<span class="adhoc-match-badge"><i class="fas fa-link"></i> Linked to scanner opportunity</span>`
    : '';

  resultDiv.innerHTML = `
    <div class="analyze-result-header">
      <i class="fas fa-check-circle" style="color:#10b981;"></i>
      <strong>${escapeHtml(analysis.title || analysis.filename)}</strong>
      ${matchHtml}
    </div>
    ${renderAttachmentAnalysis(fakeOpp)}`;
}

async function dismissAdhocAnalysis(id) {
  const { error } = await sb.from('adhoc_analyses').update({ status: 'dismissed' }).eq('id', id);
  if (error) {
    console.error('Failed to dismiss analysis:', error);
    return;
  }
  const item = adhocAnalyses.find(a => a.id === id);
  if (item) item.status = 'dismissed';
  renderAdhocAnalysesList();
  showDDToast('Analysis dismissed');
}

async function undismissAdhocAnalysis(id) {
  const { error } = await sb.from('adhoc_analyses').update({ status: 'active' }).eq('id', id);
  if (error) {
    console.error('Failed to restore analysis:', error);
    return;
  }
  const item = adhocAnalyses.find(a => a.id === id);
  if (item) item.status = 'active';
  renderAdhocAnalysesList();
  showDDToast('Analysis restored');
}

async function pursueAdhocMatched(id, noticeId) {
  await trackOpportunity(noticeId);

  // Find the newly created project to link
  const tracked = projects.find(p => p.notice_id === noticeId);
  const updates = { status: 'pursued' };
  if (tracked) updates.project_id = tracked.id;

  await sb.from('adhoc_analyses').update(updates).eq('id', id);
  const item = adhocAnalyses.find(a => a.id === id);
  if (item) item.status = 'pursued';
  renderAdhocAnalysesList();
}

function pursueAdhocUnmatched(id) {
  const analysis = adhocAnalyses.find(a => a.id === id);
  if (!analysis) return;

  let parsed;
  try { parsed = JSON.parse(analysis.analysis_json); } catch { parsed = {}; }

  // Pre-fill the Add Project modal
  pendingAdhocId = id;
  editingProjectId = null;
  modalTitle.textContent = 'Add Project';
  projectForm.reset();
  $('formProjectId').value = '';
  $('formTitle').value = analysis.title || '';
  $('formSolicitation').value = analysis.solicitation_number || '';
  $('formOwner').value = 'Chris';
  $('formPriority').value = 'normal';

  // Build notes from analysis summary
  const notesParts = [];
  if (parsed.scope_of_work) notesParts.push('Scope: ' + parsed.scope_of_work);
  if (parsed.bid_readiness) notesParts.push('Bid Readiness: ' + parsed.bid_readiness);
  $('formNotes').value = notesParts.join('\n\n');

  $('milestonesSection').style.display = 'none';
  $('checklistSection').style.display = 'none';
  $('deleteSection').style.display = 'none';
  modalSave.textContent = 'Save Project';
  modalOverlay.classList.add('visible');
}

function showDismissedAnalyses(e) {
  e.preventDefault();
  showAllAdhoc = !showAllAdhoc;
  renderAdhocAnalysesList();
}

window.viewAdhocAnalysis = viewAdhocAnalysis;
window.dismissAdhocAnalysis = dismissAdhocAnalysis;
window.undismissAdhocAnalysis = undismissAdhocAnalysis;
window.pursueAdhocMatched = pursueAdhocMatched;
window.pursueAdhocUnmatched = pursueAdhocUnmatched;
window.showDismissedAnalyses = showDismissedAnalyses;

// Hash change listener
window.addEventListener('hashchange', () => {
  if (!currentUser) return;
  const hash = window.location.hash.slice(1) || 'scanner';
  navigateTo(hash);
});

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
