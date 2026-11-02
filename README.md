This separates your architecture cleanly into two distinct services:

Frontend / Gateway Worker (aisys): Serves static assets, waitlist KV, and client-facing API routes. It has no direct D1 database binding or SQL statements.

Database Worker (aisys-db): A private backend Worker containing your D1 database binding, schema.json, table DDL execution, password hashing, and user authentication queries. It has no public route and can only be invoked internally.
Browser
   │
   ▼
┌────────────────────────────────────────────────────────┐
│  Worker: aisys (Public: aisys.cam)                     │
│  - Serves public/ (HTML, CSS, JS)                      │
│  - Handles /api/waitlist (KV)                          │
│  - Calls env.DB_SERVICE via internal RPC               │
└──────────────────────────┬─────────────────────────────┘
                           │ (Private zero-latency RPC)
                           ▼
┌────────────────────────────────────────────────────────┐
│  Worker: aisys-db (Private Service)                    │
│  - Holds D1 binding (env.DB)                           │
│  - Runs schema.json table checks                       │
│  - Executes SQL queries & SHA-256 auth                 │
└────────────────────────────────────────────────────────┘
