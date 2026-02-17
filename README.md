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

These must be provided via the container `.env` (ask the orchestrator/user to set them; do not hardcode):

- `PGHOST`
- `PGPORT`
- `PGUSER`
- `PGPASSWORD`
- `PGDATABASE`

Optional:

- `PGSSL` (`true`/`false`, default `false`)
- `PGPOOL_MAX` (default `5`)
- `PGTOOL_QUERY_TIMEOUT_MS` (default `15000`)
- `PGTOOL_MAX_ROWS` (default `500`)
- `PGLOG_LEVEL` (`error|warn|info|debug`, default `info`)

### Run (stdio MCP)

```bash
cd mcp_server_backend
npm run mcp:db
```

The server communicates over stdio (stdout reserved for MCP protocol messages). Logs are written to stderr.
