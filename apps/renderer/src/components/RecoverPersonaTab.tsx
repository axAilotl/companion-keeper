import { useMemo } from "react";
import type { CardDraft } from "@gptdataexport/shared";
import ReactMarkdown from "react-markdown";
import { useRendererStore } from "@/store/useRendererStore";
import { InlineStatus } from "./InlineStatus";
import { LoreSplitView } from "./LoreSplitView";

function repairMarkdown(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\s(#{1,6}\s)/g, "\n\n$1")
    .replace(/\s([-*]\s)/g, "\n$1")
    .replace(/\s(\d+\.\s)/g, "\n$1");
}

function toCardMarkdown(card: CardDraft): string {
  const sections: string[] = [];

  if (card.name.trim().length > 0) {
    sections.push(`# ${card.name.trim()}`);
  }
  if (card.description.trim().length > 0) {
    sections.push(repairMarkdown(card.description.trim()));
  }
  if (card.personality.trim().length > 0) {
    sections.push(`## Personality\n${repairMarkdown(card.personality.trim())}`);
  }
  if (card.scenario.trim().length > 0) {
    sections.push(`## Scenario\n${repairMarkdown(card.scenario.trim())}`);
  }
  if (card.firstMessage.trim().length > 0) {
    sections.push(`## First Message\n${repairMarkdown(card.firstMessage.trim())}`);
  }

  if (sections.length === 0) {
    return "Recover persona to render the character card markdown.";
  }

  return sections.join("\n\n");
}

export const RecoverPersonaTab = (): JSX.Element => {
  const filePath = useRendererStore((state) => state.filePath);
  const selectedModel = useRendererStore((state) => state.selectedModel);
  const personaName = useRendererStore((state) => state.personaName);
  const setPersonaName = useRendererStore((state) => state.setPersonaName);
  const userName = useRendererStore((state) => state.userName);
  const setUserName = useRendererStore((state) => state.setUserName);
  const hardcodeNames = useRendererStore((state) => state.hardcodeNames);
  const setHardcodeNames = useRendererStore((state) => state.setHardcodeNames);
  const recoverPersona = useRendererStore((state) => state.recoverPersona);
  const stopRecoverPersona = useRendererStore((state) => state.stopRecoverPersona);
  const recoverStep = useRendererStore((state) => state.steps.recover);
  const recoverEstimatedCalls = useRendererStore((state) => state.recoverEstimatedCalls);
  const recoverCompletedCalls = useRendererStore((state) => state.recoverCompletedCalls);
  const card = useRendererStore((state) => state.card);
  const memories = useRendererStore((state) => state.memories);
  const activeMemoryId = useRendererStore((state) => state.activeMemoryId);
  const setActiveMemory = useRendererStore((state) => state.setActiveMemory);
  const outputDir = useRendererStore((state) => state.outputDir);
  const report = useRendererStore((state) => state.report);

  const cardMarkdown = useMemo(() => toCardMarkdown(card), [card]);
  const callProgressSuffix =
    recoverEstimatedCalls > 0
      ? `${Math.min(recoverCompletedCalls, recoverEstimatedCalls)}/${recoverEstimatedCalls} calls`
      : undefined;

  return (
    <section className="panel panel--section">
      <header className="panel__header">
        <h2>Recover Persona</h2>
      </header>
      <p className="panel__hint">
        Run one recovery pass for the selected model, then review markdown card output and lorebook memories.
      </p>

      <InlineStatus label="Recover Persona" step={recoverStep} suffix={callProgressSuffix} />

      <div className="recover-controls">
        <label className="field-block" htmlFor="personaName">
          <span>Persona Name</span>
          <input
            id="personaName"
            type="text"
            value={personaName}
            onChange={(event) => setPersonaName(event.target.value)}
            placeholder="Companion"
          />
        </label>
        <label className="field-block" htmlFor="userName">
          <span>User Name</span>
          <input
            id="userName"
            type="text"
            value={userName}
            onChange={(event) => setUserName(event.target.value)}
            placeholder="User"
          />
        </label>
        <label className="toggle-field" htmlFor="hardcodeNames">
          <input
            id="hardcodeNames"
            type="checkbox"
            checked={hardcodeNames}
            onChange={(event) => setHardcodeNames(event.target.checked)}
          />
          <span>Hardcode names in output</span>
        </label>

        <button
          type="button"
          className="btn btn--primary"
          onClick={async () => {
            await recoverPersona();
          }}
          disabled={!filePath || !selectedModel || recoverStep.phase === "loading"}
        >
          {recoverStep.phase === "loading" ? "Recovering..." : "Recover Persona"}
        </button>
        <button
          type="button"
          className="btn btn--danger"
          onClick={async () => {
            await stopRecoverPersona();
          }}
          disabled={recoverStep.phase !== "loading"}
        >
          Stop
        </button>
      </div>

      <div className="metadata-grid">
        <div>
          <span className="meta-label">Active model</span>
          <strong>{selectedModel || "-"}</strong>
        </div>
        <div>
          <span className="meta-label">Output directory</span>
          <strong title={outputDir}>{outputDir || "-"}</strong>
        </div>
        <div>
          <span className="meta-label">Memories</span>
          <strong>{memories.length.toLocaleString()}</strong>
        </div>
      </div>

      {report ? <p className="report-line">{report}</p> : null}

      <div className="recover-results">
        <article className="panel panel--embedded">
          <header className="panel__header">
            <h3>Character Card (Markdown)</h3>
          </header>
          <div className="markdown-card">
            <ReactMarkdown>{cardMarkdown}</ReactMarkdown>
          </div>
        </article>

        <article className="panel panel--embedded">
          <header className="panel__header">
            <h3>Lorebook</h3>
          </header>
          <LoreSplitView
            memories={memories}
            activeMemoryId={activeMemoryId}
            onSelectMemory={(id) => setActiveMemory(id)}
          />
        </article>
      </div>
    </section>
  );
};
