import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  choosePrimaryModel,
  discoverModels,
  extractByModels,
  detectExportFormat,
} from "../src/index.js";

function openAiConversation(id: string, messages: Array<{ role: string; modelMeta?: Record<string, string>; text: string }>) {
  const mapping: Record<string, unknown> = {};
  let time = 1700000000;
  let lastNode: string | null = null;

  for (let i = 0; i < messages.length; i += 1) {
    const nodeId = `node_${i + 1}`;
    const message = messages[i];
    const metadata = message.modelMeta ?? {};

    mapping[nodeId] = {
      id: nodeId,
      parent: lastNode,
      message: {
        id: `msg_${i + 1}`,
        create_time: time,
        author: { role: message.role },
        content: { content_type: "text", parts: [message.text] },
        metadata,
      },
    };

    lastNode = nodeId;
    time += 1;
  }

  return {
    conversation_id: id,
    title: id,
    current_node: lastNode,
    mapping,
  };
}

test("discoverModels handles OpenAI metadata key variants and ignores non-assistant rows", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pipeline-model-test-"));
  const filePath = path.join(tempDir, "conversations.json");

  const payload = [
    openAiConversation("conv-a", [
      { role: "assistant", text: "one", modelMeta: { model_slug: "gpt-4o" } },
      { role: "assistant", text: "two", modelMeta: { default_model_slug: "gpt-4o-mini" } },
      { role: "assistant", text: "three", modelMeta: { model: "gpt-4o-mini" } },
      { role: "user", text: "ignored", modelMeta: { model_slug: "gpt-4o" } },
    ]),
    openAiConversation("conv-b", [
      { role: "assistant", text: "x", modelMeta: { model_slug: "gpt-4o" } },
      { role: "assistant", text: "y", modelMeta: { model_slug: "gpt-4o" } },
      { role: "assistant", text: "z", modelMeta: { model_slug: "gpt-4o-mini" } },
      { role: "assistant", text: "q", modelMeta: { model_slug: "gpt-4.1" } },
    ]),
  ];

  try {
    await writeFile(filePath, JSON.stringify(payload), "utf8");

    const format = await detectExportFormat(filePath);
    assert.equal(format, "openai");

    const report = await discoverModels(filePath);
    assert.equal(report.format, "openai");
    assert.equal(report.totalConversations, 2);
    assert.deepEqual(report.messageCounts, {
      "gpt-4.1": 1,
      "gpt-4o": 3,
      "gpt-4o-mini": 3,
    });
    assert.deepEqual(report.conversationCounts, {
      "gpt-4.1": 1,
      "gpt-4o": 2,
      "gpt-4o-mini": 2,
    });

    const chosen = choosePrimaryModel(["gpt-4o", "gpt-4o-mini"], new Map([
      ["gpt-4o", 2],
      ["gpt-4o-mini", 2],
    ]));
    assert.equal(chosen, "gpt-4o-mini");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("discoverModels and extractByModels handle Anthropic exports", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pipeline-anthropic-test-"));
  const inputPath = path.join(tempDir, "anthropic.json");
  const outputDir = path.join(tempDir, "out");

  const payload = [
    {
      uuid: "anth-1",
      name: "Anthropic Conversation 1",
      created_at: "2026-01-01T00:00:00Z",
      chat_messages: [
        { uuid: "m-1", sender: "human", text: "hello", created_at: "2026-01-01T00:00:00Z" },
        { uuid: "m-2", sender: "assistant", text: "hi", created_at: "2026-01-01T00:00:10Z" },
      ],
    },
    {
      uuid: "anth-2",
      name: "Anthropic Conversation 2",
      created_at: "2026-01-02T00:00:00Z",
      chat_messages: [
        { uuid: "m-3", sender: "human", text: "question", created_at: "2026-01-02T00:00:00Z" },
      ],
    },
  ];

  try {
    await writeFile(inputPath, JSON.stringify(payload), "utf8");

    const report = await discoverModels(inputPath);
    assert.equal(report.format, "anthropic");
    assert.deepEqual(report.messageCounts, { claude: 3 });
    assert.deepEqual(report.conversationCounts, { claude: 2 });

    const extracted = await extractByModels({
      inputPath,
      models: [],
      outputDir,
      format: "jsonl",
    });

    assert.equal(extracted.format, "anthropic");
    assert.equal(extracted.extracted, 2);

    const modelDir = path.join(outputDir, "claude");
    const files = (await readdir(modelDir)).sort();
    assert.equal(files.length, 2);

    const sample = await readFile(path.join(modelDir, files[0]), "utf8");
    assert.ok(sample.includes('"role":"assistant"') || sample.includes('"role":"user"'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("extractByModels writes modeltag_date_conversationid filenames", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pipeline-filename-test-"));
  const inputPath = path.join(tempDir, "conversations.json");
  const outputDir = path.join(tempDir, "out");

  const payload = [
    openAiConversation("conv/a?1", [
      { role: "assistant", text: "hello", modelMeta: { model_slug: "gpt-4o" } },
      { role: "user", text: "hi back" },
    ]),
  ];

  try {
    await writeFile(inputPath, JSON.stringify(payload), "utf8");

    const result = await extractByModels({
      inputPath,
      models: ["gpt-4o"],
      outputDir,
      format: "jsonl",
    });

    assert.equal(result.extracted, 1);

    const modelDir = path.join(outputDir, "gpt-4o");
    const files = await readdir(modelDir);
    assert.equal(files.length, 1);
    assert.match(files[0] ?? "", /^gpt-4o_\d{8}_conv_a_1\.jsonl$/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
