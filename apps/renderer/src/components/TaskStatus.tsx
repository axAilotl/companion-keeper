import type { AsyncStepState } from "@/store/useRendererStore";

interface TaskStatusProps {
  title: string;
  step: AsyncStepState;
}

export const TaskStatus = ({ title, step }: TaskStatusProps): JSX.Element => {
  const tone =
    step.phase === "error"
      ? "error"
      : step.phase === "success"
        ? "success"
        : step.phase === "loading"
          ? "active"
          : "idle";

  return (
    <section className={`task-status task-status--${tone}`} aria-live="polite">
      <div className="task-status__top-row">
        <strong>{title}</strong>
        <span className="task-status__phase">{step.phase}</span>
      </div>
      <div className="task-status__progress-wrap" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={step.progress}>
        <div className="task-status__progress" style={{ width: `${step.progress}%` }} />
      </div>
      <p className="task-status__message">{step.error ?? step.message ?? ""}</p>
    </section>
  );
};
