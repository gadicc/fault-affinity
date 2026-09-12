import path from "node:path";
import { createWriteStream, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";

import {
  fileSize,
  readJson,
  requireCondition,
  SHA256_RE,
  sha256File,
} from "./common.mjs";

const VERSION_RE = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const ARCHIVE_RE = /^node-v[0-9]+\.[0-9]+\.[0-9]+-(?:linux|win)-x64\.(?:tar\.xz|zip)$/;

export function loadRuntimeLock(file) {
  const lock = readJson(file);
  requireCondition(lock.schemaVersion === 1 && lock.platforms !== null &&
    typeof lock.platforms === "object", "runtime lock schema is unsupported",
  "INVALID_RUNTIME_LOCK");
  for (const [platform, roles] of Object.entries(lock.platforms)) {
    requireCondition(["linux-x64", "windows-x64"].includes(platform) &&
      roles !== null && typeof roles === "object", `invalid runtime platform ${platform}`,
    "INVALID_RUNTIME_LOCK");
    for (const role of ["controller", "reference"]) {
      const item = roles[role];
      requireCondition(item !== null && typeof item === "object" &&
        Object.keys(item).sort().join(",") ===
          "archive,archiveRoot,bytes,sha256,url,version" &&
        VERSION_RE.test(item.version) && ARCHIVE_RE.test(item.archive) &&
        item.archive.startsWith(`node-${item.version}-`) &&
        item.url === `https://nodejs.org/dist/${item.version}/${item.archive}` &&
        Number.isSafeInteger(item.bytes) && item.bytes > 0 &&
        item.bytes <= 128 * 1024 * 1024 && SHA256_RE.test(item.sha256) &&
        item.archiveRoot === item.archive.replace(/\.(?:tar\.xz|zip)$/, ""),
      `invalid ${platform} ${role} runtime lock entry`, "INVALID_RUNTIME_LOCK");
    }
  }
  return lock;
}

export async function acquireRuntimeArchive(item, cacheDirectory, rawDependencies = {}) {
  requireCondition(item !== null && typeof item === "object" &&
    typeof item.archive === "string" && typeof item.url === "string" &&
    Number.isSafeInteger(item.bytes) && item.bytes >= 1 && item.bytes <= 128 * 1024 * 1024 &&
    SHA256_RE.test(item.sha256), "runtime acquisition entry is invalid",
  "INVALID_RUNTIME_LOCK");
  const dependencies = typeof rawDependencies === "function"
    ? { fetchImpl: rawDependencies }
    : rawDependencies;
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const requestTimeoutMs = dependencies.requestTimeoutMs ?? 30_000;
  const bodyTimeoutMs = dependencies.bodyTimeoutMs ?? 300_000;
  requireCondition(Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs >= 1 &&
    requestTimeoutMs <= 300_000 && Number.isSafeInteger(bodyTimeoutMs) && bodyTimeoutMs >= 1 &&
    bodyTimeoutMs <= 900_000, "runtime download deadlines are invalid",
  "RUNTIME_DOWNLOAD_FAILED");
  mkdirSync(cacheDirectory, { recursive: true, mode: 0o755 });
  const destination = path.join(cacheDirectory, item.archive);
  try {
    const stat = lstatSync(destination);
    requireCondition(stat.isFile() && !stat.isSymbolicLink() &&
      Number(stat.size) === item.bytes && sha256File(destination) === item.sha256,
    `cached runtime does not match lock: ${item.archive}`, "RUNTIME_CHECKSUM_MISMATCH");
    return destination;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const temporary = `${destination}.partial-${process.pid}`;
  rmSync(temporary, { force: true });
  const downloadController = new AbortController();
  const requestTimer = setTimeout(() => downloadController.abort(
    new Error(`runtime request deadline exceeded for ${item.archive}`)), requestTimeoutMs);
  let response;
  try {
    response = await fetchImpl(item.url, {
      redirect: "error",
      signal: downloadController.signal,
    });
  } catch (error) {
    throw new Error(`runtime download failed for ${item.url}: ${error.message}`);
  } finally {
    clearTimeout(requestTimer);
  }
  const validResponse = response.status === 200 && response.url === item.url &&
    response.body !== null;
  if (!validResponse) downloadController.abort();
  requireCondition(validResponse,
    `runtime download returned an unexpected response for ${item.url}`,
    "RUNTIME_DOWNLOAD_FAILED");
  const announcedLength = response.headers.get("content-length");
  if (announcedLength !== null && Number(announcedLength) !== item.bytes) {
    downloadController.abort();
  }
  requireCondition(announcedLength === null || Number(announcedLength) === item.bytes,
    `runtime download length changed for ${item.archive}`, "RUNTIME_SIZE_MISMATCH");
  let received = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > item.bytes) {
        callback(new Error(`runtime download exceeded locked size for ${item.archive}`));
      } else {
        callback(null, chunk);
      }
    },
  });
  const bodyTimer = setTimeout(() => downloadController.abort(
    new Error(`runtime body deadline exceeded for ${item.archive}`)), bodyTimeoutMs);
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      limiter,
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      { signal: downloadController.signal },
    );
    requireCondition(fileSize(temporary) === item.bytes,
      `runtime download size changed for ${item.archive}`, "RUNTIME_SIZE_MISMATCH");
    requireCondition(sha256File(temporary) === item.sha256,
      `runtime download checksum changed for ${item.archive}`, "RUNTIME_CHECKSUM_MISMATCH");
    renameSync(temporary, destination);
  } catch (error) {
    downloadController.abort();
    rmSync(temporary, { force: true });
    throw error;
  } finally {
    clearTimeout(bodyTimer);
  }
  return destination;
}
