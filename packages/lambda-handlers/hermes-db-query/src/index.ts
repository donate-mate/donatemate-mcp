/**
 * Narrow, IAM-only staging database query gateway for Hermes investigations.
 *
 * The database login is independently read-only. This handler adds defense-in-depth: one statement,
 * explicit read statement families, a read-only transaction, a short timeout, a row cap, and no raw
 * SQL/result logging. It is intentionally not attached to API Gateway.
 */
import { createHash } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import postgres, { type Sql } from 'postgres';
import type { Context } from 'aws-lambda';

const secrets = new SecretsManagerClient({});
const MAX_SQL_CHARS = Number(process.env.MAX_SQL_CHARS ?? 20_000);
const DEFAULT_MAX_ROWS = Number(process.env.DEFAULT_MAX_ROWS ?? 100);
const HARD_MAX_ROWS = Number(process.env.HARD_MAX_ROWS ?? 200);
const STATEMENT_TIMEOUT_MS = Number(process.env.STATEMENT_TIMEOUT_MS ?? 10_000);
const MAX_RESPONSE_BYTES = Number(process.env.MAX_RESPONSE_BYTES ?? 750_000);
const ALLOWED_START = /^(select|with|values|show|explain)\b/i;
const FORBIDDEN =
  /\b(insert|update|delete|merge|copy|call|do|create|alter|drop|truncate|grant|revoke|comment|refresh|vacuum|analyze|cluster|reindex|set|reset|listen|notify|prepare|execute|deallocate|lock|discard|nextval|setval|set_config|lo_import|lo_export|pg_sleep|pg_terminate_backend|pg_cancel_backend|dblink_connect|aws_s3)\b/i;

interface ReaderSecret {
  host: string;
  port?: string | number;
  dbname: string;
  username: string;
  password: string;
}

export interface QueryRequest {
  sql: string;
  parameters?: postgres.ParameterOrJSON<never>[];
  maxRows?: number;
  ticket?: string;
}

export interface PreparedReadQuery {
  sql: string;
  parameters: postgres.ParameterOrJSON<never>[];
  maxRows: number;
  kind: 'select' | 'with' | 'values' | 'show' | 'explain';
}

let db: Sql | undefined;

function stripComments(value: string): string {
  return value.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\r\n]*/g, ' ').trim();
}

export function prepareReadOnlyQuery(request: QueryRequest): PreparedReadQuery {
  if (!request || typeof request.sql !== 'string') throw new Error('sql must be a string');
  const trimmed = request.sql.trim();
  if (!trimmed) throw new Error('sql must not be empty');
  if (trimmed.length > MAX_SQL_CHARS) throw new Error(`sql exceeds ${MAX_SQL_CHARS} characters`);

  // Permit one optional trailing semicolon, but never multiple statements.
  const statement = trimmed.replace(/;\s*$/, '').trim();
  if (statement.includes(';')) throw new Error('only one SQL statement is allowed');
  const inspected = stripComments(statement);
  const start = inspected.match(ALLOWED_START)?.[1]?.toLowerCase() as PreparedReadQuery['kind'] | undefined;
  if (!start) throw new Error('only SELECT, WITH, VALUES, SHOW, or EXPLAIN statements are allowed');
  if (FORBIDDEN.test(inspected)) throw new Error('the statement contains a write, session, or unsafe function keyword');
  if (start === 'explain' && /\banalyze\b/i.test(inspected)) throw new Error('EXPLAIN ANALYZE is not allowed');
  if (start === 'show' && !/^show\s+[a-z_][a-z0-9_.]*$/i.test(inspected)) throw new Error('invalid SHOW statement');

  const requestedRows = Number.isFinite(request.maxRows) ? Math.floor(Number(request.maxRows)) : DEFAULT_MAX_ROWS;
  const maxRows = Math.max(1, Math.min(HARD_MAX_ROWS, requestedRows));
  const parameters = request.parameters ?? [];
  if (!Array.isArray(parameters) || parameters.length > 100) throw new Error('parameters must be an array with at most 100 values');
  let serializedParameters: string;
  try {
    serializedParameters = JSON.stringify(parameters);
  } catch {
    throw new Error('parameters must be JSON-serializable');
  }
  if (Buffer.byteLength(serializedParameters, 'utf8') > 20_000) throw new Error('parameters exceed 20000 bytes');

  const sql =
    start === 'select' || start === 'with' || start === 'values'
      ? `SELECT * FROM (${statement}) AS hermes_readonly_result LIMIT ${maxRows + 1}`
      : statement;
  return { sql, parameters, maxRows, kind: start };
}

async function getDatabase(): Promise<Sql> {
  if (db) return db;
  const secretArn = process.env.READER_SECRET_ARN;
  if (!secretArn) throw new Error('READER_SECRET_ARN is not configured');
  const response = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const value = JSON.parse(response.SecretString || '{}') as ReaderSecret;
  if (!value.host || !value.dbname || !value.username || !value.password) {
    throw new Error('staging reader secret is incomplete');
  }
  db = postgres({
    host: value.host,
    port: Number(value.port ?? 5432),
    database: value.dbname,
    username: value.username,
    password: value.password,
    ssl: 'require',
    max: 1,
    connect_timeout: 5,
    idle_timeout: 10,
    max_lifetime: 5 * 60,
    connection: { application_name: 'hermes-staging-db-readonly' },
  });
  return db;
}

function parseEvent(event: unknown): QueryRequest {
  if (typeof event === 'string') return JSON.parse(event) as QueryRequest;
  if (!event || typeof event !== 'object') throw new Error('query payload must be a JSON object');
  return event as QueryRequest;
}

function boundedInteger(value: number, fallback: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value))) : fallback;
}

function fitRowsToResponse(rows: unknown[], maxBytes: number): { rows: unknown[]; responseLimited: boolean } {
  if (Buffer.byteLength(JSON.stringify(rows), 'utf8') <= maxBytes) return { rows, responseLimited: false };
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(rows.slice(0, midpoint)), 'utf8') <= maxBytes) low = midpoint;
    else high = midpoint - 1;
  }
  if (low === 0 && rows.length > 0) throw new Error('the first result row exceeds the response-size limit');
  return { rows: rows.slice(0, low), responseLimited: true };
}

export async function handler(event: unknown, context: Context): Promise<Record<string, unknown>> {
  const request = parseEvent(event);
  const prepared = prepareReadOnlyQuery(request);
  const queryHash = createHash('sha256').update(request.sql).digest('hex').slice(0, 16);
  const startedAt = Date.now();
  const sql = await getDatabase();
  const statementTimeoutMs = boundedInteger(STATEMENT_TIMEOUT_MS, 10_000, 1_000, 10_000);
  const responseLimitBytes = boundedInteger(MAX_RESPONSE_BYTES, 750_000, 10_000, 1_000_000);

  const result = await sql.begin('read only', async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);
    await tx.unsafe("SET LOCAL lock_timeout = '1000ms'");
    return tx.unsafe(prepared.sql, prepared.parameters);
  });
  const cappedRows = Array.from(result).slice(0, prepared.maxRows);
  const fitted = fitRowsToResponse(cappedRows, responseLimitBytes);
  const rows = fitted.rows;
  const truncated = result.length > prepared.maxRows || fitted.responseLimited;
  const columns = result.columns?.map((column) => column.name) ?? (rows[0] ? Object.keys(rows[0] as object) : []);
  const elapsedMs = Date.now() - startedAt;

  // Audit only metadata. Raw SQL and returned staging data must not enter CloudWatch logs.
  console.log(
    JSON.stringify({
      event: 'hermes_staging_db_read',
      requestId: context.awsRequestId,
      ticket: String(request.ticket ?? '').slice(0, 32),
      kind: prepared.kind,
      queryHash,
      rowCount: rows.length,
      truncated,
      responseLimited: fitted.responseLimited,
      elapsedMs,
    })
  );

  return {
    readOnly: true,
    columns,
    rows,
    rowCount: rows.length,
    truncated,
    responseLimited: fitted.responseLimited,
    maxRows: prepared.maxRows,
    elapsedMs,
  };
}
