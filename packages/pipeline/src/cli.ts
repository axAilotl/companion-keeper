#!/usr/bin/env node
import { analyzeStructure, discoverModels, extractByModels } from "./extraction.js";
import type { MessageOrder, OutputFormat, SupportedRole } from "./types.js";
import { parseListArg } from "./utils.js";

interface CliArgs {
  input: string;
  analyze: boolean;
  sample: number;
  listModels: boolean;
  extract: boolean;
  models?: string;
  outputDir: string;
  format: OutputFormat;
  roles: string;
  order: MessageOrder;
  includeRaw: boolean;
  includeMetadata: boolean;
  maxConversations: number;
  help: boolean;
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const args = parseCliArgs(argv);

  if (args.help) {
    printHelp();
    return 0;
  }

  if (!args.analyze && !args.listModels && !args.extract) {
    args.analyze = true;
    args.listModels = true;
  }

  if (args.analyze) {
    const report = await analyzeStructure(args.input, args.sample);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }

  let modelReport: Awaited<ReturnType<typeof discoverModels>> | null = null;
  if (args.listModels || args.extract) {
    modelReport = await discoverModels(args.input);
  }

  if (args.listModels && modelReport) {
    process.stdout.write("\nModels discovered (assistant messages):\n");
    const models = Object.keys(modelReport.messageCounts).sort((a, b) => a.localeCompare(b));

    if (models.length === 0) {
      process.stdout.write("  <none>\n");
    }

    for (const model of models) {
      const msgCount = modelReport.messageCounts[model] ?? 0;
      const convoCount = modelReport.conversationCounts[model] ?? 0;
      process.stdout.write(`  ${model}  messages=${msgCount}  conversations=${convoCount}\n`);
    }
  }

  if (args.extract) {
    let selectedModels = parseListArg(args.models);

    if (selectedModels.length === 0 && modelReport && modelReport.format === "openai") {
      const available = Object.keys(modelReport.messageCounts).sort((a, b) => a.localeCompare(b));
      if (available.includes("gpt-4o")) {
        selectedModels = ["gpt-4o"];
      } else {
        const firstModel = available[0];
        if (firstModel) {
          selectedModels = [firstModel];
        }
      }
    }

    const roles = parseRoles(args.roles);

    const result = await extractByModels({
      inputPath: args.input,
      models: selectedModels,
      outputDir: args.outputDir,
      format: args.format,
      roles,
      order: args.order,
      includeRaw: args.includeRaw,
      includeMetadata: args.includeMetadata,
      maxConversations: args.maxConversations,
      onProgress: (message) => process.stdout.write(`${message}\n`),
    });

    process.stdout.write(
      `Done. format=${result.format} wrote=${result.extracted} output=${result.outputDir}\n`,
    );
  }

  return 0;
}

function parseCliArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = {
    input: "conversations.json",
    analyze: false,
    sample: 3,
    listModels: false,
    extract: false,
    outputDir: "model_exports",
    format: "jsonl",
    roles: "system,user,assistant",
    order: "time",
    includeRaw: false,
    includeMetadata: false,
    maxConversations: 0,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }

    if (arg === "--analyze") {
      parsed.analyze = true;
      continue;
    }

    if (arg === "--list-models") {
      parsed.listModels = true;
      continue;
    }

    if (arg === "--extract") {
      parsed.extract = true;
      continue;
    }

    if (arg === "--include-raw") {
      parsed.includeRaw = true;
      continue;
    }

    if (arg === "--include-metadata") {
      parsed.includeMetadata = true;
      continue;
    }

    if (arg === "--input") {
      parsed.input = readArgValue(argv, ++i, "--input");
      continue;
    }

    if (arg === "--sample") {
      parsed.sample = Number.parseInt(readArgValue(argv, ++i, "--sample"), 10) || 3;
      continue;
    }

    if (arg === "--models") {
      parsed.models = readArgValue(argv, ++i, "--models");
      continue;
    }

    if (arg === "--output-dir") {
      parsed.outputDir = readArgValue(argv, ++i, "--output-dir");
      continue;
    }

    if (arg === "--format") {
      const value = readArgValue(argv, ++i, "--format");
      parsed.format = value === "json" ? "json" : "jsonl";
      continue;
    }

    if (arg === "--roles") {
      parsed.roles = readArgValue(argv, ++i, "--roles");
      continue;
    }

    if (arg === "--order") {
      const value = readArgValue(argv, ++i, "--order");
      parsed.order = value === "current-path" ? "current-path" : "time";
      continue;
    }

    if (arg === "--max-conversations") {
      parsed.maxConversations =
        Number.parseInt(readArgValue(argv, ++i, "--max-conversations"), 10) || 0;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function parseRoles(value: string): SupportedRole[] {
  const roles = parseListArg(value);
  const supported = new Set<SupportedRole>(["system", "user", "assistant"]);
  const out: SupportedRole[] = [];

  for (const role of roles) {
    if (supported.has(role as SupportedRole)) {
      out.push(role as SupportedRole);
    }
  }

  return out.length > 0 ? out : ["system", "user", "assistant"];
}

function readArgValue(args: string[], index: number, flagName: string): string {
  const value = args[index];
  if (!value) {
    throw new Error(`Missing value for ${flagName}`);
  }
  return value;
}

function printHelp(): void {
  process.stdout.write(`Usage: gptdata-pipeline [options]\n\n`);
  process.stdout.write(`Options:\n`);
  process.stdout.write(`  --input <path>             Path to conversations.json or export ZIP\n`);
  process.stdout.write(`  --analyze                  Print structure sample summary\n`);
  process.stdout.write(`  --sample <n>               Analyze sample size (default: 3)\n`);
  process.stdout.write(`  --list-models              Discover models with message/conversation counts\n`);
  process.stdout.write(`  --extract                  Extract matching conversations\n`);
  process.stdout.write(`  --models <csv>             Model list, e.g. gpt-4o,gpt-4o-mini\n`);
  process.stdout.write(`  --output-dir <path>        Output directory (default: model_exports)\n`);
  process.stdout.write(`  --format <jsonl|json>      Output format (default: jsonl)\n`);
  process.stdout.write(`  --roles <csv>              Roles to include (default: system,user,assistant)\n`);
  process.stdout.write(`  --order <time|current-path> Message order (default: time)\n`);
  process.stdout.write(`  --include-raw              Emit raw message objects\n`);
  process.stdout.write(`  --include-metadata         Include metadata in cleaned output\n`);
  process.stdout.write(`  --max-conversations <n>    Stop after N extracted conversations\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  });
}
