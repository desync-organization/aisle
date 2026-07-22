"use client";

import {
  AlertTriangle,
  Check,
  Clipboard,
  Code2,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  ServerCog,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  StackApiError,
  preflightStack,
  resolveStack,
  stackAgentOptions,
  type StackAgent,
  type StackMode,
  type StackPreflightRow,
  type StackPreflightSnapshot,
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

type PreflightState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "loading"; selectionKey: string }>
  | Readonly<{ status: "success"; selectionKey: string; snapshot: StackPreflightSnapshot }>
  | Readonly<{
      status: "error";
      selectionKey: string;
      code: string;
      message: string;
      fieldIssues: ReadonlyArray<Readonly<{ path: string; message: string }>>;
    }>;

type AcknowledgedWarningsState = Readonly<{
  selectionKey: string;
  keys: ReadonlySet<string>;
}>;

type CopyState = Readonly<{
  requestKey: string;
  status: "idle" | "copied" | "failed";
}>;

function warningAcknowledgementKey(row: StackPreflightRow): string {
  return JSON.stringify([row.id, row.revisionId, row.warningFingerprint]);
}

const scopeOptions: ReadonlyArray<Readonly<{ id: StackScope; label: string; note: string }>> = [
  { id: "project", label: "Project", note: "Write into this workspace" },
  { id: "global", label: "Global", note: "Write into user-level destinations" },
];

const modeOptions: ReadonlyArray<Readonly<{ id: StackMode; label: string; note: string }>> = [
  { id: "copy", label: "Copy", note: "Independent files per agent" },
  { id: "symlink", label: "Symlink", note: "Shared source where supported" },
];

const shellOptions: ReadonlyArray<Readonly<{
  id: StackShell;
  label: string;
  executable: string;
  note: string;
}>> = [
  { id: "powershell7", label: "PowerShell 7", executable: "pwsh.exe", note: "Not Command Prompt" },
  { id: "powershell51", label: "Windows PowerShell", executable: "powershell.exe", note: "Not Command Prompt" },
  { id: "cmd", label: "Command Prompt", executable: "cmd.exe", note: "Windows CMD syntax" },
  { id: "posix", label: "macOS / Linux", executable: "bash / zsh", note: "POSIX shell syntax" },
];

const fixedWarnings = [
  "Install steps are not rolled back. If a later step fails, earlier changes remain.",
  "The installer may report success even when an agent or requested destination fails. Check its output.",
  "Aisle checks repository paths, but the current installer does not pin the exact reviewed commit.",
  "A public source can change between review and installation.",
] as const;

function subscribeToPlatform(): () => void {
  return () => undefined;
}

function browserDefaultShell(): StackShell {
  return /Windows/i.test(navigator.userAgent) ? "cmd" : "posix";
}

function serverDefaultShell(): StackShell {
  return "cmd";
}

export function StackBuilder() {
  const { actions, meta, state } = useSelection();
  const [agents, setAgents] = useState<ReadonlyArray<StackAgent>>(["codex"]);
  const [scope, setScope] = useState<StackScope>("project");
  const [mode, setMode] = useState<StackMode>("copy");
  const detectedShell = useSyncExternalStore(
    subscribeToPlatform,
    browserDefaultShell,
    serverDefaultShell,
  );
  const [shellOverride, setShellOverride] = useState<StackShell | null>(null);
  const shell = shellOverride ?? detectedShell;
  const [preflightState, setPreflight] = useState<PreflightState>({ status: "idle" });
  const [preflightAttempt, setPreflightAttempt] = useState(0);
  const [acknowledgedWarningsState, setAcknowledgedWarnings] = useState<AcknowledgedWarningsState>(() => ({
    selectionKey: "",
    keys: new Set(),
  }));
  const [resolutionState, setResolution] = useState<ResolutionState>({ status: "idle" });
  const [copyState, setCopyState] = useState<CopyState>({ requestKey: "", status: "idle" });
  const preflightControllerRef = useRef<AbortController | null>(null);
  const resolveControllerRef = useRef<AbortController | null>(null);
  const commandResultRef = useRef<HTMLElement | null>(null);

  const selectionKey = JSON.stringify({
    ids: state.ids,
    packageAssertions: state.packageAssertions,
  });
  const preflight = preflightState.status !== "idle" && preflightState.selectionKey !== selectionKey
    ? ({ status: "idle" } as const)
    : preflightState;
  const acknowledgedWarnings = acknowledgedWarningsState.selectionKey === selectionKey
    ? acknowledgedWarningsState.keys
    : new Set<string>();
  const preflightRows = preflight.status === "success" ? preflight.snapshot.rows : [];
  const warningRows = preflightRows.filter((row) => row.trust === "warn");
  const hasUnselectableRows = preflightRows.some((row) => !row.selectable);
  const allWarningsAcknowledged = warningRows.every((row) => (
    acknowledgedWarnings.has(warningAcknowledgementKey(row))
  ));
  const reviewReady = preflight.status === "success" &&
    preflightRows.length === state.count &&
    !hasUnselectableRows &&
    allWarningsAcknowledged;
  const revisionSetKey = preflight.status === "success"
    ? preflight.snapshot.revisionSetKey
    : "unreviewed";
  const acknowledgementSetKey = JSON.stringify([...acknowledgedWarnings].toSorted());
  const requestKey = `${selectionKey}|${revisionSetKey}|${acknowledgementSetKey}|${agents.join(",")}|${scope}|${mode}|${shell}`;
  const resolution = resolutionState.status !== "idle" && resolutionState.requestKey !== requestKey
    ? ({ status: "idle" } as const)
    : resolutionState;
  const copyStatus = copyState.requestKey === requestKey ? copyState.status : "idle";
  const selectedShell = shellOptions.find((option) => option.id === shell) ?? shellOptions[0]!;

  useEffect(() => {
    if (resolution.status === "success" || resolution.status === "error") {
      commandResultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [resolution.status]);

  useEffect(() => {
    preflightControllerRef.current?.abort();
    resolveControllerRef.current?.abort();

    if (!state.hydrated || state.count === 0) {
      return;
    }

    const controller = new AbortController();
    preflightControllerRef.current = controller;
    const selectionIds = [...state.ids];
    const packageAssertions = [...state.packageAssertions];
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        setPreflight({ status: "loading", selectionKey });
      }
    });

    void preflightStack(
      { selectionIds, packageAssertions },
      { signal: controller.signal },
    )
      .then((snapshot) => {
        if (!controller.signal.aborted) {
          setPreflight({ status: "success", selectionKey, snapshot });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof StackApiError) {
          setPreflight({
            status: "error",
            selectionKey,
            code: error.code,
            message: error.message,
            fieldIssues: error.fieldIssues,
          });
          return;
        }
        setPreflight({
          status: "error",
          selectionKey,
          code: "PREFLIGHT_FAILED",
          message: "We couldn’t check the selected skills.",
          fieldIssues: [],
        });
      });

    return () => controller.abort();
  }, [preflightAttempt, selectionKey, state.count, state.hydrated, state.ids, state.packageAssertions]);

  useEffect(() => () => {
    preflightControllerRef.current?.abort();
    resolveControllerRef.current?.abort();
  }, []);

  function toggleAgent(agent: StackAgent) {
    setAgents((current) => current.includes(agent)
      ? current.filter((candidate) => candidate !== agent)
      : [...current, agent]);
  }

  function toggleWarningAcknowledgement(row: StackPreflightRow) {
    const key = warningAcknowledgementKey(row);
    setAcknowledgedWarnings((current) => {
      const next = current.selectionKey === selectionKey
        ? new Set(current.keys)
        : new Set<string>();
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { selectionKey, keys: next };
    });
  }

  function retryPreflight() {
    setPreflightAttempt((attempt) => attempt + 1);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      state.count === 0 ||
      agents.length === 0 ||
      preflight.status !== "success" ||
      !reviewReady
    ) return;

    const acknowledgedRows = warningRows.filter((row): row is StackPreflightRow & Readonly<{
      revisionId: string;
      warningFingerprint: string;
    }> => Boolean(row.revisionId && row.warningFingerprint));
    if (acknowledgedRows.length !== warningRows.length) return;

    resolveControllerRef.current?.abort();
    const controller = new AbortController();
    resolveControllerRef.current = controller;
    setCopyState({ requestKey, status: "idle" });
    setResolution({ status: "loading", requestKey });

    try {
      const plan = await resolveStack({
        selectionIds: preflight.snapshot.rows.map((row) => row.id),
        packageAssertions: state.packageAssertions,
        acknowledgements: acknowledgedRows.map((row) => ({
          selectionId: row.id,
          revisionId: row.revisionId,
          warningFingerprint: row.warningFingerprint,
        })),
        options: { agents, scope, mode, shell },
      }, { signal: controller.signal });
      if (!controller.signal.aborted) setResolution({ status: "success", requestKey, plan });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof StackApiError) {
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
        message: "We couldn’t build a command for these skills.",
        fieldIssues: [],
      });
    }
  }

  async function copyCommand() {
    if (resolution.status !== "success") return;
    try {
      await navigator.clipboard.writeText(resolution.plan.command);
      setCopyState({ requestKey, status: "copied" });
    } catch {
      setCopyState({ requestKey, status: "failed" });
    }
  }

  if (state.count === 0) {
    return (
      <section className="stack-empty-state">
        <span><Layers3 aria-hidden="true" size={27} /></span>
        <div>
          <p className="eyebrow">Your stack is empty</p>
          <h2>Pick at least one skill.</h2>
          <p>Then come back here to review it and generate an install command.</p>
        </div>
        <Link className="button button--primary" href="/skills">Browse public skills</Link>
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
            We check every skill again before generating your command.
          </p>
          {preflight.status === "loading" || preflight.status === "idle" ? (
            <div className="stack-preflight-status">
              <LoaderCircle aria-hidden="true" className="stack-spinner" size={17} />
              <div><strong>Checking selected skills</strong><span>This usually takes a moment.</span></div>
            </div>
          ) : null}
          {preflight.status === "error" ? (
            <div className="stack-preflight-status stack-preflight-status--error">
              <AlertTriangle aria-hidden="true" size={17} />
              <div>
                <strong>{preflight.message}</strong>
                <span>{preflight.code}</span>
                {preflight.fieldIssues.length > 0 ? (
                  <ul>{preflight.fieldIssues.map((issue) => <li key={`${issue.path}:${issue.message}`}>{issue.path}: {issue.message}</li>)}</ul>
                ) : null}
              </div>
              <Button onClick={retryPreflight} variant="quiet"><RefreshCw aria-hidden="true" size={14} /> Retry</Button>
            </div>
          ) : null}

          {preflight.status === "success" ? (
            <ul className="stack-selection-list stack-selection-list--reviewed">
              {preflight.snapshot.rows.map((row, index) => {
                const warningKey = warningAcknowledgementKey(row);
                const warningAcknowledged = acknowledgedWarnings.has(warningKey);
                return (
                  <li data-selectable={row.selectable ? "true" : "false"} key={row.id}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <strong>{row.name}</strong>
                    {row.trust === "warn" && row.warningFingerprint ? (
                      <label className="stack-warning-ack" data-checked={warningAcknowledged ? "true" : "false"}>
                        <input
                          checked={warningAcknowledged}
                          onChange={() => toggleWarningAcknowledgement(row)}
                          type="checkbox"
                        />
                        <span>{warningAcknowledged ? <Check aria-hidden="true" size={12} /> : null}</span>
                        <span>Acknowledge</span>
                      </label>
                    ) : <span aria-hidden="true" className="stack-selection-list__spacer" />}
                    <Button aria-label={`Remove ${row.name}`} onClick={() => actions.remove(row.id)} variant="quiet">
                      <X aria-hidden="true" size={15} />
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <ul className="stack-selection-list">
              {state.ids.map((id, index) => (
                <li key={id}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>Checking selected skill</strong>
                  <span aria-hidden="true" className="stack-selection-list__spacer" />
                  <Button aria-label={`Remove selection ${id}`} onClick={() => actions.remove(id)} variant="quiet">
                    <X aria-hidden="true" size={15} />
                  </Button>
                </li>
              ))}
            </ul>
          )}
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
            <legend>Installer destinations <span>{agents.length}/8 selected</span></legend>
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
                  <input checked={shell === option.id} name="shell" onChange={() => setShellOverride(option.id)} type="radio" />
                  <span><strong>{option.label}</strong><small>{option.executable}</small></span>
                </label>
              ))}
            </div>
          </fieldset>

          <p className="stack-shell-help">
            <strong>Match the name on your terminal tab.</strong> Windows Terminal is the app; Command Prompt and PowerShell use different command syntax.
          </p>

          <p className="stack-options-card__boundary">These are the apps supported by the installer. Individual skills may have their own requirements.</p>
          {agents.length === 0 ? <p className="stack-options-card__error">Choose at least one installer destination.</p> : null}
          {preflight.status === "error" ? <p className="stack-options-card__error">We need to check every skill before generating a command.</p> : null}
          {preflight.status === "success" && hasUnselectableRows ? (
            <p className="stack-options-card__error">Remove every blocked selection before continuing.</p>
          ) : null}
          {preflight.status === "success" && !hasUnselectableRows && !allWarningsAcknowledged ? (
            <p className="stack-options-card__error">Review and acknowledge each skill warning.</p>
          ) : null}
          <Button
            className="stack-resolve-button"
            disabled={agents.length === 0 || !reviewReady || resolution.status === "loading"}
            type="submit"
          >
            {resolution.status === "loading" || preflight.status === "loading"
              ? <LoaderCircle aria-hidden="true" className="stack-spinner" size={17} />
              : resolution.status === "success"
                ? <Check aria-hidden="true" size={17} />
                : <LockKeyhole aria-hidden="true" size={17} />}
            {resolution.status === "loading"
              ? "Building your command…"
              : resolution.status === "success"
                ? "Command ready below"
              : preflight.status === "loading" || preflight.status === "idle"
                ? "Checking selected skills…"
                : hasUnselectableRows
                  ? "Remove blocked skills"
                  : !allWarningsAcknowledged
                    ? "Review skill warnings"
                    : preflight.status === "error"
                      ? "Skill check unavailable"
                      : "Generate command"}
          </Button>
        </form>
      </div>

      <section aria-labelledby="stack-warning-heading" className="stack-warning-panel">
        <div>
          <ShieldAlert aria-hidden="true" size={22} />
          <span>Read before running</span>
          <h2 id="stack-warning-heading">Read the command before you run it.</h2>
        </div>
        <ul>
          {fixedWarnings.map((warning) => <li key={warning}><AlertTriangle aria-hidden="true" size={14} /> {warning}</li>)}
        </ul>
      </section>

      <section aria-live="polite" className={`stack-command-state stack-command-state--${resolution.status}`} ref={commandResultRef}>
        {resolution.status === "idle" ? (
          <>
            <span><Code2 aria-hidden="true" size={22} /></span>
            <div>
              <p className="eyebrow">03 / Command</p>
              <h2>No command yet.</h2>
              <p>Review your skills, then generate a command.</p>
            </div>
          </>
        ) : null}
        {resolution.status === "loading" ? (
          <>
            <span><LoaderCircle aria-hidden="true" className="stack-spinner" size={22} /></span>
            <div>
              <p className="eyebrow">03 / Resolving</p>
              <h2>Building your command.</h2>
              <p>We’re checking each selected skill one more time.</p>
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
                <h2>{resolution.plan.selectionCount} skills from {resolution.plan.sourceCount} {resolution.plan.sourceCount === 1 ? "source" : "sources"}</h2>
              </div>
              <span>{resolution.plan.runtime.package} · Node {resolution.plan.runtime.minimumNodeVersion}</span>
            </div>
            <div className="stack-command-result__shell" data-shell={shell}>
              <div>
                <span>Run with</span>
                <strong>{selectedShell.label}</strong>
                <code>{selectedShell.executable}</code>
              </div>
              <p>{selectedShell.note}. If your terminal tab says something else, select that shell above and generate again.</p>
            </div>
            <div className="stack-command-result__command">
              <code>{resolution.plan.command}</code>
              <Button onClick={copyCommand} variant="secondary">
                {copyStatus === "copied" ? <Check aria-hidden="true" size={15} /> : <Clipboard aria-hidden="true" size={15} />}
                {copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? "Copy failed" : `Copy for ${selectedShell.label}`}
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
