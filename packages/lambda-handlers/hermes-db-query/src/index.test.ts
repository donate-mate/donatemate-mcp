import { describe, expect, it } from 'vitest';
import { prepareReadOnlyQuery } from './index.js';

describe('prepareReadOnlyQuery', () => {
  it('wraps a select with a hard result limit', () => {
    const query = prepareReadOnlyQuery({ sql: 'SELECT id FROM donations WHERE id = $1', parameters: ['abc'], maxRows: 25 });
    expect(query.kind).toBe('select');
    expect(query.parameters).toEqual(['abc']);
    expect(query.sql).toContain('LIMIT 26');
  });

  it('caps requested rows at the configured hard maximum', () => {
    expect(prepareReadOnlyQuery({ sql: 'SELECT 1', maxRows: 100_000 }).maxRows).toBe(200);
  });

  it.each([
    'UPDATE donations SET amount = 0',
    'WITH changed AS (DELETE FROM donations RETURNING *) SELECT * FROM changed',
    "SELECT nextval('donations_id_seq')",
    "SELECT set_config('statement_timeout', '0', false)",
    'SELECT pg_terminate_backend(123)',
    'SELECT 1; SELECT 2',
    'EXPLAIN ANALYZE SELECT * FROM donations',
  ])('rejects unsafe SQL: %s', (sql) => {
    expect(() => prepareReadOnlyQuery({ sql })).toThrow();
  });

  it('allows narrow metadata reads', () => {
    expect(prepareReadOnlyQuery({ sql: "SELECT column_name FROM information_schema.columns WHERE table_name = $1", parameters: ['donations'] }).kind).toBe('select');
    expect(prepareReadOnlyQuery({ sql: 'SHOW server_version' }).kind).toBe('show');
  });
});
