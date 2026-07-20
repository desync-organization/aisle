import { z } from "zod";

export const SKILLS_CLI_PACKAGE = "skills@1.5.19" as const;
export const SKILLS_CLI_MINIMUM_NODE_VERSION = ">=22.20.0" as const;

export const MAX_SKILLS_PER_PLAN = 64;
export const MAX_SOURCES_PER_PLAN = 16;
export const MAX_AGENTS_PER_PLAN = 8;
export const MAX_PASTEABLE_COMMAND_LENGTH = 7_600;

/**
 * Agent identifiers accepted by the pinned skills@1.5.19 CLI.
 *
 * Keep this list tied to the pinned CLI release. A CLI upgrade must update this
 * contract and its tests in the same change.
 */
export const SUPPORTED_AGENTS = [
  "aider-desk",
  "amp",
  "antigravity",
  "antigravity-cli",
  "astrbot",
  "autohand-code",
  "augment",
  "bob",
  "claude-code",
  "openclaw",
  "cline",
  "codearts-agent",
  "codebuddy",
  "codemaker",
  "codestudio",
  "codex",
  "command-code",
  "continue",
  "cortex",
  "crush",
  "cursor",
  "deepagents",
  "devin",
  "dexto",
  "droid",
  "eve",
  "firebender",
  "forgecode",
  "gemini-cli",
  "github-copilot",
  "goose",
  "hermes-agent",
  "inference-sh",
  "iflow-cli",
  "jazz",
  "junie",
  "kilo",
  "kimi-code-cli",
  "kiro-cli",
  "kode",
  "lingma",
  "loaf",
  "mcpjam",
  "mistral-vibe",
  "moxby",
  "mux",
  "neovate",
  "opencode",
  "openhands",
  "ona",
  "pi",
  "qoder",
  "qoder-cn",
  "qwen-code",
  "replit",
  "reasonix",
  "roo",
  "rovodev",
  "tabnine-cli",
  "terramind",
  "tinycloud",
  "trae",
  "trae-cn",
  "warp",
  "windsurf",
  "zed",
  "zcode",
  "zencoder",
  "zenflow",
  "pochi",
  "promptscript",
  "adal",
  "universal",
] as const;

export const GLOBAL_UNSUPPORTED_AGENTS = ["eve", "promptscript"] as const;

export const agentSchema = z.enum(SUPPORTED_AGENTS);
export const installScopeSchema = z.enum(["project", "global"]);
export const installModeSchema = z.enum(["copy", "symlink"]);
export const installShellSchema = z.enum([
  "posix",
  "powershell7",
  "powershell51",
  "cmd",
]);

const catalogIdentifierSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/,
    "must be a bounded ASCII catalog identifier",
  );

const githubOwnerSchema = z
  .string()
  .min(1)
  .max(39)
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/,
    "must be a GitHub owner login",
  );

const githubRepositorySchema = z
  .string()
  .min(1)
  .max(100)
  .regex(
    /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/,
    "must be a GitHub repository name",
  );

const skillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "must follow the public Agent Skills name contract",
  );

const spdxExpressionSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(
    /^[A-Za-z0-9.+() -]+$/,
    "must be a bounded ASCII SPDX expression",
  );

const uniqueAgentListSchema = z
  .array(agentSchema)
  .min(1)
  .max(SUPPORTED_AGENTS.length)
  .superRefine((agents, context) => {
    const seen = new Set<string>();
    agents.forEach((agent, index) => {
      if (seen.has(agent)) {
        context.addIssue({
          code: "custom",
          message: `duplicate agent: ${agent}`,
          path: [index],
        });
      }
      seen.add(agent);
    });
  });

export const resolvedGithubSkillSchema = z.strictObject({
  canonicalSkillId: catalogIdentifierSchema,
  revisionId: catalogIdentifierSchema,
  name: skillNameSchema,
  normalizedName: skillNameSchema,
  source: z.strictObject({
    kind: z.literal("github"),
    owner: githubOwnerSchema,
    repository: githubRepositorySchema,
  }),
  publication: z.enum(["public", "private", "unknown"]),
  availability: z.enum(["current", "withdrawn", "superseded"]),
  license: z.strictObject({
    status: z.enum(["verified", "missing", "unknown", "custom"]),
    expression: spdxExpressionSchema.nullable(),
  }),
  trust: z.strictObject({
    validation: z.enum(["passed", "failed", "pending"]),
    blocked: z.boolean(),
    quarantined: z.boolean(),
  }),
  compatibleAgents: uniqueAgentListSchema,
  observed: z.strictObject({
    commitSha: z.string().regex(/^[0-9a-f]{40}$/, "must be a lowercase Git commit SHA"),
    contentDigest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/, "must be a sha256 content digest"),
  }),
  installer: z.strictObject({
    selector: skillNameSchema,
    selectorVerifiedUnique: z.boolean(),
    verifiedAtCommitSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/, "must be a lowercase Git commit SHA"),
  }),
});

export const installPlanOptionsSchema = z.strictObject({
  agents: uniqueAgentListSchema.max(MAX_AGENTS_PER_PLAN),
  scope: installScopeSchema,
  mode: installModeSchema,
  shell: installShellSchema,
});

export const installPlanRequestSchema = z.strictObject({
  selections: z.array(resolvedGithubSkillSchema),
  options: installPlanOptionsSchema,
});

export type SupportedAgent = z.infer<typeof agentSchema>;
export type InstallScope = z.infer<typeof installScopeSchema>;
export type InstallMode = z.infer<typeof installModeSchema>;
export type InstallShell = z.infer<typeof installShellSchema>;
export type ResolvedGithubSkill = z.infer<typeof resolvedGithubSkillSchema>;
export type InstallPlanOptions = z.infer<typeof installPlanOptionsSchema>;
export type InstallPlanRequest = z.infer<typeof installPlanRequestSchema>;

export const installPlanErrorCodeSchema = z.enum([
  "INVALID_INPUT",
  "EMPTY_SELECTION",
  "SELECTION_LIMIT_EXCEEDED",
  "SOURCE_LIMIT_EXCEEDED",
  "NOT_PUBLIC",
  "NOT_CURRENT",
  "BLOCKED",
  "QUARANTINED",
  "VALIDATION_REQUIRED",
  "UNLICENSED",
  "SELECTOR_NOT_UNIQUE",
  "SELECTOR_EVIDENCE_MISMATCH",
  "INCOMPATIBLE_AGENT",
  "UNSUPPORTED_GLOBAL_SCOPE",
  "DUPLICATE_SELECTION",
  "CONFLICTING_REVISION",
  "NORMALIZED_NAME_CONFLICT",
  "COMMAND_TOO_LONG",
]);

export type InstallPlanErrorCode = z.infer<typeof installPlanErrorCodeSchema>;

export type InstallPlanFieldIssue = Readonly<{
  path: string;
  message: string;
}>;

export class InstallPlanError extends Error {
  readonly code: InstallPlanErrorCode;
  readonly fieldIssues: readonly InstallPlanFieldIssue[];

  constructor(
    code: InstallPlanErrorCode,
    message: string,
    fieldIssues: readonly InstallPlanFieldIssue[] = [],
  ) {
    super(message);
    this.name = "InstallPlanError";
    this.code = code;
    this.fieldIssues = fieldIssues;
  }
}
