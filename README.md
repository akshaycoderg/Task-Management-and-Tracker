# Task Tracker

A full-stack project and task tracker with:

- Authentication: signup and login with JWT.
- Role-based access control: Admin and Member.
- Project and team management.
- Task creation, assignment, status tracking, priorities, and due dates.
- Dashboard metrics for tasks, statuses, and overdue work.
- REST APIs backed by PostgreSQL.
- Railway-ready deployment metadata.

## Local Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a PostgreSQL database named `task_tracker`.

3. Copy `.env.example` to `.env` and update `DATABASE_URL` and `JWT_SECRET`.

4. Start the app:

   ```bash
   npm run dev
   ```

5. Open `http://localhost:3000`.

The first user can create an Admin account. After that, new users become Members unless `ADMIN_SIGNUP_CODE` is configured and supplied during signup.

## Railway Deployment

1. Create a Railway project.
2. Add a PostgreSQL database service.
3. Add this app as a GitHub repo or deploy with the Railway CLI.
4. Set environment variables:

   - `DATABASE_URL`: Railway usually injects this from the PostgreSQL service.
   - `JWT_SECRET`: a long random value.
   - `ADMIN_SIGNUP_CODE`: optional.

5. Deploy. Railway will run `npm start`.

## REST API Overview

All protected endpoints require:

```http
Authorization: Bearer <jwt>
```

### Auth

- `POST /api/auth/signup`
- `POST /api/auth/login`
- `GET /api/auth/me`

### Dashboard

- `GET /api/dashboard`

### Users and Team

- `GET /api/users`
- `PATCH /api/users/:id/role` Admin only

### Projects

- `GET /api/projects`
- `POST /api/projects` Admin only
- `GET /api/projects/:id`
- `PATCH /api/projects/:id` Admin only
- `DELETE /api/projects/:id` Admin only
- `POST /api/projects/:id/members` Admin only
- `DELETE /api/projects/:id/members/:userId` Admin only

### Tasks

- `GET /api/tasks`
- `POST /api/tasks`
- `PATCH /api/tasks/:id`
- `DELETE /api/tasks/:id` Admin or task creator
