import { openLibsql } from '../db/client.ts';
import { defaultDbUrl, loadDotEnv } from '../node.ts';

loadDotEnv();
const url = process.env.DATABASE_URL ?? defaultDbUrl();
await openLibsql(url); // applies pending migrations
console.info(`migrations applied to ${url}`);
