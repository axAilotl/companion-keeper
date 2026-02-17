import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import yauzl from "yauzl";
import type { ResolvedInput } from "../types.js";

const CONVERSATIONS_JSON = "conversations.json";

export async function resolveInputPath(inputPath: string): Promise<ResolvedInput> {
  const cleaned = inputPath.trim();
  if (cleaned.length === 0) {
    throw new Error("Input path is required");
  }

  const fileStats = await stat(cleaned).catch(() => null);
  if (!fileStats || !fileStats.isFile()) {
    throw new Error(`Input path is not a readable file: ${cleaned}`);
  }

  const ext = path.extname(cleaned).toLowerCase();
  if (ext === ".zip") {
    return { kind: "zip", inputPath: cleaned };
  }

  return { kind: "json", inputPath: cleaned };
}

export async function openInputStream(inputPath: string): Promise<{ resolved: ResolvedInput; stream: Readable }> {
  const resolved = await resolveInputPath(inputPath);

  if (resolved.kind === "json") {
    return {
      resolved,
      stream: createReadStream(resolved.inputPath),
    };
  }

  return {
    resolved,
    stream: await openConversationsJsonStreamFromZip(resolved.inputPath),
  };
}

export function isZipPath(inputPath: string): boolean {
  return path.extname(inputPath).toLowerCase() === ".zip";
}

async function openConversationsJsonStreamFromZip(zipPath: string): Promise<Readable> {
  const zipFile = await openZipFile(zipPath);

  return new Promise<Readable>((resolve, reject) => {
    let settled = false;

    const closeZip = (): void => {
      try {
        zipFile.close();
      } catch {
        // ignore close errors during cleanup
      }
    };

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      closeZip();
      reject(error);
    };

    const onError = (error: Error): void => {
      fail(error);
    };

    const onEnd = (): void => {
      fail(new Error(`Could not find '${CONVERSATIONS_JSON}' in zip: ${zipPath}`));
    };

    const onEntry = (entry: yauzl.Entry): void => {
      const normalized = entry.fileName.replace(/\\/g, "/");
      const baseName = path.posix.basename(normalized);
      if (baseName.toLowerCase() !== CONVERSATIONS_JSON) {
        zipFile.readEntry();
        return;
      }

      zipFile.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          fail(error ?? new Error(`Failed to open '${entry.fileName}' from zip`));
          return;
        }

        if (settled) {
          stream.destroy();
          closeZip();
          return;
        }

        settled = true;
        cleanup();

        let closed = false;
        const closeOnce = (): void => {
          if (closed) {
            return;
          }
          closed = true;
          closeZip();
        };

        stream.once("end", closeOnce);
        stream.once("close", closeOnce);
        stream.once("error", closeOnce);

        resolve(stream);
      });
    };

    const cleanup = (): void => {
      zipFile.removeListener("entry", onEntry);
      zipFile.removeListener("end", onEnd);
      zipFile.removeListener("error", onError);
    };

    zipFile.on("entry", onEntry);
    zipFile.once("end", onEnd);
    zipFile.once("error", onError);
    zipFile.readEntry();
  });
}

function openZipFile(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(error ?? new Error(`Failed to open zip file: ${zipPath}`));
        return;
      }
      resolve(zipFile);
    });
  });
}
