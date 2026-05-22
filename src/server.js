require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();
const port = process.env.PORT || 3000;
const jwtSecret = process.env.JWT_SECRET || "dev-only-change-me";

const databaseUrl = process.env.DATABASE_URL;
const requiresDatabaseSsl = /sslmode=require/i.test(databaseUrl || "");

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: requiresDatabaseSsl ? { rejectUnauthorized: false } : false
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    jwtSecret,
    { expiresIn: "7d" }
  );
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    created_at: user.created_at
  };
}

function canUseAdminSignupCode(req) {
  return Boolean(process.env.ADMIN_SIGNUP_CODE) &&
    req.body.adminCode === process.env.ADMIN_SIGNUP_CODE;
}

function requireFields(body, fields) {
  const missing = fields.filter((field) => {
    const value = body[field];
    return value === undefined || value === null || String(value).trim() === "";
  });

  if (missing.length) {
    const err = new Error(`Missing required field(s): ${missing.join(", ")}`);
    err.status = 400;
    throw err;
  }
}

async function query(sql, params = []) {
  const result = await pool.query(sql, params);
  return result;
}

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('Admin', 'Member')) DEFAULT 'Member',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('Planning', 'Active', 'Paused', 'Completed')) DEFAULT 'Active',
      owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS project_members (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK (status IN ('Todo', 'In Progress', 'Review', 'Done')) DEFAULT 'Todo',
      priority TEXT NOT NULL CHECK (priority IN ('Low', 'Medium', 'High')) DEFAULT 'Medium',
      due_date DATE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee_id ON tasks(assignee_id);
    CREATE INDEX IF NOT EXISTS idx_project_members_user_id ON project_members(user_id);
  `);
}

async function getUserById(id) {
  const result = await query("SELECT * FROM users WHERE id = $1", [id]);
  return result.rows[0];
}

async function isProjectMember(projectId, userId) {
  const result = await query(
    "SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2",
    [projectId, userId]
  );
  return result.rowCount > 0;
}

async function canAccessProject(user, projectId) {
  if (user.role === "Admin") return true;
  return isProjectMember(projectId, user.id);
}

async function requireAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const [, token] = auth.split(" ");

    if (!token) {
      return res.status(401).json({ message: "Authentication required." });
    }

    const decoded = jwt.verify(token, jwtSecret);
    const user = await getUserById(decoded.id);

    if (!user) {
      return res.status(401).json({ message: "User no longer exists." });
    }

    req.user = publicUser(user);
    next();
  } catch (error) {
    res.status(401).json({ message: "Invalid or expired token." });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== "Admin") {
    return res.status(403).json({ message: "Admin access required." });
  }
  next();
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

app.post("/api/auth/signup", asyncRoute(async (req, res) => {
  requireFields(req.body, ["name", "email", "password"]);

  const name = req.body.name.trim();
  const email = req.body.email.trim().toLowerCase();
  const password = String(req.body.password);

  if (password.length < 8) {
    return res.status(400).json({ message: "Password must be at least 8 characters." });
  }

  const userCount = await query("SELECT COUNT(*)::int AS count FROM users");
  const wantsAdmin = req.body.role === "Admin";
  const hasAdminCode = canUseAdminSignupCode(req);

  if (wantsAdmin && userCount.rows[0].count > 0 && !hasAdminCode) {
    return res.status(403).json({ message: "Admin signup code is required to create an Admin." });
  }

  const role = userCount.rows[0].count === 0 || (wantsAdmin && hasAdminCode) ? "Admin" : "Member";
  const passwordHash = await bcrypt.hash(password, 12);

  try {
    const result = await query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, role, created_at`,
      [name, email, passwordHash, role]
    );

    const user = result.rows[0];
    res.status(201).json({ token: signToken(user), user });
  } catch (error) {
    if (error.code === "23505") {
      if (wantsAdmin && hasAdminCode) {
        const result = await query(
          `UPDATE users
           SET name = $1, password_hash = $2, role = 'Admin'
           WHERE email = $3
           RETURNING id, name, email, role, created_at`,
          [name, passwordHash, email]
        );

        const user = result.rows[0];
        return res.json({ token: signToken(user), user });
      }

      return res.status(409).json({ message: "An account with that email already exists." });
    }
    throw error;
  }
}));

app.post("/api/auth/login", asyncRoute(async (req, res) => {
  requireFields(req.body, ["email", "password"]);

  const email = req.body.email.trim().toLowerCase();
  const result = await query("SELECT * FROM users WHERE email = $1", [email]);
  const user = result.rows[0];

  if (!user || !(await bcrypt.compare(String(req.body.password), user.password_hash))) {
    return res.status(401).json({ message: "Invalid email or password." });
  }

  const safeUser = publicUser(user);
  res.json({ token: signToken(safeUser), user: safeUser });
}));

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.post("/api/admin/cleanup-codex-users", asyncRoute(async (req, res) => {
  requireFields(req.body, ["adminCode"]);

  if (!canUseAdminSignupCode(req)) {
    return res.status(403).json({ message: "Admin cleanup code is invalid." });
  }

  const result = await query(
    "DELETE FROM users WHERE email LIKE 'codex-check-%@example.com' RETURNING id, email"
  );

  res.json({ deleted: result.rows });
}));

app.get("/api/dashboard", requireAuth, asyncRoute(async (req, res) => {
  const params = [];
  let accessWhere = "";

  if (req.user.role !== "Admin") {
    params.push(req.user.id);
    accessWhere = `
      WHERE t.project_id IN (
        SELECT project_id FROM project_members WHERE user_id = $1
      )
    `;
  }

  const summary = await query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE t.status = 'Todo')::int AS todo,
      COUNT(*) FILTER (WHERE t.status = 'In Progress')::int AS in_progress,
      COUNT(*) FILTER (WHERE t.status = 'Review')::int AS review,
      COUNT(*) FILTER (WHERE t.status = 'Done')::int AS done,
      COUNT(*) FILTER (WHERE t.due_date < CURRENT_DATE AND t.status <> 'Done')::int AS overdue
    FROM tasks t
    ${accessWhere}
  `, params);

  const recentTasks = await query(`
    SELECT t.*, t.due_date::text AS due_date, p.name AS project_name, u.name AS assignee_name
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    LEFT JOIN users u ON u.id = t.assignee_id
    ${accessWhere}
    ORDER BY
      CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END,
      t.due_date ASC,
      t.updated_at DESC
    LIMIT 8
  `, params);

  res.json({
    summary: summary.rows[0],
    upcoming: recentTasks.rows
  });
}));

app.get("/api/users", requireAuth, asyncRoute(async (req, res) => {
  const users = await query(
    "SELECT id, name, email, role, created_at FROM users ORDER BY name ASC"
  );
  res.json({ users: users.rows });
}));

app.patch("/api/users/:id/role", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  requireFields(req.body, ["role"]);

  if (!["Admin", "Member"].includes(req.body.role)) {
    return res.status(400).json({ message: "Role must be Admin or Member." });
  }

  const result = await query(
    "UPDATE users SET role = $1 WHERE id = $2 RETURNING id, name, email, role, created_at",
    [req.body.role, req.params.id]
  );

  if (!result.rowCount) {
    return res.status(404).json({ message: "User not found." });
  }

  res.json({ user: result.rows[0] });
}));

app.get("/api/projects", requireAuth, asyncRoute(async (req, res) => {
  const params = [];
  let where = "";

  if (req.user.role !== "Admin") {
    params.push(req.user.id);
    where = "WHERE pm.user_id = $1";
  }

  const projects = await query(`
    SELECT
      p.*,
      u.name AS owner_name,
      COUNT(DISTINCT pm_all.user_id)::int AS member_count,
      COUNT(DISTINCT t.id)::int AS task_count,
      COUNT(DISTINCT t.id) FILTER (WHERE t.status = 'Done')::int AS done_count
    FROM projects p
    LEFT JOIN users u ON u.id = p.owner_id
    LEFT JOIN project_members pm_all ON pm_all.project_id = p.id
    LEFT JOIN tasks t ON t.project_id = p.id
    ${req.user.role !== "Admin" ? "JOIN project_members pm ON pm.project_id = p.id" : ""}
    ${where}
    GROUP BY p.id, u.name
    ORDER BY p.updated_at DESC, p.created_at DESC
  `, params);

  res.json({ projects: projects.rows });
}));

app.post("/api/projects", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  requireFields(req.body, ["name"]);

  const result = await query(
    `INSERT INTO projects (name, description, status, owner_id)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [
      req.body.name.trim(),
      (req.body.description || "").trim(),
      req.body.status || "Active",
      req.user.id
    ]
  );

  await query(
    "INSERT INTO project_members (project_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [result.rows[0].id, req.user.id]
  );

  res.status(201).json({ project: result.rows[0] });
}));

app.get("/api/projects/:id", requireAuth, asyncRoute(async (req, res) => {
  if (!(await canAccessProject(req.user, req.params.id))) {
    return res.status(403).json({ message: "You do not have access to this project." });
  }

  const project = await query("SELECT * FROM projects WHERE id = $1", [req.params.id]);
  if (!project.rowCount) {
    return res.status(404).json({ message: "Project not found." });
  }

  const members = await query(`
    SELECT u.id, u.name, u.email, u.role, pm.created_at AS joined_at
    FROM project_members pm
    JOIN users u ON u.id = pm.user_id
    WHERE pm.project_id = $1
    ORDER BY u.name ASC
  `, [req.params.id]);

  res.json({ project: project.rows[0], members: members.rows });
}));

app.patch("/api/projects/:id", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const result = await query(
    `UPDATE projects
     SET name = COALESCE($1, name),
         description = COALESCE($2, description),
         status = COALESCE($3, status),
         updated_at = NOW()
     WHERE id = $4
     RETURNING *`,
    [
      req.body.name ? req.body.name.trim() : null,
      req.body.description === undefined ? null : String(req.body.description).trim(),
      req.body.status || null,
      req.params.id
    ]
  );

  if (!result.rowCount) {
    return res.status(404).json({ message: "Project not found." });
  }

  res.json({ project: result.rows[0] });
}));

app.delete("/api/projects/:id", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const result = await query("DELETE FROM projects WHERE id = $1 RETURNING id", [req.params.id]);
  if (!result.rowCount) {
    return res.status(404).json({ message: "Project not found." });
  }
  res.status(204).send();
}));

app.post("/api/projects/:id/members", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  requireFields(req.body, ["userId"]);

  const project = await query("SELECT id FROM projects WHERE id = $1", [req.params.id]);
  if (!project.rowCount) {
    return res.status(404).json({ message: "Project not found." });
  }

  const user = await query("SELECT id FROM users WHERE id = $1", [req.body.userId]);
  if (!user.rowCount) {
    return res.status(404).json({ message: "User not found." });
  }

  await query(
    "INSERT INTO project_members (project_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [req.params.id, req.body.userId]
  );

  res.status(201).json({ message: "Member added." });
}));

app.delete("/api/projects/:id/members/:userId", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  await query(
    "DELETE FROM project_members WHERE project_id = $1 AND user_id = $2",
    [req.params.id, req.params.userId]
  );
  res.status(204).send();
}));

app.get("/api/tasks", requireAuth, asyncRoute(async (req, res) => {
  const params = [];
  const clauses = [];

  if (req.user.role !== "Admin") {
    params.push(req.user.id);
    clauses.push(`t.project_id IN (
      SELECT project_id FROM project_members WHERE user_id = $${params.length}
    )`);
  }

  if (req.query.projectId) {
    params.push(req.query.projectId);
    clauses.push(`t.project_id = $${params.length}`);
  }

  if (req.query.status) {
    params.push(req.query.status);
    clauses.push(`t.status = $${params.length}`);
  }

  if (req.query.assigneeId) {
    params.push(req.query.assigneeId);
    clauses.push(`t.assignee_id = $${params.length}`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const tasks = await query(`
    SELECT
      t.*,
      t.due_date::text AS due_date,
      p.name AS project_name,
      assignee.name AS assignee_name,
      creator.name AS creator_name
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    LEFT JOIN users assignee ON assignee.id = t.assignee_id
    LEFT JOIN users creator ON creator.id = t.created_by
    ${where}
    ORDER BY t.updated_at DESC
  `, params);

  res.json({ tasks: tasks.rows });
}));

app.post("/api/tasks", requireAuth, asyncRoute(async (req, res) => {
  requireFields(req.body, ["projectId", "title"]);

  if (!(await canAccessProject(req.user, req.body.projectId))) {
    return res.status(403).json({ message: "You do not have access to this project." });
  }

  if (req.body.assigneeId && !(await isProjectMember(req.body.projectId, req.body.assigneeId))) {
    return res.status(400).json({ message: "Assignee must be a project member." });
  }

  const result = await query(
    `INSERT INTO tasks
       (project_id, title, description, assignee_id, status, priority, due_date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      req.body.projectId,
      req.body.title.trim(),
      (req.body.description || "").trim(),
      req.body.assigneeId || null,
      req.body.status || "Todo",
      req.body.priority || "Medium",
      req.body.dueDate || null,
      req.user.id
    ]
  );

  await query("UPDATE projects SET updated_at = NOW() WHERE id = $1", [req.body.projectId]);
  res.status(201).json({ task: result.rows[0] });
}));

app.patch("/api/tasks/:id", requireAuth, asyncRoute(async (req, res) => {
  const existing = await query("SELECT * FROM tasks WHERE id = $1", [req.params.id]);
  const task = existing.rows[0];

  if (!task) {
    return res.status(404).json({ message: "Task not found." });
  }

  if (!(await canAccessProject(req.user, task.project_id))) {
    return res.status(403).json({ message: "You do not have access to this task." });
  }

  const canEditAll = req.user.role === "Admin" || task.created_by === req.user.id;
  const isAssignee = task.assignee_id === req.user.id;

  if (!canEditAll && !isAssignee) {
    return res.status(403).json({ message: "You can only update tasks assigned to you." });
  }

  if (!canEditAll) {
    const allowed = Object.keys(req.body).every((key) => ["status"].includes(key));
    if (!allowed) {
      return res.status(403).json({ message: "Members assigned to a task can update status only." });
    }
  }

  if (req.body.assigneeId && !(await isProjectMember(task.project_id, req.body.assigneeId))) {
    return res.status(400).json({ message: "Assignee must be a project member." });
  }

  const updates = [];
  const params = [];
  const addUpdate = (column, value) => {
    params.push(value);
    updates.push(`${column} = $${params.length}`);
  };

  if (req.body.title !== undefined) addUpdate("title", String(req.body.title).trim());
  if (req.body.description !== undefined) addUpdate("description", String(req.body.description).trim());
  if (req.body.assigneeId !== undefined) addUpdate("assignee_id", req.body.assigneeId || null);
  if (req.body.status !== undefined) addUpdate("status", req.body.status);
  if (req.body.priority !== undefined) addUpdate("priority", req.body.priority);
  if (req.body.dueDate !== undefined) addUpdate("due_date", req.body.dueDate || null);

  if (!updates.length) {
    return res.json({ task });
  }

  params.push(req.params.id);
  const result = await query(
    `UPDATE tasks
     SET ${updates.join(", ")}, updated_at = NOW()
     WHERE id = $${params.length}
     RETURNING *`,
    params
  );

  await query("UPDATE projects SET updated_at = NOW() WHERE id = $1", [task.project_id]);
  res.json({ task: result.rows[0] });
}));

app.delete("/api/tasks/:id", requireAuth, asyncRoute(async (req, res) => {
  const existing = await query("SELECT * FROM tasks WHERE id = $1", [req.params.id]);
  const task = existing.rows[0];

  if (!task) {
    return res.status(404).json({ message: "Task not found." });
  }

  if (req.user.role !== "Admin" && task.created_by !== req.user.id) {
    return res.status(403).json({ message: "Only admins or task creators can delete tasks." });
  }

  await query("DELETE FROM tasks WHERE id = $1", [req.params.id]);
  res.status(204).send();
}));

app.use("/api", (req, res) => {
  res.status(404).json({ message: "API route not found." });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({
    message: err.status ? err.message : "Something went wrong."
  });
});

initDb()
  .then(() => {
    app.listen(port, () => {
      console.log(`Task Tracker running on port ${port}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize database:", error);
    process.exit(1);
  });
