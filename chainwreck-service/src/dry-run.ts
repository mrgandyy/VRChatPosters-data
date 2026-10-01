import { resolve, join } from 'node:path';
import { Store } from './db.js';
import { publishGroup } from './publish.js';

const dataDir = resolve(process.env.CHAINWRECK_DATA_DIR ?? './data');
const store = new Store(join(dataDir,'chainwreck.sqlite'));
try {
  console.log(await publishGroup(store,0,{
    branch: process.env.GITHUB_BRANCH ?? 'main',
    publicBase: process.env.GITHUB_PUBLIC_BASE ?? 'https://example.github.io/chainwreck',
    defaultsDir: resolve(process.env.CHAINWRECK_DEFAULTS_DIR ?? './defaults'),
    dataDir,dryRun:true
  }));
} finally { store.close(); }
