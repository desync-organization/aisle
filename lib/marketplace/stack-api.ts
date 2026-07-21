import {
  catalogSelectionGateReasons,
  type CatalogSelectionGateReason,
  type CatalogTrustState,
} from "@/lib/marketplace/selection-gates";

export const stackAgentOptions = [
  { id: "codex", label: "Codex" },
  { id: "claude-code", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "github-copilot", label: "GitHub Copilot" },
  { id: "gemini-cli", label: "Gemini CLI" },
  { id: "opencode", label: "OpenCode" },
  { id: "cline", label: "Cline" },
  { id: "windsurf", label: "Windsurf" },
] as const;

export type StackAgent = (typeof stackAgentOptions)[number]["id"];
export type StackScope = "project" | "global";
export type StackMode = "copy" | "symlink";
export type StackShell = "posix" | "powershell7" | "powershell51" | "cmd";

export type StackPreflightRequest = Readonly<{
  selectionIds: ReadonlyArray<string>;
}>;

export type StackPreflightRow = Readonly<{
  id: string;
  name: string;
  sourceUrl: string;
  license: string;
  compatibilityAdvisory: string | null;
  trust: CatalogTrustState;
  revisionId: string | null;
  immutableRef: string | null;
  selectable: boolean;
  gateReasons: ReadonlyArray<CatalogSelectionGateReason>;
  warningFingerprint?: string;
}>;

export type StackPreflightSnapshot = Readonly<{
  rows: ReadonlyArray<StackPreflightRow>;
  revisionSetKey: string;
}>;

export type StackWarningAcknowledgement = Readonly<{
  selectionId: string;
  revisionId: string;
  warningFingerprint: string;
}>;

export type StackResolveRequest = Readonly<{
  selectionIds: ReadonlyArray<string>;
  acknowledgements: ReadonlyArray<StackWarningAcknowledgement>;
  options: Readonly<{
    agents: ReadonlyArray<StackAgent>;
    scope: StackScope;
    mode: StackMode;
    shell: StackShell;
  }>;
}>;

export type StackResolvedSkill = Readonly<{
  id: string;
  name: string;
  source: string;
  revision: string;
  license: string;
  compatibilityAdvisory: string | null;
  trust: "pass" | "warn";
}>;

export type StackResolvePlan = Readonly<{
  id: string;
  command: string;
  selectionCount: number;
  sourceCount: number;
  runtime: Readonly<{
    package: string;
    minimumNodeVersion: string;
  }>;
  semantics: Readonly<{
    atomic: false;
    runtimeCompletenessVerified: false;
    sourceRevisionEnforced: false;
    pathScopeEnforced: true;
    partialInstallPossible: true;
    agentFailureMayExitZero: true;
    mutableSourceRacePossible: true;
  }>;
  warnings: ReadonlyArray<string>;
  resolvedSkills?: ReadonlyArray<StackResolvedSkill>;
}>;

type StackResolveSuccess = Readonly<{
  ok: true;
  plan: StackResolvePlan;
}>;

type StackResolveFailure = Readonly<{
  ok: false;
  error: Readonly<{
    code: string;
    message: string;
    fieldIssues?: ReadonlyArray<Readonly<{ path: string; message: string }>>;
  }>;
}>;

type StackPreflightSuccess = Readonly<{
  ok: true;
  rows: ReadonlyArray<StackPreflightRow>;
}>;

export class StackApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fieldIssues: ReadonlyArray<Readonly<{ path: string; message: string }>>;

  constructor(
    code: string,
    message: string,
    status: number,
    fieldIssues: ReadonlyArray<Readonly<{ path: string; message: string }>> = [],
  ) {
    super(message);
    this.name = "StackApiError";
    this.code = code;
    this.status = status;
    this.fieldIssues = fieldIssues;
  }
}

export class StackResolveError extends StackApiError {
  constructor(
    code: string,
    message: string,
    status: number,
    fieldIssues: ReadonlyArray<Readonly<{ path: string; message: string }>> = [],
  ) {
    super(code, message, status, fieldIssues);
    this.name = "StackResolveError";
  }
}

export class StackPreflightError extends StackApiError {
  constructor(
    code: string,
    message: string,
    status: number,
    fieldIssues: ReadonlyArray<Readonly<{ path: string; message: string }>> = [],
  ) {
    super(code, message, status, fieldIssues);
    this.name = "StackPreflightError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFieldIssue(value: unknown): value is Readonly<{ path: string; message: string }> {
  return isRecord(value) && typeof value.path === "string" && typeof value.message === "string";
}

function isCatalogGateReason(value: unknown): value is CatalogSelectionGateReason {
  return typeof value === "string" && catalogSelectionGateReasons.includes(
    value as CatalogSelectionGateReason,
  );
}

function isCatalogTrustState(value: unknown): value is CatalogTrustState {
  return value === "pass" || value === "warn" || value === "unreviewed" || value === "blocked";
}

function isSafePublicSourceUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function isCompatibilityAdvisory(value: unknown): value is string | null {
  return value === null || (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 500 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function parseFailure(payload: unknown, status: number): StackResolveError {
  if (isRecord(payload) && payload.ok === false && isRecord(payload.error)) {
    const code = typeof payload.error.code === "string" ? payload.error.code : "RESOLVE_FAILED";
    const message = typeof payload.error.message === "string"
      ? payload.error.message
      : "The selected stack could not be resolved.";
    const fieldIssues = Array.isArray(payload.error.fieldIssues)
      ? payload.error.fieldIssues.filter(isFieldIssue)
      : [];
    return new StackResolveError(code, message, status, fieldIssues);
  }

  return new StackResolveError(
    status === 404 ? "RESOLVER_UNAVAILABLE" : "RESOLVE_FAILED",
    status === 404
      ? "The stack resolver is not available in this environment yet."
      : "The selected stack could not be resolved.",
    status,
  );
}

function parsePreflightFailure(payload: unknown, status: number): StackPreflightError {
  if (isRecord(payload) && payload.ok === false && isRecord(payload.error)) {
    const code = typeof payload.error.code === "string" ? payload.error.code : "PREFLIGHT_FAILED";
    const message = typeof payload.error.message === "string"
      ? payload.error.message
      : "The selected stack could not be reviewed.";
    const fieldIssues = Array.isArray(payload.error.fieldIssues)
      ? payload.error.fieldIssues.filter(isFieldIssue)
      : [];
    return new StackPreflightError(code, message, status, fieldIssues);
  }

  return new StackPreflightError(
    status === 404 ? "PREFLIGHT_UNAVAILABLE" : "PREFLIGHT_FAILED",
    status === 404
      ? "Stack preflight is not available in this environment yet."
      : "The selected stack could not be reviewed.",
    status,
  );
}

function parsePreflightRow(value: unknown, index: number): StackPreflightRow {
  if (!isRecord(value)) {
    throw new StackPreflightError(
      "INVALID_RESPONSE",
      `Preflight row ${index + 1} is invalid.`,
      502,
    );
  }

  const gateReasons = Array.isArray(value.gateReasons) && value.gateReasons.every(isCatalogGateReason)
    ? [...value.gateReasons]
    : null;
  const revisionId = typeof value.revisionId === "string" && value.revisionId.length > 0
    ? value.revisionId
    : value.revisionId === null
      ? null
      : undefined;
  const immutableRef = typeof value.immutableRef === "string" && value.immutableRef.length > 0
    ? value.immutableRef
    : value.immutableRef === null
      ? null
      : undefined;
  const warningFingerprint = typeof value.warningFingerprint === "string" &&
    value.warningFingerprint.length > 0 &&
    value.warningFingerprint.length <= 512
    ? value.warningFingerprint
    : undefined;

  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.name !== "string" ||
    value.name.trim().length === 0 ||
    value.name.length > 300 ||
    !isSafePublicSourceUrl(value.sourceUrl) ||
    typeof value.license !== "string" ||
    value.license.length === 0 ||
    value.license.length > 256 ||
    !isCompatibilityAdvisory(value.compatibilityAdvisory) ||
    !isCatalogTrustState(value.trust) ||
    revisionId === undefined ||
    immutableRef === undefined ||
    typeof value.selectable !== "boolean" ||
    gateReasons === null ||
    new Set(gateReasons).size !== gateReasons.length ||
    (value.selectable && (
      gateReasons.length > 0 ||
      revisionId === null ||
      immutableRef === null ||
      (value.trust !== "pass" && value.trust !== "warn")
    )) ||
    (!value.selectable && gateReasons.length === 0) ||
    (value.trust === "warn" && (
      revisionId === null ||
      immutableRef === null ||
      !warningFingerprint
    ))
  ) {
    throw new StackPreflightError(
      "INVALID_RESPONSE",
      `Preflight row ${index + 1} did not satisfy the revision-bound contract.`,
      502,
    );
  }

  return {
    id: value.id,
    name: value.name,
    sourceUrl: value.sourceUrl,
    license: value.license,
    compatibilityAdvisory: value.compatibilityAdvisory,
    trust: value.trust,
    revisionId,
    immutableRef,
    selectable: value.selectable,
    gateReasons,
    ...(warningFingerprint ? { warningFingerprint } : {}),
  };
}

function parsePreflight(
  payload: unknown,
  selectionIds: ReadonlyArray<string>,
): StackPreflightSnapshot {
  if (!isRecord(payload) || payload.ok !== true || !Array.isArray(payload.rows)) {
    throw new StackPreflightError(
      "INVALID_RESPONSE",
      "The stack preflight returned an invalid response.",
      502,
    );
  }

  const rows = payload.rows.map(parsePreflightRow);
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  if (
    rows.length !== selectionIds.length ||
    rowsById.size !== rows.length ||
    selectionIds.some((id) => !rowsById.has(id))
  ) {
    throw new StackPreflightError(
      "INCOMPLETE_PREFLIGHT",
      "The stack preflight did not return the exact selected ID set.",
      502,
    );
  }

  const orderedRows = selectionIds.map((id) => rowsById.get(id)!);
  return {
    rows: orderedRows,
    revisionSetKey: JSON.stringify(orderedRows.map((row) => [
      row.id,
      row.revisionId,
      row.immutableRef,
      row.compatibilityAdvisory,
      row.warningFingerprint ?? null,
    ])),
  };
}

function parsePlan(payload: unknown): StackResolvePlan {
  if (!isRecord(payload) || payload.ok !== true || !isRecord(payload.plan)) {
    throw new StackResolveError("INVALID_RESPONSE", "The resolver returned an invalid response.", 502);
  }

  const plan = payload.plan;
  if (
    typeof plan.id !== "string" ||
    typeof plan.command !== "string" ||
    plan.command.length === 0 ||
    plan.command.length > 7_600 ||
    typeof plan.selectionCount !== "number" ||
    typeof plan.sourceCount !== "number" ||
    !isRecord(plan.runtime) ||
    typeof plan.runtime.package !== "string" ||
    typeof plan.runtime.minimumNodeVersion !== "string" ||
    !isRecord(plan.semantics) ||
    plan.semantics.atomic !== false ||
    plan.semantics.runtimeCompletenessVerified !== false ||
    plan.semantics.sourceRevisionEnforced !== false ||
    plan.semantics.pathScopeEnforced !== true ||
    plan.semantics.partialInstallPossible !== true ||
    plan.semantics.agentFailureMayExitZero !== true ||
    plan.semantics.mutableSourceRacePossible !== true ||
    !Array.isArray(plan.warnings) ||
    !plan.warnings.every((warning) => typeof warning === "string")
  ) {
    throw new StackResolveError("INVALID_RESPONSE", "The resolver returned an invalid plan.", 502);
  }

  const resolvedSkills = Array.isArray(plan.resolvedSkills)
    ? plan.resolvedSkills.filter((skill): skill is StackResolvedSkill => (
      isRecord(skill) &&
      typeof skill.id === "string" &&
      typeof skill.name === "string" &&
      typeof skill.source === "string" &&
      typeof skill.revision === "string" &&
      typeof skill.license === "string" &&
      isCompatibilityAdvisory(skill.compatibilityAdvisory) &&
      (skill.trust === "pass" || skill.trust === "warn")
    ))
    : undefined;

  return {
    id: plan.id,
    command: plan.command,
    selectionCount: plan.selectionCount,
    sourceCount: plan.sourceCount,
    runtime: {
      package: plan.runtime.package,
      minimumNodeVersion: plan.runtime.minimumNodeVersion,
    },
    semantics: {
      atomic: false,
      runtimeCompletenessVerified: false,
      sourceRevisionEnforced: false,
      pathScopeEnforced: true,
      partialInstallPossible: true,
      agentFailureMayExitZero: true,
      mutableSourceRacePossible: true,
    },
    warnings: [...plan.warnings],
    ...(resolvedSkills ? { resolvedSkills } : {}),
  };
}

export async function preflightStack(
  request: StackPreflightRequest,
  options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<StackPreflightSnapshot> {
  let response: Response;
  try {
    response = await fetch("/api/v1/stack/preflight", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      cache: "no-store",
      signal: options.signal,
    });
  } catch {
    throw new StackPreflightError(
      "NETWORK_ERROR",
      "Stack preflight could not be reached.",
      0,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) throw parsePreflightFailure(payload, response.status);
  return parsePreflight(payload as StackPreflightSuccess, request.selectionIds);
}

export async function resolveStack(
  request: StackResolveRequest,
  options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<StackResolvePlan> {
  let response: Response;
  try {
    response = await fetch("/api/v1/stack/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      cache: "no-store",
      signal: options.signal,
    });
  } catch {
    throw new StackResolveError("NETWORK_ERROR", "The stack resolver could not be reached.", 0);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) throw parseFailure(payload, response.status);
  return parsePlan(payload as StackResolveSuccess | StackResolveFailure);
}
