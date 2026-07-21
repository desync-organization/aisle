"use client";

import {
  AlertTriangle,
  ArrowUpRight,
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
import { useEffect, useRef, useState, type FormEvent } from "react";

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
import { catalogSelectionGateCopy } from "@/lib/marketplace/selection-gates";
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

function warningAcknowledgementKey(row: StackPreflightRow): string {
  return JSON.stringify([row.id, row.revisionId, row.warningFingerprint]);
}

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
  const [preflightState, setPreflight] = useState<PreflightState>({ status: "idle" });
  const [preflightAttempt, setPreflightAttempt] = useState(0);
  const [acknowledgedWarnings, setAcknowledgedWarnings] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [resolutionState, setResolution] = useState<ResolutionState>({ status: "idle" });
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const preflightControllerRef = useRef<AbortController | null>(null);
  const resolveControllerRef = useRef<AbortController | null>(null);

  const selectionKey = state.ids.join(",");
  const preflight = preflightState.status !== "idle" && preflightState.selectionKey !== selectionKey
    ? ({ status: "idle" } as const)
    : preflightState;
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

  useEffect(() => {
    resolveControllerRef.current?.abort();
    setResolution({ status: "idle" });
    setCopyState("idle");
  }, [requestKey]);

  useEffect(() => {
    preflightControllerRef.current?.abort();
    resolveControllerRef.current?.abort();
    setAcknowledgedWarnings(new Set());
    setResolution({ status: "idle" });
    setCopyState("idle");

    if (!state.hydrated || state.count === 0) {
      setPreflight({ status: "idle" });
      return;
    }

    const controller = new AbortController();
    preflightControllerRef.current = controller;
    const selectionIds = [...state.ids];
    setPreflight({ status: "loading", selectionKey });

    void preflightStack({ selectionIds }, { signal: controller.signal })
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
          message: "The selected stack could not be reviewed.",
          fieldIssues: [],
        });
      });

    return () => controller.abort();
  }, [preflightAttempt, selectionKey, state.count, state.hydrated, state.ids]);

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
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
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
    setCopyState("idle");
    setResolution({ status: "loading", requestKey });

    try {
      const plan = await resolveStack({
        selectionIds: preflight.snapshot.rows.map((row) => row.id),
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
            The server binds every device-local ID to current public metadata before configuration begins. Review the exact source, license, trust state, and revision below.
          </p>
          {preflight.status === "loading" || preflight.status === "idle" ? (
            <div className="stack-preflight-status">
              <LoaderCircle aria-hidden="true" className="stack-spinner" size={17} />
              <div><strong>Reviewing selected revisions</strong><span>No command can be requested until every row returns.</span></div>
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
                    <div className="stack-selection-list__body">
                      <div className="stack-selection-list__title">
                        <strong>{row.name}</strong>
                        <span className={`trust-pill trust-pill--${row.trust}`}>
                          {row.trust === "pass" ? "Trust checked" : row.trust === "warn" ? "Review warning" : row.trust}
                        </span>
                      </div>
                      <code>{row.id}</code>
                      <dl className="stack-selection-metadata">
                        <div>
                          <dt>Source</dt>
                          <dd><a href={row.sourceUrl} rel="noreferrer" target="_blank">{row.sourceUrl} <ArrowUpRight aria-hidden="true" size={11} /></a></dd>
                        </div>
                        <div><dt>License</dt><dd>{row.license}</dd></div>
                        <div><dt>Revision ID</dt><dd>{row.revisionId || "Pending"}</dd></div>
                        <div><dt>Immutable ref</dt><dd>{row.immutableRef || "Pending"}</dd></div>
                      </dl>
                      {row.gateReasons.length > 0 ? (
                        <ul className="stack-selection-gates">
                          {row.gateReasons.map((reason) => <li key={reason}>{catalogSelectionGateCopy[reason]}</li>)}
                        </ul>
                      ) : null}
                      {row.trust === "warn" && row.warningFingerprint ? (
                        <label className="stack-warning-ack" data-checked={warningAcknowledged ? "true" : "false"}>
                          <input
                            checked={warningAcknowledged}
                            onChange={() => toggleWarningAcknowledgement(row)}
                            type="checkbox"
                          />
                          <span>{warningAcknowledged ? <Check aria-hidden="true" size={12} /> : null}</span>
                          <span>
                            I acknowledge this warning for revision {row.immutableRef?.slice(0, 12)}.
                            <code>{row.warningFingerprint.slice(0, 16)}</code>
                          </span>
                        </label>
                      ) : null}
                    </div>
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
                  <div><strong>Catalog selection</strong><code>{id}</code></div>
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
          {preflight.status === "error" ? <p className="stack-options-card__error">Revision review must succeed before a command can be requested.</p> : null}
          {preflight.status === "success" && hasUnselectableRows ? (
            <p className="stack-options-card__error">Remove every blocked selection before continuing.</p>
          ) : null}
          {preflight.status === "success" && !hasUnselectableRows && !allWarningsAcknowledged ? (
            <p className="stack-options-card__error">Acknowledge each revision-bound warning in the review panel.</p>
          ) : null}
          <Button
            className="stack-resolve-button"
            disabled={agents.length === 0 || !reviewReady || resolution.status === "loading"}
            type="submit"
          >
            {resolution.status === "loading" || preflight.status === "loading"
              ? <LoaderCircle aria-hidden="true" className="stack-spinner" size={17} />
              : <LockKeyhole aria-hidden="true" size={17} />}
            {resolution.status === "loading"
              ? "Resolving every skill…"
              : preflight.status === "loading" || preflight.status === "idle"
                ? "Reviewing selected revisions…"
                : hasUnselectableRows
                  ? "Remove blocked skills"
                  : !allWarningsAcknowledged
                    ? "Acknowledge revision warnings"
                    : preflight.status === "error"
                      ? "Revision review unavailable"
                      : "Generate reviewed command"}
          </Button>
          <p className="stack-options-card__boundary">No command is assembled in the browser. Resolve receives only the reviewed IDs plus acknowledgements bound to the returned revision and warning fingerprint.</p>
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
              <p>Complete revision review and any warning acknowledgements, then ask the server to revalidate the exact stack.</p>
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
