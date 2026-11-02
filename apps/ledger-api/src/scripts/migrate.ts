import { openV1Db } from '../db/client.ts';
import { dbPathFromUrl } from '../db/identity.ts';
import { ENV_PREFIX } from '../env.ts';
import { defaultDbUrl, legacyDbPaths, loadV1Env } from '../node.ts';

// Same path as the server start: identity check first, then only the v1 migrations.
loadV1Env();
const url = process.env[`${ENV_PREFIX}DATABASE_URL`] ?? defaultDbUrl();
const { client, identity, applied } = await openV1Db(url, { legacyPaths: legacyDbPaths() });
client.close();
console.info(`${dbPathFromUrl(url)}: ${identity === 'empty' ? 'initialized, ' : ''}${applied} migration(s) applied`);
