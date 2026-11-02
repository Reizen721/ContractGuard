#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = (data) => createHash('sha256').update(data).digest('hex');

/** Extract one regular executable only. No archive path is ever used as an output path. */
export function extractBinary(archive, binaryName) {
  const tar = gunzipSync(archive, { maxOutputLength: 200 * 1024 * 1024 });
  let found;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const name = field(0, 100);
    const prefix = field(345, 155);
    const sizeText = field(124, 12).trim();
    if (!/^[0-7]+$/.test(sizeText)) throw new Error('Archive contains an invalid size.');
    const size = Number.parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || offset + 512 + size > tar.length) throw new Error('Archive is truncated.');
    const expectedChecksum = Number.parseInt(field(148, 8).trim(), 8);
    let checksum = 0;
    for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index];
    if (checksum !== expectedChecksum) throw new Error('Archive header checksum failed.');
    if ((name === binaryName || name === `./${binaryName}`) && prefix === '') {
      const type = field(156, 1);
      if (!['', '0'].includes(type) || found) throw new Error('Archive executable is not a unique regular file.');
      if (size < 1024 || size > 150 * 1024 * 1024) throw new Error('Archive executable has an invalid size.');
      found = Buffer.from(tar.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!found) throw new Error('Pinned archive does not contain the expected executable.');
  return found;
}

async function safeDirectory(path) {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Managed tool directories must be ordinary local directories.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(path);
  }
}

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000), headers: { 'User-Agent': 'ContractGuard-oasdiff-installer' } });
  if (!response.ok || !response.body) throw new Error(`Official release download failed: HTTP ${response.status}.`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 100 * 1024 * 1024) throw new Error('Release download exceeded 100 MiB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function installOasdiff() {
  const lock = JSON.parse(await readFile(join(root, 'config', 'oasdiff-lock.json'), 'utf8'));
  const platform = `${process.platform}-${process.arch}`;
  const asset = lock.assets[platform];
  if (!asset) throw new Error(`No pinned oasdiff binary for ${platform}. Build tag ${lock.tag} yourself and set CONTRACTGUARD_OASDIFF_PATH.`);
  if (!/^\d+\.\d+\.\d+$/.test(lock.version) || !/^[a-f0-9]{64}$/.test(asset.sha256) || !/^[A-Za-z0-9_.-]+\.tar\.gz$/.test(asset.file)) throw new Error('Invalid oasdiff lock metadata.');
  const directory = join(root, '.tools', 'oasdiff', lock.version);
  await safeDirectory(join(root, '.tools'));
  await safeDirectory(join(root, '.tools', 'oasdiff'));
  await safeDirectory(directory);
  const target = join(directory, asset.binary);
  const receiptPath = join(directory, 'install.json');
  try {
    const file = await lstat(target);
    if (file.isSymbolicLink() || !file.isFile()) throw new Error('Managed executable must be an ordinary file.');
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    if (receipt.version === lock.version && receipt.archiveSha256 === asset.sha256 && receipt.binarySha256 === hash(await readFile(target))) {
      console.log(`oasdiff ${lock.version} is already installed: ${target}`);
      return target;
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const expectedBase = `https://github.com/oasdiff/oasdiff/releases/download/v${lock.version}/`;
  if (lock.releaseBaseUrl !== expectedBase) throw new Error('Lock file release URL must be the official pinned GitHub release.');
  console.log(`Downloading official oasdiff ${lock.version} for ${platform}...`);
  const archive = await download(`${expectedBase}${asset.file}`);
  if (hash(archive) !== asset.sha256) throw new Error('Release SHA-256 verification failed; no executable was installed.');
  const binary = extractBinary(archive, asset.binary);
  const temporary = join(directory, `${asset.binary}.${process.pid}.pending`);
  try {
    await writeFile(temporary, binary, { flag: 'wx', mode: 0o755 });
    if (process.platform !== 'win32') await chmod(temporary, 0o755);
    await rename(temporary, target);
    await writeFile(receiptPath, JSON.stringify({ version: lock.version, sourceCommit: lock.sourceCommit, archive: asset.file, archiveSha256: asset.sha256, binarySha256: hash(binary) }, null, 2) + '\n', { mode: 0o644 });
  } finally {
    await rm(temporary, { force: true });
  }
  console.log(`Installed verified oasdiff ${lock.version}: ${target}`);
  return target;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  installOasdiff().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
