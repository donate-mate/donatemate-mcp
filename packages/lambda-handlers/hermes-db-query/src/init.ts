/** Provision/update the database-enforced login used by the Hermes read-only query Lambda. */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import postgres from 'postgres';
import type { CdkCustomResourceEvent, CdkCustomResourceResponse } from 'aws-lambda';

const secrets = new SecretsManagerClient({});
const ROLE_NAME = 'hermes_staging_reader';

interface DatabaseSecret {
  host: string;
  port?: string | number;
  dbname: string;
  username: string;
  password: string;
}

async function readSecret(arn: string): Promise<DatabaseSecret> {
  const response = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
  return JSON.parse(response.SecretString || '{}') as DatabaseSecret;
}

function identifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function provisionReader(): Promise<void> {
  const masterArn = process.env.MASTER_SECRET_ARN;
  const readerArn = process.env.READER_SECRET_ARN;
  if (!masterArn || !readerArn) throw new Error('database secret ARNs are not configured');
  const [master, reader] = await Promise.all([readSecret(masterArn), readSecret(readerArn)]);
  if (!master.host || !master.dbname || !master.username || !master.password || !reader.password) {
    throw new Error('database credential secret is incomplete');
  }

  const sql = postgres({
    host: master.host,
    port: Number(master.port ?? 5432),
    database: master.dbname,
    username: master.username,
    password: master.password,
    ssl: 'require',
    max: 1,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: 'hermes-reader-provisioner' },
  });
  const role = identifier(ROLE_NAME);

  try {
    await sql.begin(async (tx) => {
      const existing = await tx.unsafe<{ exists: boolean }[]>(
        'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
        [ROLE_NAME]
      );
      if (existing[0]?.exists) {
        await tx.unsafe(`ALTER ROLE ${role} PASSWORD ${literal(reader.password)}`);
      } else {
        await tx.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD ${literal(reader.password)}`);
      }

      await tx.unsafe(
        `ALTER ROLE ${role} NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3`
      );
      await tx.unsafe(`ALTER ROLE ${role} SET default_transaction_read_only = on`);
      await tx.unsafe(`ALTER ROLE ${role} SET statement_timeout = '10s'`);
      await tx.unsafe(`ALTER ROLE ${role} SET lock_timeout = '1s'`);
      await tx.unsafe(`ALTER ROLE ${role} SET idle_in_transaction_session_timeout = '15s'`);
      await tx.unsafe(`REVOKE ALL PRIVILEGES ON DATABASE ${identifier(master.dbname)} FROM ${role}`);
      await tx.unsafe(`GRANT CONNECT ON DATABASE ${identifier(master.dbname)} TO ${role}`);
      await tx.unsafe(`GRANT pg_read_all_data TO ${role}`);
      await tx.unsafe(`REVOKE pg_write_all_data FROM ${role}`);
    });
  } finally {
    await sql.end();
  }
}

export async function handler(event: CdkCustomResourceEvent): Promise<CdkCustomResourceResponse> {
  const PhysicalResourceId = 'hermes-staging-db-reader-role';
  if (event.RequestType === 'Delete') return { PhysicalResourceId, Data: {} };

  // The CDK Provider framework reports a failed deployment only when this handler throws.
  // Returning a CloudFormation-shaped { Status: 'FAILED' } object would be treated as success.
  await provisionReader();
  return {
    PhysicalResourceId,
    Data: { RoleName: ROLE_NAME, ReadOnly: true },
  };
}
