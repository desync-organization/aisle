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

export type StackResolveRequest = Readonly<{
  selectionIds: ReadonlyArray<string>;
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

export class StackResolveError extends Error {
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
    this.name = "StackResolveError";
    this.code = code;
    this.status = status;
    this.fieldIssues = fieldIssues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFieldIssue(value: unknown): value is Readonly<{ path: string; message: string }> {
  return isRecord(value) && typeof value.path === "string" && typeof value.message === "string";
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
