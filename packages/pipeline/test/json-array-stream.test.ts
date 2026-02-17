import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { streamJsonArrayObjectsFromFile } from "../src/io/jsonArrayStream.js";

test("streamJsonArrayObjectsFromFile parses large arrays with tiny chunks", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pipeline-stream-test-"));
  const filePath = path.join(tempDir, "large.json");

  try {
    const total = 12000;
    const ws = createWriteStream(filePath, { encoding: "utf8" });
    ws.write("[\n");
    for (let i = 0; i < total; i += 1) {
      const row = {
        id: i,
        title: `conversation-${i}`,
        body: `line one for ${i}\nline two for ${i}`,
        nested: { idx: i, tags: ["a", "b", "c"] },
      };
      ws.write(JSON.stringify(row));
      if (i < total - 1) {
        ws.write(",\n");
      }
    }
    ws.write("\n]");
    ws.end();
    await once(ws, "finish");

    let count = 0;
    let firstBody = "";
    let lastTitle = "";

    for await (const obj of streamJsonArrayObjectsFromFile(filePath, { readChunkBytes: 37 })) {
      if (count === 0) {
        firstBody = String(obj.body);
      }
      count += 1;
      lastTitle = String(obj.title);
    }

    assert.equal(count, total);
    assert.equal(firstBody, "line one for 0\nline two for 0");
    assert.equal(lastTitle, `conversation-${total - 1}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
