const state = {
  token: localStorage.getItem("taskTrackerToken"),
  user: JSON.parse(localStorage.getItem("taskTrackerUser") || "null"),
  view: "dashboard",
  projects: [],
  users: [],
  tasks: [],
  dashboard: null
};

const app = document.getElementById("app");
const statuses = ["Todo", "In Progress", "Review", "Done"];
const priorities = ["Low", "Medium", "High"];
const projectStatuses = ["Planning", "Active", "Paused", "Completed"];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(date) {
  if (!date) return "No due date";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" })
    .format(new Date(`${date}T00:00:00`));
}

function isOverdue(task) {
  if (!task.due_date || task.status === "Done") return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(`${task.due_date}T00:00:00`) < today;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {})
    }
  });

  if (response.status === 204) return null;

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.message || "Request failed.");
    error.status = response.status;
    throw error;
  }

  return data;
}

function setSession(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem("taskTrackerToken", token);
  localStorage.setItem("taskTrackerUser", JSON.stringify(user));
}

function clearSession() {
  state.token = null;
  state.user = null;
  localStorage.removeItem("taskTrackerToken");
  localStorage.removeItem("taskTrackerUser");
}

function renderAuth(mode = "login") {
  const isSignup = mode === "signup";
  app.innerHTML = `
    <main class="auth-shell">
      <section class="auth-art">
        <div class="brand"><span class="brand-mark">T</span> Task Tracker</div>
        <div>
          <h1>Projects, tasks, and progress in one place.</h1>
          <p>Manage teams with admin controls, assign work clearly, and keep overdue tasks visible before they turn into surprises.</p>
        </div>
      </section>
      <section class="auth-panel">
        <form class="auth-card stack" id="authForm">
          <div>
            <h2>${isSignup ? "Create account" : "Welcome back"}</h2>
            <p class="muted">${isSignup ? "The first account becomes Admin automatically." : "Sign in to view your projects and tasks."}</p>
          </div>
          ${isSignup ? `
            <label>Name
              <input name="name" autocomplete="name" required>
            </label>
          ` : ""}
          <label>Email
            <input type="email" name="email" autocomplete="email" required>
          </label>
          <label>Password
            <input type="password" name="password" autocomplete="${isSignup ? "new-password" : "current-password"}" minlength="8" required>
          </label>
          ${isSignup ? `
            <div class="form-grid">
              <label>Requested role
                <select name="role">
                  <option>Member</option>
                  <option>Admin</option>
                </select>
              </label>
              <label>Admin code
                <input name="adminCode" placeholder="Optional">
              </label>
            </div>
          ` : ""}
          <p class="error" id="authError"></p>
          <button class="btn" type="submit">${isSignup ? "Sign up" : "Log in"}</button>
          <button class="link-button" type="button" id="toggleAuth">
            ${isSignup ? "Already have an account? Log in" : "Need an account? Sign up"}
          </button>
        </form>
      </section>
    </main>
  `;

  document.getElementById("toggleAuth").addEventListener("click", () => {
    renderAuth(isSignup ? "login" : "signup");
  });

  document.getElementById("authForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const error = document.getElementById("authError");
    error.textContent = "";

    try {
      const payload = Object.fromEntries(form.entries());
      const data = await api(`/api/auth/${isSignup ? "signup" : "login"}`, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      setSession(data.token, data.user);
      await loadApp();
    } catch (err) {
      error.textContent = err.message;
    }
  });
}

function renderShell(content) {
  const adminNav = state.user.role === "Admin"
    ? `<button data-view="team" class="${state.view === "team" ? "active" : ""}">Team</button>`
    : "";

  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand"><span class="brand-mark">T</span> Task Tracker</div>
        <div class="muted">${escapeHtml(state.user.name)} - ${escapeHtml(state.user.role)}</div>
        <nav class="nav">
          <button data-view="dashboard" class="${state.view === "dashboard" ? "active" : ""}">Dashboard</button>
          <button data-view="projects" class="${state.view === "projects" ? "active" : ""}">Projects</button>
          <button data-view="tasks" class="${state.view === "tasks" ? "active" : ""}">Tasks</button>
          ${adminNav}
          <button id="logoutButton">Logout</button>
        </nav>
      </aside>
      <main class="main">${content}</main>
    </div>
    <div class="modal" id="modal" aria-hidden="true"></div>
  `;

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.view = button.dataset.view;
      await loadApp(false);
    });
  });

  document.getElementById("logoutButton").addEventListener("click", () => {
    clearSession();
    renderAuth();
  });
}

async function loadData() {
  const [dashboard, projects, users, tasks] = await Promise.all([
    api("/api/dashboard"),
    api("/api/projects"),
    api("/api/users"),
    api("/api/tasks")
  ]);

  state.dashboard = dashboard;
  state.projects = projects.projects;
  state.users = users.users;
  state.tasks = tasks.tasks;
}

async function loadApp(refresh = true) {
  try {
    if (refresh) {
      await api("/api/auth/me");
    }
    await loadData();
    renderCurrentView();
  } catch (err) {
    if (err.status === 401) {
      clearSession();
      renderAuth();
      return;
    }

    renderShell(`
      <header class="topbar">
        <div>
          <h1>Something needs attention</h1>
          <p class="muted">${escapeHtml(err.message)}</p>
        </div>
        <button class="btn" id="retryLoad">Retry</button>
      </header>
      <section class="panel">
        <p class="muted">Your session is still kept. Retry after fixing the action that failed.</p>
      </section>
    `);
    document.getElementById("retryLoad").addEventListener("click", () => loadApp(false));
  }
}

function renderCurrentView() {
  if (state.view === "projects") return renderProjects();
  if (state.view === "tasks") return renderTasks();
  if (state.view === "team" && state.user.role === "Admin") return renderTeam();
  return renderDashboard();
}

function renderDashboard() {
  const summary = state.dashboard.summary;
  const stats = [
    ["Total", summary.total],
    ["Todo", summary.todo],
    ["In Progress", summary.in_progress],
    ["Review", summary.review],
    ["Done", summary.done],
    ["Overdue", summary.overdue]
  ];

  renderShell(`
    <header class="topbar">
      <div>
        <h1>Dashboard</h1>
        <p class="muted">Live summary across ${state.user.role === "Admin" ? "all projects" : "your projects"}.</p>
      </div>
      <button class="btn" id="newTask">+ Task</button>
    </header>
    <section class="grid stats-grid">
      ${stats.map(([label, value]) => `
        <article class="panel stat">
          <span class="muted">${label}</span>
          <strong>${value}</strong>
        </article>
      `).join("")}
    </section>
    <section class="grid work-grid" style="margin-top: 16px;">
      <div class="panel">
        <div class="spread">
          <h2 class="section-title">Upcoming work</h2>
          <button class="btn secondary small" data-view-jump="tasks">View all</button>
        </div>
        <div class="cards" style="margin-top: 14px;">
          ${state.dashboard.upcoming.length ? state.dashboard.upcoming.map(taskCard).join("") : empty("No tasks yet.")}
        </div>
      </div>
      <div class="panel">
        <h2 class="section-title">Project progress</h2>
        <div class="cards" style="margin-top: 14px;">
          ${state.projects.length ? state.projects.slice(0, 5).map(projectCard).join("") : empty("No projects yet.")}
        </div>
      </div>
    </section>
  `);

  document.getElementById("newTask").addEventListener("click", () => openTaskModal());
  document.querySelector("[data-view-jump]").addEventListener("click", () => {
    state.view = "tasks";
    renderTasks();
  });
  wireTaskCards();
  wireProjectActions();
}

function renderProjects() {
  const canManage = state.user.role === "Admin";
  renderShell(`
    <header class="topbar">
      <div>
        <h1>Projects</h1>
        <p class="muted">${canManage ? "Create projects and manage membership." : "Projects assigned to your team membership."}</p>
      </div>
      ${canManage ? `<button class="btn" id="newProject">+ Project</button>` : ""}
    </header>
    <section class="cards">
      ${state.projects.length ? state.projects.map(projectCard).join("") : empty("No projects available.")}
    </section>
  `);

  if (canManage) {
    document.getElementById("newProject").addEventListener("click", () => openProjectModal());
    wireProjectActions();
  }
}

function renderTasks() {
  renderShell(`
    <header class="topbar">
      <div>
        <h1>Tasks</h1>
        <p class="muted">Create, assign, filter, and move work through status.</p>
      </div>
      <button class="btn" id="newTask">+ Task</button>
    </header>
    <section class="toolbar">
      <label>Project
        <select id="projectFilter">
          <option value="">All projects</option>
          ${state.projects.map((project) => `<option value="${project.id}">${escapeHtml(project.name)}</option>`).join("")}
        </select>
      </label>
      <label>Status
        <select id="statusFilter">
          <option value="">All statuses</option>
          ${statuses.map((status) => `<option>${status}</option>`).join("")}
        </select>
      </label>
    </section>
    <section class="cards" id="taskList"></section>
  `);

  const projectFilter = document.getElementById("projectFilter");
  const statusFilter = document.getElementById("statusFilter");
  const taskList = document.getElementById("taskList");

  function draw() {
    const projectId = projectFilter.value;
    const status = statusFilter.value;
    const tasks = state.tasks.filter((task) => {
      return (!projectId || String(task.project_id) === projectId) &&
        (!status || task.status === status);
    });
    taskList.innerHTML = tasks.length ? tasks.map(taskCard).join("") : empty("No tasks match this filter.");
    wireTaskCards();
  }

  projectFilter.addEventListener("change", draw);
  statusFilter.addEventListener("change", draw);
  document.getElementById("newTask").addEventListener("click", () => openTaskModal());
  draw();
}

function renderTeam() {
  renderShell(`
    <header class="topbar">
      <div>
        <h1>Team</h1>
        <p class="muted">Promote admins, set members, and add people to projects from project membership.</p>
      </div>
    </header>
    <section class="cards">
      ${state.users.map((user) => `
        <article class="user-card">
          <div class="spread">
            <div>
              <h3>${escapeHtml(user.name)}</h3>
              <p class="muted">${escapeHtml(user.email)}</p>
            </div>
            <span class="badge">${escapeHtml(user.role)}</span>
          </div>
          <div class="row">
            <select data-role-user="${user.id}" aria-label="Role for ${escapeHtml(user.name)}">
              <option ${user.role === "Member" ? "selected" : ""}>Member</option>
              <option ${user.role === "Admin" ? "selected" : ""}>Admin</option>
            </select>
            <button class="btn secondary small" data-save-role="${user.id}">Save role</button>
          </div>
        </article>
      `).join("")}
    </section>
  `);

  document.querySelectorAll("[data-save-role]").forEach((button) => {
    button.addEventListener("click", async () => {
      const userId = button.dataset.saveRole;
      const role = document.querySelector(`[data-role-user="${userId}"]`).value;
      await api(`/api/users/${userId}/role`, {
        method: "PATCH",
        body: JSON.stringify({ role })
      });
      await loadApp(false);
    });
  });
}

function empty(text) {
  return `<div class="empty">${escapeHtml(text)}</div>`;
}

function projectCard(project) {
  const total = Number(project.task_count || 0);
  const done = Number(project.done_count || 0);
  const percent = total ? Math.round((done / total) * 100) : 0;
  const actions = state.user.role === "Admin"
    ? `<div class="row">
        <button class="btn secondary small" data-edit-project="${project.id}">Edit</button>
        <button class="btn secondary small" data-members-project="${project.id}">Members</button>
      </div>`
    : "";

  return `
    <article class="project-card">
      <div class="spread">
        <div>
          <h3>${escapeHtml(project.name)}</h3>
          <p class="muted">${escapeHtml(project.description || "No description")}</p>
        </div>
        <span class="badge">${escapeHtml(project.status)}</span>
      </div>
      <div class="progress" aria-label="${percent}% complete"><span style="width: ${percent}%"></span></div>
      <div class="meta">
        <span class="badge">${percent}% done</span>
        <span class="badge">${project.member_count || 0} members</span>
        <span class="badge">${project.task_count || 0} tasks</span>
      </div>
      ${actions}
    </article>
  `;
}

function taskCard(task) {
  const overdue = isOverdue(task);
  return `
    <article class="task-card">
      <div class="spread">
        <div>
          <h3>${escapeHtml(task.title)}</h3>
          <p class="muted">${escapeHtml(task.project_name || "")}</p>
        </div>
        <span class="badge ${task.status === "Done" ? "done" : task.status === "Review" ? "review" : ""}">
          ${escapeHtml(task.status)}
        </span>
      </div>
      <p>${escapeHtml(task.description || "No description")}</p>
      <div class="meta">
        <span class="badge ${task.priority === "High" ? "high" : task.priority === "Medium" ? "medium" : ""}">${escapeHtml(task.priority)}</span>
        <span class="badge ${overdue ? "overdue" : ""}">${overdue ? "Overdue: " : "Due: "}${formatDate(task.due_date)}</span>
        <span class="badge">Assigned: ${escapeHtml(task.assignee_name || "Unassigned")}</span>
      </div>
      <div class="row">
        <select data-status-task="${task.id}" aria-label="Status for ${escapeHtml(task.title)}">
          ${statuses.map((status) => `<option ${task.status === status ? "selected" : ""}>${status}</option>`).join("")}
        </select>
        <button class="btn secondary small" data-save-status="${task.id}">Update</button>
        <button class="btn secondary small" data-edit-task="${task.id}">Edit</button>
      </div>
    </article>
  `;
}

function wireTaskCards() {
  document.querySelectorAll("[data-save-status]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.saveStatus;
      const status = document.querySelector(`[data-status-task="${id}"]`).value;
      await api(`/api/tasks/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status })
      });
      await loadApp(false);
    });
  });

  document.querySelectorAll("[data-edit-task]").forEach((button) => {
    button.addEventListener("click", () => {
      const task = state.tasks.find((item) => item.id === Number(button.dataset.editTask));
      openTaskModal(task);
    });
  });
}

function wireProjectActions() {
  if (state.user.role !== "Admin") return;

  document.querySelectorAll("[data-edit-project]").forEach((button) => {
    button.addEventListener("click", () => {
      const project = state.projects.find((item) => item.id === Number(button.dataset.editProject));
      openProjectModal(project);
    });
  });

  document.querySelectorAll("[data-members-project]").forEach((button) => {
    button.addEventListener("click", () => openMembersModal(Number(button.dataset.membersProject)));
  });
}

function openModal(title, body, onSubmit) {
  const modal = document.getElementById("modal");
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  modal.innerHTML = `
    <form class="modal-body stack" id="modalForm">
      <div class="spread">
        <h2 class="section-title">${escapeHtml(title)}</h2>
        <button class="btn secondary small" type="button" id="closeModal">Close</button>
      </div>
      ${body}
      <p class="error" id="modalError"></p>
      <button class="btn" type="submit">Save</button>
    </form>
  `;

  document.getElementById("closeModal").addEventListener("click", closeModal);
  document.getElementById("modalForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = document.getElementById("modalError");
    error.textContent = "";
    try {
      await onSubmit(Object.fromEntries(new FormData(event.currentTarget).entries()));
      closeModal();
      await loadApp(false);
    } catch (err) {
      error.textContent = err.message;
    }
  });
}

function closeModal() {
  const modal = document.getElementById("modal");
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  modal.innerHTML = "";
}

function openProjectModal(project = null) {
  openModal(project ? "Edit project" : "New project", `
    <div class="form-grid">
      <label class="wide">Name
        <input name="name" value="${escapeHtml(project?.name || "")}" required>
      </label>
      <label class="wide">Description
        <textarea name="description">${escapeHtml(project?.description || "")}</textarea>
      </label>
      <label>Status
        <select name="status">
          ${projectStatuses.map((status) => `<option ${project?.status === status ? "selected" : ""}>${status}</option>`).join("")}
        </select>
      </label>
    </div>
  `, async (form) => {
    await api(project ? `/api/projects/${project.id}` : "/api/projects", {
      method: project ? "PATCH" : "POST",
      body: JSON.stringify(form)
    });
  });
}

function openTaskModal(task = null) {
  openModal(task ? "Edit task" : "New task", `
    <div class="form-grid">
      <label class="wide">Title
        <input name="title" value="${escapeHtml(task?.title || "")}" required>
      </label>
      <label class="wide">Description
        <textarea name="description">${escapeHtml(task?.description || "")}</textarea>
      </label>
      <label>Project
        <select name="projectId" required>
          ${state.projects.map((project) => `<option value="${project.id}" ${task?.project_id === project.id ? "selected" : ""}>${escapeHtml(project.name)}</option>`).join("")}
        </select>
      </label>
      <label>Assignee
        <select name="assigneeId">
          <option value="">Unassigned</option>
          ${state.users.map((user) => `<option value="${user.id}" ${task?.assignee_id === user.id ? "selected" : ""}>${escapeHtml(user.name)}</option>`).join("")}
        </select>
      </label>
      <label>Status
        <select name="status">
          ${statuses.map((status) => `<option ${task?.status === status ? "selected" : ""}>${status}</option>`).join("")}
        </select>
      </label>
      <label>Priority
        <select name="priority">
          ${priorities.map((priority) => `<option ${task?.priority === priority ? "selected" : ""}>${priority}</option>`).join("")}
        </select>
      </label>
      <label>Due date
        <input name="dueDate" type="date" value="${escapeHtml(task?.due_date || "")}">
      </label>
    </div>
  `, async (form) => {
    const payload = {
      ...form,
      projectId: Number(form.projectId),
      assigneeId: form.assigneeId ? Number(form.assigneeId) : null,
      dueDate: form.dueDate || null
    };

    await api(task ? `/api/tasks/${task.id}` : "/api/tasks", {
      method: task ? "PATCH" : "POST",
      body: JSON.stringify(payload)
    });
  });
}

async function openMembersModal(projectId) {
  const data = await api(`/api/projects/${projectId}`);
  const memberIds = new Set(data.members.map((member) => member.id));
  const project = state.projects.find((item) => item.id === projectId);

  openModal(`Members: ${project.name}`, `
    <div class="stack">
      ${state.users.map((user) => `
        <label class="row" style="justify-content: space-between;">
          <span>${escapeHtml(user.name)} <span class="muted">${escapeHtml(user.email)}</span></span>
          <input type="checkbox" name="user_${user.id}" ${memberIds.has(user.id) ? "checked" : ""} style="width: auto;">
        </label>
      `).join("")}
    </div>
  `, async (form) => {
    const selected = new Set(
      Object.keys(form)
        .filter((key) => key.startsWith("user_"))
        .map((key) => Number(key.replace("user_", "")))
    );

    await Promise.all(state.users.map((user) => {
      if (selected.has(user.id) && !memberIds.has(user.id)) {
        return api(`/api/projects/${projectId}/members`, {
          method: "POST",
          body: JSON.stringify({ userId: user.id })
        });
      }

      if (!selected.has(user.id) && memberIds.has(user.id)) {
        return api(`/api/projects/${projectId}/members/${user.id}`, { method: "DELETE" });
      }

      return Promise.resolve();
    }));
  });
}

if (state.token && state.user) {
  loadApp();
} else {
  renderAuth();
}
