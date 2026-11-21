# Frontdesk

Support ticket system for Arvo Systems, built with PostgreSQL, Express, React and Node (PERN).

- Agents: `/agent`
- Customers: `/new` (opens a ticket and gives a private link to follow it)

## Run locally

Requires Node 20+ and PostgreSQL 14+.

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create an empty database named `frontdesk` (pgAdmin, or `createdb frontdesk`).
3. Copy `.env.example` to `.env` (`cp` on macOS/Linux, `copy` on Windows) and set:
   ```
   DATABASE_URL=postgres://postgres:YOUR_PASSWORD@localhost:5432/frontdesk
   JWT_SECRET=any-long-random-text
   SEED_PASSWORD=frontdesk123
   SEED_DEMO=true
   ```
   URL-encode special characters in the password (`@` becomes `%40`).
4. Build the frontend and start the server:
   ```bash
   npm run build
   npm start
   ```
5. Open http://localhost:3000

Tables, the 9 demo agents and (with `SEED_DEMO=true`) sample tickets are created automatically on first start.

## Demo logins

Password for all agents: `frontdesk123`

- `meera@arvo.test` (manager)
- `arjun@arvo.test`, `divya@arvo.test`, `rahul@arvo.test`, ...
