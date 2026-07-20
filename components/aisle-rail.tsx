import { Check, GitBranch, LockKeyhole, PackageCheck } from "lucide-react";

const sources = [
  { icon: GitBranch, label: "Public source", rail: "rail--left" },
  { icon: LockKeyhole, label: "Pinned revision", rail: "rail--middle" },
  { icon: PackageCheck, label: "Trust state", rail: "rail--right" },
] as const;

export function AisleRail() {
  return (
    <div
      aria-label="Public sources, pinned revisions, and trust checks converge into your selected stack."
      className="aisle-visual"
      role="img"
    >
      <div className="aisle-visual__grid" />
      <div className="aisle-visual__source-row">
        {sources.map(({ icon: Icon, label, rail }) => (
          <div className={`aisle-source ${rail}`} key={label}>
            <span>
              <Icon aria-hidden="true" size={16} />
            </span>
            <small>{label}</small>
          </div>
        ))}
      </div>
      <div aria-hidden="true" className="aisle-visual__rails">
        <span />
        <span />
        <span />
      </div>
      <div className="stack-card">
        <div className="stack-card__topline">
          <span>Your stack</span>
          <span className="stack-card__check">
            <Check aria-hidden="true" size={12} />
          </span>
        </div>
        <strong>Choose with context.</strong>
        <p>One immutable manifest keeps every source visible.</p>
        <div aria-hidden="true" className="stack-card__slots">
          <span />
          <span />
          <span />
        </div>
      </div>
      <div className="aisle-visual__caption">
        <span>01 · discover</span>
        <span>02 · verify</span>
        <span>03 · compose</span>
      </div>
    </div>
  );
}
