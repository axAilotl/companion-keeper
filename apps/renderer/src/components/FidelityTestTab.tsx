import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { useRendererStore } from "@/store/useRendererStore";
import { InlineStatus } from "./InlineStatus";

export const FidelityTestTab = (): JSX.Element => {
  const runFidelityTest = useRendererStore((state) => state.runFidelityTest);
  const fidelityResults = useRendererStore((state) => state.fidelityResults);
  const fidelitySummaryMarkdown = useRendererStore((state) => state.fidelitySummaryMarkdown);
  const fidelityStep = useRendererStore((state) => state.steps.fidelity);
  const outputDir = useRendererStore((state) => state.outputDir);
  const bestResult = useMemo(() => fidelityResults[0] ?? null, [fidelityResults]);

  return (
    <section className="panel panel--section">
      <header className="panel__header">
        <h2>Fidelity Test</h2>
      </header>
      <p className="panel__hint">
        Score candidate models against the edited persona and lorebook to find the best voice match.
      </p>

      <div className="row">
        <button
          type="button"
          className="btn btn--primary"
          onClick={async () => {
            await runFidelityTest();
          }}
          disabled={fidelityStep.phase === "loading"}
        >
          {fidelityStep.phase === "loading" ? "Scoring..." : "Run Fidelity Test"}
        </button>
        {bestResult ? (
          <p className="report-line">
            Best match: <strong>{bestResult.model}</strong> ({bestResult.score}/100)
          </p>
        ) : null}
      </div>

      {outputDir ? <p className="report-line">Using output: {outputDir}</p> : null}
      <InlineStatus label="Fidelity Test" step={fidelityStep} />

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>Score</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {fidelityResults.length === 0 ? (
              <tr>
                <td colSpan={3}>No fidelity results yet.</td>
              </tr>
            ) : (
              fidelityResults.map((result) => (
                <tr key={`${result.model}-${result.score}`}>
                  <td>{result.model}</td>
                  <td>{result.score}</td>
                  <td>{result.notes}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {fidelitySummaryMarkdown.trim().length > 0 ? (
        <article className="panel panel--embedded">
          <header className="panel__header">
            <h3>Summary</h3>
          </header>
          <div className="markdown-card">
            <ReactMarkdown>{fidelitySummaryMarkdown}</ReactMarkdown>
          </div>
        </article>
      ) : null}
    </section>
  );
};
