# mcp-server-scaffold-53172-53186

This workspace contains an Express scaffold (`mcp_server_backend`) and a stdio MCP server implementation.

## MCP stdio server: MCP-database-server

Location: `mcp_server_backend/src/mcp/database_server.js`

### Install dependencies

```bash
cd mcp_server_backend
npm install
```

### Required environment variables

These must be provided via the container `.env` (ask the orchestrator/user to set them; do not hardcode).

This repository also includes a Postgres **database container** at `mcp-server-scaffold-53172-53187/database`.
That container’s `startup.sh` starts PostgreSQL with these defaults:

- Host: `localhost`
- Port: `5000`
- Database: `myapp`
- User: `appuser`
- Password: `dbuser123`

A connection helper is written to: `mcp-server-scaffold-53172-53187/database/db_connection.txt`:
`psql postgresql://appuser:dbuser123@localhost:5000/myapp`

Set the MCP server env vars to match the running Postgres:

- `PGHOST` (e.g. `localhost`)
- `PGPORT` (e.g. `5000`)
- `PGUSER` (e.g. `appuser`)
- `PGPASSWORD` (e.g. `dbuser123`)
- `PGDATABASE` (e.g. `myapp`)

Optional:

- `PGSSL` (`true`/`false`, default `false`)
- `PGPOOL_MAX` (default `5`)
- `PGTOOL_QUERY_TIMEOUT_MS` (default `15000`)
- `PGTOOL_MAX_ROWS` (default `500`)
- `PGLOG_LEVEL` (`error|warn|info|debug`, default `info`)

### Run (stdio MCP)

1) Ensure the database container is started (Postgres listens on port `5000`):
- In Kavia multi-container runs, `mcp_server_backend` depends on `database` (see `.project_manifest.yaml`) so DB should start first.
- If running manually, start it by running `mcp-server-scaffold-53172-53187/database/startup.sh`.

2) Run the MCP stdio server:
```bash
cd mcp_server_backend
npm run mcp:db
```

Notes:
- The server communicates over stdio (stdout reserved for MCP protocol messages).
- Logs are written to stderr.
- If you run `mcp:db` in a different environment than the DB container, ensure `PGHOST/PGPORT` point to a reachable address/port for that Postgres instance (for local dev with this repo’s DB container: `PGHOST=localhost`, `PGPORT=5000`).
