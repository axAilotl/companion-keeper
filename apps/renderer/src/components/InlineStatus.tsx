import type { AsyncStepState } from "@/store/useRendererStore";

interface InlineStatusProps {
  label: string;
  step: AsyncStepState;
  suffix?: string;
}

export const InlineStatus = ({ label, step, suffix }: InlineStatusProps): JSX.Element => {
  const phaseLabel =
    step.phase === "loading"
      ? "running"
      : step.phase === "success"
        ? "done"
        : step.phase === "error"
          ? "failed"
          : "idle";

  const toneClass =
    step.phase === "error"
      ? "inline-status inline-status--error"
      : step.phase === "success"
        ? "inline-status inline-status--ok"
        : step.phase === "loading"
          ? "inline-status inline-status--active"
          : "inline-status";

  return (
    <div className={toneClass}>
      <div className="inline-status__meta">
        <strong>{label}</strong>
        <span>
          {phaseLabel}
          {suffix ? ` · ${suffix}` : ""}
        </span>
      </div>
      <div className="inline-status__bar">
        <div className="inline-status__fill" style={{ width: `${Math.max(0, Math.min(100, step.progress))}%` }} />
      </div>
      <p className="inline-status__message">{step.error ?? step.message ?? ""}</p>
    </div>
  );
};

