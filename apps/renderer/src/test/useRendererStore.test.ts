import { beforeEach, describe, expect, it } from "vitest";
import type { RendererBridge } from "@gptdataexport/shared";
import { defaultBaseUrl, defaultFidelityPrompts, defaultPromptOverrides } from "@/store/runtimeDefaults";
import { useRendererStore } from "@/store/useRendererStore";

const TEST_OUTPUT_DIR = "/tmp/test-run-001";

const emptyStep = () => ({
  phase: "idle" as const,
  progress: 0,
  message: "",
  error: null,
});

const makeMemories = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `memory-${index + 1}`,
    keys: [`milestone-${index + 1}`, "shared-routine"],
    content:
      index % 2 === 0
        ? `We always check in before bed and review one win from the day. Entry ${index + 1}.`
        : `When stress spikes, we switch to short grounding prompts before returning to goals. Entry ${index + 1}.`,
  }));

const makeCard = () => ({
  name: "Companion",
  description: [
    "# Companion",
    "",
    "## Overview",
    "A grounded, warm partner who balances practical planning with playful reassurance.",
  ].join("\n"),
  personality:
    "Direct, kind, and detail-oriented. Uses short checklists, reflective questions, and clear boundaries.",
  scenario:
    "Continuing an established relationship with shared goals, routines, and emotionally safe communication.",
  firstMessage:
    "I pulled together what matters most between us. Want to review the card first or memories first?",
});

function installTestBridge(): void {
  const bridge: RendererBridge = {
    selectImportFile: async () => ({
      ok: true,
      data: {
        cancelled: false,
        filePath: "/tmp/conversations.json",
        fileName: "conversations.json",
        fileSizeBytes: 14_200_000,
      },
    }),
    selectExportDirectory: async (request) => ({
      ok: true,
      data: {
        cancelled: false,
        directoryPath: request.defaultPath ?? TEST_OUTPUT_DIR,
      },
    }),
    selectPersonaImageFile: async () => ({
      ok: true,
      data: {
        cancelled: false,
        filePath: "/tmp/persona.png",
        fileName: "persona.png",
        previewDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
      },
    }),
    listReviewDirectories: async () => ({
      ok: true,
      data: {
        directories: ["/tmp/test-output", TEST_OUTPUT_DIR],
      },
    }),
    importFile: async (request) => ({
      ok: true,
      data: {
        filePath: request.filePath,
        fileName: request.filePath.split(/[\\/]/).pop() || "conversations.json",
        fileSizeBytes: 14_200_000,
        conversationCount: 4_280,
      },
    }),
    analyzeModels: async () => ({
      ok: true,
      data: {
        totalConversations: 4_280,
        models: [
          { model: "gpt-4o", conversations: 2_350 },
          { model: "gpt-4o-mini", conversations: 1_120 },
          { model: "gpt-4.1", conversations: 560 },
        ],
      },
    }),
    loadRendererSettings: async () => ({
      ok: true,
      data: {
        settingsJson: "",
      },
    }),
    saveRendererSettings: async () => ({
      ok: true,
      data: {
        saved: true,
        path: "/tmp/renderer-settings.json",
      },
    }),
    listProviderModels: async () => ({
      ok: true,
      data: {
        models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "claude-sonnet-4.5", "deepseek-chat"],
        contextWindows: {
          "gpt-4o": 128000,
          "gpt-4o-mini": 128000,
          "gpt-4.1": 1000000,
          "claude-sonnet-4.5": 200000,
          "deepseek-chat": 128000,
        },
      },
    }),
    prepareCache: async (request) => ({
      ok: true,
      data: {
        model: request.model,
        cacheRoot: "/tmp/extraction-cache",
        modelDir: `/tmp/extraction-cache/model_exports/${request.model}`,
        totalExtractedFiles: 128,
        reusedExtraction: false,
        extractedInLastRun: 128,
      },
    }),
    extractAndGenerate: async (request) => ({
      ok: true,
      data: {
        card: makeCard(),
        memories: makeMemories(Math.max(24, Math.min(request.maxConversations, 120))),
        outputDir: request.outputDir ?? TEST_OUTPUT_DIR,
        report: request.appendMemories
          ? "Appended memories from extracted JSONL cache."
          : "Recovered persona from selected conversations.",
      },
    }),
    loadReview: async (request) => ({
      ok: true,
      data: {
        card: makeCard(),
        memories: makeMemories(36),
        outputDir: request.outputDir,
        report: "Loaded existing card + memories.",
        personaImagePath: `${request.outputDir}/persona_image.png`,
        personaImageDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
      },
    }),
    saveReview: async (request) => ({
      ok: true,
      data: {
        saved: true,
        outputDir: request.outputDir ?? TEST_OUTPUT_DIR,
        cardPath: `${request.outputDir ?? TEST_OUTPUT_DIR}/card_v3.json`,
        memoriesPath: `${request.outputDir ?? TEST_OUTPUT_DIR}/lorebook_v3.json`,
        ...(request.personaImagePath ? { personaImagePath: request.personaImagePath } : {}),
        ...(request.personaImagePath
          ? { personaImageDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" }
          : {}),
      },
    }),
    runFidelity: async (request) => ({
      ok: true,
      data: {
        runDir: "/tmp/fidelity-run",
        reportPath: "/tmp/fidelity-run/fidelity_report.json",
        summaryPath: "/tmp/fidelity-run/fidelity_summary.md",
        markdownSummary: "# Fidelity Benchmark Results",
        results: request.candidateModels.map((model, index) => ({
          model,
          styleScore: Math.max(50, 90 - index * 7),
          lexicalScore: Math.max(42, 84 - index * 8),
          judgeScore: request.judgeModel ? Math.max(48, 88 - index * 6) : 0,
          finalScore: Math.max(52, 88 - index * 7),
          judgeRationale:
            index === 0
              ? "Best continuity of tone and emotional cadence."
              : "Moderate fidelity with some style drift.",
        })),
      },
    }),
  };

  window.rendererBridge = bridge;
  window.electronAPI = undefined;
}

const resetStoreForTests = (): void => {
  useRendererStore.setState({
    mode: "ipc",
    appTab: "import_data",
    editSubTab: "persona_edit",
    settings: {
      defaultModelSlug: "gpt-4o",
      recentOutputDirs: ["/tmp/test-output", TEST_OUTPUT_DIR],
      recoverMaxConversations: 25,
      maxMemories: 50,
      personaName: "Companion",
      userName: "User",
      hardcodeNames: false,
      forceRerun: false,
      contextProfile: "auto",
      conversationSampling: "weighted-random",
      memoryPerChatMax: 6,
      maxParallelCalls: 4,
      maxMessagesPerConversation: 140,
      maxCharsPerConversation: 18000,
      maxTotalChars: 120000,
      modelContextWindow: 128000,
      llmProvider: "openrouter",
      llmBaseUrl: defaultBaseUrl("openrouter"),
      llmModel: "gpt-4o-mini",
      llmApiKey: "",
      temperature: 0.2,
      requestTimeout: 300,
      fidelityTier: "tier1_cn_open",
      fidelityModelsCsv: "gpt-4o,gpt-4o-mini,gpt-4.1",
      fidelityPromptsText: defaultFidelityPrompts,
      judgeModel: "",
      selectedPresetName: "openrouter-env",
      presets: [
        {
          name: "openrouter-env",
          provider: "openrouter",
          baseUrl: defaultBaseUrl("openrouter"),
          apiKey: "",
        },
      ],
      promptOverrides: defaultPromptOverrides,
    },
    filePath: "",
    fileName: "",
    fileSizeBytes: 0,
    conversationCount: 0,
    models: [],
    selectedModel: "",
    outputDir: "",
    report: "",
    personaName: "Companion",
    userName: "User",
    hardcodeNames: false,
    personaImagePath: "",
    personaImagePreviewDataUrl: "",
    recoverEstimatedCalls: 0,
    recoverCompletedCalls: 0,
    fidelityResults: [],
    fidelitySummaryMarkdown: "",
    providerModels: [],
    providerModelWindows: {},
    card: {
      name: "",
      description: "",
      personality: "",
      scenario: "",
      firstMessage: "",
    },
    memories: [],
    activeMemoryId: null,
    steps: {
      importData: emptyStep(),
      prepareCache: emptyStep(),
      recover: emptyStep(),
      append: emptyStep(),
      load: emptyStep(),
      save: emptyStep(),
      export: emptyStep(),
      fidelity: emptyStep(),
      models: emptyStep(),
    },
  });
};

describe("useRendererStore", () => {
  beforeEach(() => {
    installTestBridge();
    resetStoreForTests();
  });

  it("runs import stage and selects default model when available", async () => {
    useRendererStore.getState().setSettingsField("defaultModelSlug", "gpt-4o-mini");
    await useRendererStore.getState().runImportStage("/tmp/conversations.json");

    const state = useRendererStore.getState();
    expect(state.steps.importData.phase).toBe("success");
    expect(state.filePath).toBe("/tmp/conversations.json");
    expect(state.models.length).toBeGreaterThan(0);
    expect(state.selectedModel).toBe("gpt-4o-mini");
    expect(state.appTab).toBe("recover_persona");
  });

  it("recovers persona and loads card + lorebook state", async () => {
    useRendererStore.setState({
      filePath: "/tmp/conversations.json",
      selectedModel: "gpt-4o",
    });
    await useRendererStore.getState().recoverPersona();

    const state = useRendererStore.getState();
    expect(state.steps.recover.phase).toBe("success");
    expect(state.memories.length).toBeGreaterThan(0);
    expect(state.outputDir).toContain(TEST_OUTPUT_DIR);
    expect(state.card.description).toContain("\n");
    expect(state.card.description).toContain("## Overview");
    expect(state.recoverCompletedCalls).toBe(state.recoverEstimatedCalls);
  });

  it("loads existing output directory into review state", async () => {
    useRendererStore.getState().setOutputDir("/tmp/test-output");
    await useRendererStore.getState().loadReview();

    const state = useRendererStore.getState();
    expect(state.steps.load.phase).toBe("success");
    expect(state.outputDir).toBe("/tmp/test-output");
    expect(state.memories.length).toBeGreaterThan(0);
  });

  it("appends memories into loaded output state", async () => {
    useRendererStore.setState({
      filePath: "/tmp/conversations.json",
      selectedModel: "gpt-4o",
      outputDir: "/tmp/test-output",
      memories: [{ id: "existing-1", keys: ["existing"], content: "Existing memory" }],
    });

    await useRendererStore.getState().appendMemories();

    const state = useRendererStore.getState();
    expect(state.steps.append.phase).toBe("success");
    expect(state.memories.length).toBeGreaterThan(1);
    expect(state.outputDir).toBe("/tmp/test-output");
  });

  it("runs fidelity scoring and sorts by descending score", async () => {
    useRendererStore.getState().setSettingsField("fidelityModelsCsv", "model-a,model-b,model-c");
    await useRendererStore.getState().runFidelityTest();

    const state = useRendererStore.getState();
    expect(state.steps.fidelity.phase).toBe("success");
    expect(state.fidelityResults.length).toBe(3);
    expect(state.fidelityResults[0]!.score).toBeGreaterThanOrEqual(state.fidelityResults[1]!.score);
    expect(state.fidelityResults[1]!.score).toBeGreaterThanOrEqual(state.fidelityResults[2]!.score);
  });

  it("tracks recover call totals from live generation job events", () => {
    useRendererStore.setState((state) => ({
      steps: {
        ...state.steps,
        recover: {
          ...state.steps.recover,
          phase: "loading",
        },
      },
    }));

    useRendererStore.getState().applyJobEvent({
      jobId: "job-1",
      jobType: "generate",
      status: "running",
      timestamp: Date.now(),
      progress: 47,
      message: "LLM call completed: persona_observation abc",
      startedCalls: 14,
      completedCalls: 11,
      failedCalls: 0,
      activeCalls: 3,
      totalCalls: 103,
    });

    const afterRunning = useRendererStore.getState();
    expect(afterRunning.recoverCompletedCalls).toBe(11);
    expect(afterRunning.recoverEstimatedCalls).toBe(103);

    useRendererStore.getState().applyJobEvent({
      jobId: "job-1",
      jobType: "generate",
      status: "completed",
      timestamp: Date.now(),
      progress: 100,
      message: "Recovered persona from 50 conversations and generated 24 memories.",
    });

    const afterCompleted = useRendererStore.getState();
    expect(afterCompleted.recoverCompletedCalls).toBe(11);
    expect(afterCompleted.recoverEstimatedCalls).toBe(103);
    expect(afterCompleted.steps.recover.phase).toBe("success");
  });

  it("exports persona to a new directory", async () => {
    useRendererStore.setState({
      card: {
        name: "Companion",
        description: "desc",
        personality: "kind",
        scenario: "scene",
        firstMessage: "hello",
      },
      memories: [{ id: "m1", keys: ["k1"], content: "c1" }],
    });

    await useRendererStore.getState().runExportPersona();

    const state = useRendererStore.getState();
    expect(state.steps.export.phase).toBe("success");
    expect(state.outputDir).toContain(TEST_OUTPUT_DIR);
  });
});
