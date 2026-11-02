import { readFileSync } from 'node:fs';

// Historical suite names describe the scenarios; emitted metadata identifies the current release.
export const PRODUCT_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
