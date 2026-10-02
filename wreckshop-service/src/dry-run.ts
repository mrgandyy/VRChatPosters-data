import { resolve, join } from 'node:path';
import { Store } from './db.js';
import { publishGroup } from './publish.js';
import { databasePath } from './branding.js';

const dataDir = resolve(process.env.WRECKSHOP_DATA_DIR ?? './data');
const store = new Store(await databasePath(dataDir));
try {
  console.log(await publishGroup(store,0,{
    branch: process.env.GITHUB_BRANCH ?? 'main',
    publicBase: process.env.GITHUB_PUBLIC_BASE ?? 'https://example.github.io/wreckshop',
    defaultsDir: resolve(process.env.WRECKSHOP_DEFAULTS_DIR ?? './defaults'),
    dataDir,dryRun:true
  }));
} finally { store.close(); }
