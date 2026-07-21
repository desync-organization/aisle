"use client";

import {
  AlertTriangle,
  Check,
  Clipboard,
  Code2,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  ServerCog,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  StackResolveError,
  resolveStack,
  stackAgentOptions,
  type StackAgent,
  type StackMode,
  type StackResolvePlan,
  type StackScope,
  type StackShell,
} from "@/lib/marketplace/stack-api";
import { useSelection } from "@/lib/selection/react";

type ResolutionState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "loading"; requestKey: string }>
  | Readonly<{ status: "success"; requestKey: string; plan: StackResolvePlan }>
  | Readonly<{ status: "error"; requestKey: string; code: string; message: string; fieldIssues: ReadonlyArray<Readonly<{ path: string; message: string }>> }>;

const scopeOptions: ReadonlyArray<Readonly<{ id: StackScope; label: string; note: string }>> = [
  { id: "project", label: "Project", note: "Install for this workspace" },
  { id: "global", label: "Global", note: "Install for the selected agents" },
];

const modeOptions: ReadonlyArray<Readonly<{ id: StackMode; label: string; note: string }>> = [
  { id: "copy", label: "Copy", note: "Independent files per agent" },
  { id: "symlink", label: "Symlink", note: "Shared source where supported" },
];

const shellOptions: ReadonlyArray<Readonly<{ id: StackShell; label: string }>> = [
  { id: "powershell7", label: "PowerShell 7" },
  { id: "powershell51", label: "Windows PowerShell" },
  { id: "cmd", label: "Command Prompt" },
  { id: "posix", label: "macOS / Linux" },
];

const fixedWarnings = [
  "Installation is best-effort and non-atomic. A successful earlier process is not rolled back if a later process fails.",
  "The pinned installer can report process success after an individual agent fails or after only part of a requested scope matches.",
  "The command enforces a reviewed repository path scope, but the current installer does not enforce the observed commit SHA.",
  "A public source branch can move between backend preflight and the moment the installer clones it.",
] as const;

export function StackBuilder() {
  const { actions, meta, state } = useSelection();
  const [agents, setAgents] = useState<ReadonlyArray<StackAgent>>(["codex"]);
  const [scope, setScope] = useState<StackScope>("project");
  const [mode, setMode] = useState<StackMode>("copy");
  const [shell, setShell] = useState<StackShell>("powershell7");
  const [resolutionState, setResolution] = useState<ResolutionState>({ status: "idle" });
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const controllerRef = useRef<AbortController | null>(null);

  const requestKey = `${state.ids.join(",")}|${agents.join(",")}|${scope}|${mode}|${shell}`;
  const resolution = resolutionState.status !== "idle" && resolutionState.requestKey !== requestKey
    ? ({ status: "idle" } as const)
    : resolutionState;
  const resolvedSkills = useMemo(() => {
    if (resolution.status !== "success" || !resolution.plan.resolvedSkills) return new Map<string, string>();
    return new Map(resolution.plan.resolvedSkills.map((skill) => [skill.id, skill.name]));
  }, [resolution]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  function toggleAgent(agent: StackAgent) {
    setAgents((current) => current.includes(agent)
      ? current.filter((candidate) => candidate !== agent)
      : [...current, agent]);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.count === 0 || agents.length === 0) return;

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setCopyState("idle");
    setResolution({ status: "loading", requestKey });

    try {
      const plan = await resolveStack({
        selectionIds: state.ids,
        options: { agents, scope, mode, shell },
      }, { signal: controller.signal });
      if (!controller.signal.aborted) setResolution({ status: "success", requestKey, plan });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof StackResolveError) {
        setResolution({
          status: "error",
          requestKey,
          code: error.code,
          message: error.message,
          fieldIssues: error.fieldIssues,
        });
        return;
      }
      setResolution({
        status: "error",
        requestKey,
        code: "RESOLVE_FAILED",
        message: "The selected stack could not be resolved.",
        fieldIssues: [],
      });
    }
  }

  async function copyCommand() {
    if (resolution.status !== "success") return;
    try {
      await navigator.clipboard.writeText(resolution.plan.command);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  if (state.count === 0) {
    return (
      <section className="stack-empty-state">
        <span><Layers3 aria-hidden="true" size={27} /></span>
        <div>
          <p className="eyebrow">Your stack is empty</p>
          <h2>Select public skills before generating a command.</h2>
          <p>The resolver accepts only canonical catalog IDs from your device-local selection. It does not accept pasted source URLs or arbitrary command fragments.</p>
        </div>
        <a className="button button--primary" href="/skills">Browse public skills</a>
      </section>
    );
  }

  return (
    <div className="stack-builder">
      <div className="stack-builder__columns">
        <section aria-labelledby="stack-review-heading" className="stack-review-card">
          <div className="stack-card-heading">
            <div>
              <span>01 / Review</span>
              <h2 id="stack-review-heading">Selected skills</h2>
            </div>
            <span>{state.count}/{meta.maxSelections}</span>
          </div>
          <p className="stack-review-card__note">
            These are opaque Aisle catalog IDs. The server must resolve every ID to one current, public, licensed, trust-eligible revision before a command is returned.
          </p>
          <ul className="stack-selection-list">
            {state.ids.map((id, index) => (
              <li key={id}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <strong>{resolvedSkills.get(id) || "Catalog selection"}</strong>
                  <code>{id}</code>
                </div>
                <Button aria-label={`Remove selection ${id}`} onClick={() => actions.remove(id)} variant="quiet">
                  <X aria-hidden="true" size={15} />
                </Button>
              </li>
            ))}
          </ul>
          <Button className="stack-clear" onClick={() => actions.clear()} variant="quiet">
            <Trash2 aria-hidden="true" size={15} /> Clear selection
          </Button>
        </section>

        <form aria-labelledby="stack-options-heading" className="stack-options-card" onSubmit={submit}>
          <div className="stack-card-heading">
            <div>
              <span>02 / Configure</span>
              <h2 id="stack-options-heading">Install target</h2>
            </div>
            <ServerCog aria-hidden="true" size={20} />
          </div>

          <fieldset className="stack-agent-fieldset">
            <legend>Agents <span>{agents.length}/8 selected</span></legend>
            <div>
              {stackAgentOptions.map((agent) => {
                const checked = agents.includes(agent.id);
                return (
                  <label data-checked={checked ? "true" : "false"} key={agent.id}>
                    <input checked={checked} onChange={() => toggleAgent(agent.id)} type="checkbox" />
                    <span>{checked ? <Check aria-hidden="true" size={13} /> : null}</span>
                    {agent.label}
                  </label>
                );
              })}
            </div>
          </fieldset>

          <OptionGroup legend="Scope" name="scope" onChange={(value) => setScope(value as StackScope)} options={scopeOptions} value={scope} />
          <OptionGroup legend="Mode" name="mode" onChange={(value) => setMode(value as StackMode)} options={modeOptions} value={mode} />

          <fieldset className="stack-shell-fieldset">
            <legend>Command shell</legend>
            <div>
              {shellOptions.map((option) => (
                <label data-checked={shell === option.id ? "true" : "false"} key={option.id}>
                  <input checked={shell === option.id} name="shell" onChange={() => setShell(option.id)} type="radio" />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>

          {agents.length === 0 ? <p className="stack-options-card__error">Choose at least one supported agent.</p> : null}
          <Button className="stack-resolve-button" disabled={agents.length === 0 || resolution.status === "loading"} type="submit">
            {resolution.status === "loading"
              ? <LoaderCircle aria-hidden="true" className="stack-spinner" size={17} />
              : <LockKeyhole aria-hidden="true" size={17} />}
            {resolution.status === "loading" ? "Resolving every skill…" : "Generate reviewed command"}
          </Button>
          <p className="stack-options-card__boundary">No command is assembled in the browser. The server resolves and revalidates the complete selection first.</p>
        </form>
      </div>

      <section aria-labelledby="stack-warning-heading" className="stack-warning-panel">
        <div>
          <ShieldAlert aria-hidden="true" size={22} />
          <span>Read before running</span>
          <h2 id="stack-warning-heading">One command is convenient. It is not a transaction.</h2>
        </div>
        <ul>
          {fixedWarnings.map((warning) => <li key={warning}><AlertTriangle aria-hidden="true" size={14} /> {warning}</li>)}
        </ul>
      </section>

      <section aria-live="polite" className={`stack-command-state stack-command-state--${resolution.status}`}>
        {resolution.status === "idle" ? (
          <>
            <span><Code2 aria-hidden="true" size={22} /></span>
            <div>
              <p className="eyebrow">03 / Command</p>
              <h2>No command generated yet.</h2>
              <p>Review the selections and target above, then ask the server to resolve every skill.</p>
            </div>
          </>
        ) : null}
        {resolution.status === "loading" ? (
          <>
            <span><LoaderCircle aria-hidden="true" className="stack-spinner" size={22} /></span>
            <div>
              <p className="eyebrow">03 / Resolving</p>
              <h2>Checking the complete stack.</h2>
              <p>Public state, revision evidence, license, trust, compatibility, selector scope, and command length are being evaluated.</p>
            </div>
          </>
        ) : null}
        {resolution.status === "error" ? (
          <>
            <span><AlertTriangle aria-hidden="true" size={22} /></span>
            <div>
              <p className="eyebrow">{resolution.code}</p>
              <h2>No command was issued.</h2>
              <p>{resolution.message}</p>
              {resolution.fieldIssues.length > 0 ? (
                <ul>{resolution.fieldIssues.map((issue) => <li key={`${issue.path}:${issue.message}`}><code>{issue.path}</code> {issue.message}</li>)}</ul>
              ) : null}
            </div>
          </>
        ) : null}
        {resolution.status === "success" ? (
          <div className="stack-command-result">
            <div className="stack-command-result__meta">
              <div>
                <p className="eyebrow">03 / Reviewed command</p>
                <h2>{resolution.plan.selectionCount} skills across {resolution.plan.sourceCount} source {resolution.plan.sourceCount === 1 ? "scope" : "scopes"}</h2>
              </div>
              <span>{resolution.plan.runtime.package} · Node {resolution.plan.runtime.minimumNodeVersion}</span>
            </div>
            <div className="stack-command-result__command">
              <code>{resolution.plan.command}</code>
              <Button onClick={copyCommand} variant="secondary">
                {copyState === "copied" ? <Check aria-hidden="true" size={15} /> : <Clipboard aria-hidden="true" size={15} />}
                {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}
              </Button>
            </div>
            <ul className="stack-command-result__warnings">
              {resolution.plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function OptionGroup({
  legend,
  name,
  onChange,
  options,
  value,
}: {
  legend: string;
  name: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<Readonly<{ id: string; label: string; note: string }>>;
  value: string;
}) {
  return (
    <fieldset className="stack-option-group">
      <legend>{legend}</legend>
      <div>
        {options.map((option) => (
          <label data-checked={value === option.id ? "true" : "false"} key={option.id}>
            <input checked={value === option.id} name={name} onChange={() => onChange(option.id)} type="radio" />
            <span><strong>{option.label}</strong><small>{option.note}</small></span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
