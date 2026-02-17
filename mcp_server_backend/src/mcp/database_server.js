'use strict';

/**
 * MCP-database-server (stdio)
 *
 * This server implements an MCP stdio server that exposes safe tools for querying and
 * managing a PostgreSQL database.
 *
 * IMPORTANT:
 * - Writes protocol messages to stdout via the MCP SDK transport.
 * - Writes logs ONLY to stderr to avoid corrupting the stdio protocol stream.
 *
 * Environment variables required (request user/orchestrator to set them in .env):
 * - PGHOST: PostgreSQL host
 * - PGPORT: PostgreSQL port (already present in this container env list; may be repurposed)
 * - PGUSER: PostgreSQL user
 * - PGPASSWORD: PostgreSQL password
 * - PGDATABASE: PostgreSQL database name
 * Optional:
 * - PGSSL: "true" or "false" (default: false)
 * - PGPOOL_MAX: integer (default: 5)
 * - PGTOOL_QUERY_TIMEOUT_MS: integer (default: 15000)
 * - PGTOOL_MAX_ROWS: integer (default: 500)
 */

const process = require('process');
const dotenv = require('dotenv');
const { Pool } = require('pg');

const {
  McpServer,
} = require('@modelcontextprotocol/sdk/server/mcp.js');
const {
  StdioServerTransport,
} = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('@modelcontextprotocol/sdk/shared/zod.js');

dotenv.config();

/**
 * Very small stderr logger to avoid stdout pollution.
 */
class StderrLogger {
  constructor(level) {
    this.level = level || 'info';
    this.levels = { error: 0, warn: 1, info: 2, debug: 3 };
  }

  shouldLog(level) {
    const cur = this.levels[this.level] ?? 2;
    const incoming = this.levels[level] ?? 2;
    return incoming <= cur;
  }

  error(msg, extra) {
    if (!this.shouldLog('error')) return;
    process.stderr.write(`[error] ${msg}${extra ? ` ${JSON.stringify(extra)}` : ''}\n`);
  }

  warn(msg, extra) {
    if (!this.shouldLog('warn')) return;
    process.stderr.write(`[warn] ${msg}${extra ? ` ${JSON.stringify(extra)}` : ''}\n`);
  }

  info(msg, extra) {
    if (!this.shouldLog('info')) return;
    process.stderr.write(`[info] ${msg}${extra ? ` ${JSON.stringify(extra)}` : ''}\n`);
  }

  debug(msg, extra) {
    if (!this.shouldLog('debug')) return;
    process.stderr.write(`[debug] ${msg}${extra ? ` ${JSON.stringify(extra)}` : ''}\n`);
  }
}

const logger = new StderrLogger(process.env.PGLOG_LEVEL || 'info');

function parseBool(val, defaultValue) {
  if (val === undefined || val === null || val === '') return defaultValue;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(val).toLowerCase());
}

function parseIntEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  const parsed = Number.parseInt(String(raw), 10);
  if (Number.isNaN(parsed)) return defaultValue;
  return parsed;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
      'Ask the orchestrator/user to set it in the container .env.'
    );
  }
  return value;
}

/**
 * Ensures we never return huge results over MCP.
 */
function enforceRowLimit(rows, maxRows) {
  if (!Array.isArray(rows)) return rows;
  if (rows.length <= maxRows) return rows;
  return rows.slice(0, maxRows);
}

/**
 * A conservative heuristic to detect if SQL is likely read-only.
 * Not a security boundary; we still provide an explicit allowUnsafe flag.
 */
function looksReadOnlySql(sql) {
  const s = String(sql).trim().toLowerCase();
  // allow WITH ... SELECT ...
  if (s.startsWith('select') || s.startsWith('with')) return true;

  // explicit disallow common write/ddl keywords at the beginning
  const forbidden = [
    'insert', 'update', 'delete', 'drop', 'alter', 'create', 'truncate',
    'grant', 'revoke', 'comment', 'vacuum', 'analyze', 'refresh',
    'call', 'do', 'copy',
  ];
  return !forbidden.some((kw) => s.startsWith(kw));
}

/**
 * Convert query results to a compact, safe response.
 */
function toQueryResponse(result, maxRows) {
  const rows = enforceRowLimit(result.rows || [], maxRows);
  return {
    rowCount: result.rowCount ?? rows.length,
    fields: (result.fields || []).map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
    rows,
    truncated: Array.isArray(result.rows) ? (result.rows.length > rows.length) : false,
  };
}

/**
 * Create a pg Pool from env vars.
 */
function createPoolFromEnv() {
  const host = requiredEnv('PGHOST');
  const user = requiredEnv('PGUSER');
  const password = requiredEnv('PGPASSWORD');
  const database = requiredEnv('PGDATABASE');

  // Note: container_env includes PGPORT already; we still support default 5432 if not set.
  const port = parseIntEnv('PGPORT', 5432);
  const ssl = parseBool(process.env.PGSSL, false);

  const max = parseIntEnv('PGPOOL_MAX', 5);

  return new Pool({
    host,
    port,
    user,
    password,
    database,
    max,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
  });
}

/**
 * Wrap a promise with a timeout.
 */
function withTimeout(promise, timeoutMs, timeoutMessage) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  // pg doesn't support AbortController directly; we still use the timer to reject.
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(timeoutMessage || `Operation timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]).finally(() => {
    clearTimeout(timeout);
    // just in case we use controller in future
    void controller;
  });
}

async function main() {
  const pool = createPoolFromEnv();
  const maxRows = parseIntEnv('PGTOOL_MAX_ROWS', 500);
  const queryTimeoutMs = parseIntEnv('PGTOOL_QUERY_TIMEOUT_MS', 15000);

  const server = new McpServer({
    name: 'MCP-database-server',
    version: '1.0.0',
  });

  // Tool: health / connectivity
  server.tool(
    'pg_healthcheck',
    'Checks database connectivity and returns server version + current database.',
    {},
    async () => {
      try {
        const res = await withTimeout(
          pool.query('select version() as version, current_database() as db, now() as now'),
          queryTimeoutMs,
          'Healthcheck timed out'
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ok: true, ...res.rows[0] }, null, 2),
            },
          ],
        };
      } catch (err) {
        logger.error('pg_healthcheck failed', { message: err.message });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ok: false, error: err.message }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Tool: list schemas
  server.tool(
    'pg_list_schemas',
    'Lists non-system schemas (and optionally system schemas).',
    {
      includeSystem: z.boolean().optional().describe('Include pg_catalog and information_schema (default: false).'),
    },
    async ({ includeSystem }) => {
      try {
        const sql = includeSystem
          ? 'select schema_name from information_schema.schemata order by schema_name'
          : `select schema_name
             from information_schema.schemata
            where schema_name not in ('pg_catalog', 'information_schema')
            order by schema_name`;

        const res = await withTimeout(pool.query(sql), queryTimeoutMs, 'List schemas timed out');
        const rows = enforceRowLimit(res.rows, maxRows);
        return {
          content: [{ type: 'text', text: JSON.stringify({ schemas: rows.map((r) => r.schema_name) }, null, 2) }],
        };
      } catch (err) {
        logger.error('pg_list_schemas failed', { message: err.message });
        return { content: [{ type: 'text', text: err.message }], isError: true };
      }
    }
  );

  // Tool: list tables
  server.tool(
    'pg_list_tables',
    'Lists tables for a given schema (default: public).',
    {
      schema: z.string().optional().describe('Schema name (default: public).'),
      limit: z.number().int().min(1).max(2000).optional().describe('Max tables to return (default: 200).'),
    },
    async ({ schema, limit }) => {
      const effectiveSchema = schema || 'public';
      const effectiveLimit = Math.min(limit || 200, 2000);

      try {
        const res = await withTimeout(
          pool.query(
            `select table_name
               from information_schema.tables
              where table_schema = $1
                and table_type = 'BASE TABLE'
              order by table_name
              limit $2`,
            [effectiveSchema, effectiveLimit]
          ),
          queryTimeoutMs,
          'List tables timed out'
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ schema: effectiveSchema, tables: res.rows.map((r) => r.table_name) }, null, 2),
            },
          ],
        };
      } catch (err) {
        logger.error('pg_list_tables failed', { message: err.message, schema: effectiveSchema });
        return { content: [{ type: 'text', text: err.message }], isError: true };
      }
    }
  );

  // Tool: describe table
  server.tool(
    'pg_describe_table',
    'Describes columns for a given table.',
    {
      schema: z.string().optional().describe('Schema name (default: public).'),
      table: z.string().min(1).describe('Table name.'),
    },
    async ({ schema, table }) => {
      const effectiveSchema = schema || 'public';
      try {
        const res = await withTimeout(
          pool.query(
            `select
               column_name,
               data_type,
               is_nullable,
               column_default
             from information_schema.columns
             where table_schema = $1
               and table_name = $2
             order by ordinal_position`,
            [effectiveSchema, table]
          ),
          queryTimeoutMs,
          'Describe table timed out'
        );

        return {
          content: [{ type: 'text', text: JSON.stringify({ schema: effectiveSchema, table, columns: res.rows }, null, 2) }],
        };
      } catch (err) {
        logger.error('pg_describe_table failed', { message: err.message, schema: effectiveSchema, table });
        return { content: [{ type: 'text', text: err.message }], isError: true };
      }
    }
  );

  // Tool: run SQL (read-only by default; allowUnsafe needed for writes/ddl)
  server.tool(
    'pg_query',
    'Executes a SQL query. By default only allows read-only queries; set allowUnsafe=true to run writes/DDL.',
    {
      sql: z.string().min(1).max(20000).describe('SQL statement to execute.'),
      params: z.array(z.any()).optional().describe('Optional positional parameters array for $1..$n.'),
      allowUnsafe: z.boolean().optional().describe('Allow non-read-only SQL (default: false).'),
      maxRows: z.number().int().min(1).max(5000).optional().describe('Override max rows returned (default env PGTOOL_MAX_ROWS).'),
      timeoutMs: z.number().int().min(100).max(120000).optional().describe('Override timeout in ms (default env PGTOOL_QUERY_TIMEOUT_MS).'),
    },
    async ({ sql, params, allowUnsafe, maxRows: maxRowsOverride, timeoutMs }) => {
      const effectiveMaxRows = Math.min(maxRowsOverride || maxRows, 5000);
      const effectiveTimeout = Math.min(timeoutMs || queryTimeoutMs, 120000);

      try {
        if (!allowUnsafe && !looksReadOnlySql(sql)) {
          return {
            content: [
              {
                type: 'text',
                text:
                  'Rejected potentially unsafe SQL (write/DDL). ' +
                  'If you intend to run it, re-run with allowUnsafe=true.',
              },
            ],
            isError: true,
          };
        }

        // Note: pg supports parameterized queries via $1..$n and params array.
        const res = await withTimeout(
          pool.query(sql, Array.isArray(params) ? params : undefined),
          effectiveTimeout,
          'Query timed out'
        );

        const response = toQueryResponse(res, effectiveMaxRows);
        return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
      } catch (err) {
        logger.error('pg_query failed', { message: err.message });
        return { content: [{ type: 'text', text: err.message }], isError: true };
      }
    }
  );

  const transport = new StdioServerTransport();

  // Graceful shutdown: close pool before exit
  const shutdown = async (signal) => {
    try {
      logger.info(`Received ${signal}; shutting down MCP-database-server...`);
      await pool.end();
      logger.info('PostgreSQL pool closed.');
    } catch (err) {
      logger.error('Error during shutdown', { message: err.message });
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

  logger.info('Starting MCP-database-server over stdio...');
  await server.connect(transport);
}

main().catch((err) => {
  // Do not write to stdout here.
  logger.error('Fatal error starting MCP-database-server', { message: err.message, stack: err.stack });
  process.exit(1);
});
