import { createHash } from "node:crypto";

import { parseDocument } from "yaml";
import { z } from "zod";

import {
  computeArtifactContentHash,
  isExecutableRegularFileMode,
  normalizeArtifactFilePath,
} from "./artifact-fingerprint";
import type {
  DiscoveryRecordValidator,
  DiscoveryValidationResult,
  TrustFindingInput,
} from "./ingestion";
import type { DiscoveredSkillRecord } from "./source-contract";

export const AISLE_SCANNER = "aisle-static";
export const AISLE_SCANNER_VERSION = "1.0.0";

const metadataSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^(?!-)(?!.*--)[a-z0-9-]+(?<!-)$/),
    description: z.string().min(1).max(1_024),
    license: z.string().min(1).max(256).optional(),
    compatibility: z.string().min(1).max(500).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    "allowed-tools": z.string().min(1).max(2_048).optional(),
  })
  .passthrough();

export interface AgentSkillMetadata {
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  allowedTools: string | null;
  raw: Record<string, unknown>;
}

export class AgentSkillMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentSkillMetadataError";
  }
}

export function parseAgentSkillMetadata(contents: string): AgentSkillMetadata {
  const normalized = contents.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) {
    throw new AgentSkillMetadataError("SKILL.md must begin with YAML frontmatter");
  }
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing === -1) {
    throw new AgentSkillMetadataError("SKILL.md frontmatter is not terminated");
  }
  const frontmatter = normalized.slice(4, closing);
  const document = parseDocument(frontmatter, {
    uniqueKeys: true,
  });
  if (document.errors.length) {
    throw new AgentSkillMetadataError(`Invalid YAML: ${document.errors[0]!.message}`);
  }
  const decoded = metadataSchema.safeParse(document.toJS({ maxAliasCount: 0 }));
  if (!decoded.success) {
    throw new AgentSkillMetadataError(
      `Invalid Agent Skills metadata: ${decoded.error.issues[0]?.message ?? "unknown error"}`,
    );
  }
  return {
    name: decoded.data.name,
    description: decoded.data.description,
    license: decoded.data.license ?? null,
    compatibility: decoded.data.compatibility ?? null,
    allowedTools: decoded.data["allowed-tools"] ?? null,
    raw: decoded.data,
  };
}

const SPDX_ALIASES = new Map<string, string>([
  ["mit", "MIT"],
  ["apache-2.0", "Apache-2.0"],
  ["apache 2.0", "Apache-2.0"],
  ["apache license 2.0", "Apache-2.0"],
  ["bsd-2-clause", "BSD-2-Clause"],
  ["bsd-3-clause", "BSD-3-Clause"],
  ["isc", "ISC"],
  ["0bsd", "0BSD"],
  ["mpl-2.0", "MPL-2.0"],
  ["cc0-1.0", "CC0-1.0"],
  ["unlicense", "Unlicense"],
  ["gpl-3.0-only", "GPL-3.0-only"],
  ["gpl-3.0-or-later", "GPL-3.0-or-later"],
]);

const LICENSE_TEXT_HASHES = new Map<string, string>([
  ["c963879647034d6c5d7027d8e2b024213589b749d11ba7320032802307bced9c", "MIT"],
  ["59d8f0ba87ad9a2f1a431123c8d16646e5b89ba53653e818f16d136d77263c99", "Apache-2.0"],
]);

function normalizeSpdx(value: string | null | undefined): string | null {
  return value ? SPDX_ALIASES.get(value.trim().toLowerCase()) ?? null : null;
}

function normalizedLicenseTextHash(contents: string): string {
  const apacheMarker = "END OF TERMS AND CONDITIONS";
  const apacheEnd = contents.indexOf(apacheMarker);
  const fingerprintedContents = apacheEnd >= 0
    ? contents.slice(0, apacheEnd + apacheMarker.length)
    : contents;
  const normalized = fingerprintedContents
    .replace(
      /Copyright \(c\).*?(?=Permission is hereby granted)/is,
      "Copyright (c) <year> <copyright holders> ",
    )
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(normalized).digest("hex");
}

function resolveLicense(
  record: DiscoveredSkillRecord,
  metadata: AgentSkillMetadata,
): {
  spdx: string;
  evidence: {
    path: string;
    sha256: string;
    source: string;
    sourceUrl?: string;
    immutableRef?: string;
  } | null;
} {
  const explicit = normalizeSpdx(metadata.license);
  if (explicit) {
    const manifest = record.artifact?.textFiles?.find(
      (file) => file.path === "SKILL.md" || file.path.endsWith("/SKILL.md"),
    );
    return {
      spdx: explicit,
      evidence: {
        path: manifest?.path ?? "SKILL.md",
        sha256: manifest?.sha256 ?? "",
        source: "frontmatter-spdx",
      },
    };
  }
  const referencedPath = metadata.license?.match(/(?:in|at)\s+([^\s]+license[^\s]*)/i)?.[1]
    ?.replace(/["'`.,;:]+$/g, "")
    .replaceAll("\\", "/");
  const candidates = (record.artifact?.textFiles ?? []).filter((file) => {
    const basename = file.path.split("/").at(-1) ?? "";
    return (
      /^(?:license|licence|copying)(?:\.[a-z0-9]+)?$/i.test(basename) ||
      (referencedPath ? file.path.endsWith(referencedPath) : false)
    );
  });
  for (const file of candidates) {
    const spdx = LICENSE_TEXT_HASHES.get(normalizedLicenseTextHash(file.contents));
    if (spdx) {
      return {
        spdx,
        evidence: { path: file.path, sha256: file.sha256, source: "license-text-fingerprint" },
      };
    }
  }
  const repositoryEvidence = record.repositoryLicenseEvidence;
  if (
    repositoryEvidence &&
    record.repository?.provider.toLowerCase() === "github" &&
    repositoryEvidence.immutableRef === record.immutableRef &&
    repositoryEvidence.sourceUrl === record.repository.url &&
    repositoryEvidence.sourceUrl === record.sourceUrl
  ) {
    let evidencePath: string | null = null;
    try {
      evidencePath = normalizeArtifactFilePath(repositoryEvidence.path);
    } catch {
      // Invalid external evidence is ignored and cannot make a revision selectable.
    }
    const digest = createHash("sha256").update(repositoryEvidence.contents).digest("hex");
    const spdx = LICENSE_TEXT_HASHES.get(
      normalizedLicenseTextHash(repositoryEvidence.contents),
    );
    if (
      evidencePath &&
      !evidencePath.includes("/") &&
      /^(?:license|licence|copying)(?:\.[a-z0-9]+)?$/i.test(evidencePath) &&
      digest === repositoryEvidence.sha256.toLowerCase() &&
      spdx
    ) {
      return {
        spdx,
        evidence: {
          path: evidencePath,
          sha256: digest,
          source: "repository-root-license-text",
          sourceUrl: repositoryEvidence.sourceUrl,
          immutableRef: repositoryEvidence.immutableRef,
        },
      };
    }
  }
  return { spdx: "unknown", evidence: null };
}

function finding(
  code: string,
  severity: TrustFindingInput["severity"],
  message: string,
  path: string | null = null,
  evidence: string | null = null,
): TrustFindingInput {
  return { code, severity, message, path, evidence };
}

function hasTraversal(path: string): boolean {
  let normalized = path.replaceAll("\\", "/");
  for (let index = 0; index < 3; index += 1) {
    try {
      const decoded = decodeURIComponent(normalized);
      if (decoded === normalized) break;
      normalized = decoded.replaceAll("\\", "/");
    } catch {
      return true;
    }
  }
  return (
    /[\u0000-\u001f\u007f]/.test(normalized) ||
    normalized.startsWith("/") ||
    /^[a-z]:/i.test(normalized) ||
    normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  );
}

function scanText(path: string, contents: string): TrustFindingInput[] {
  const findings: TrustFindingInput[] = [];
  const secretPatterns: Array<[string, RegExp]> = [
    ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
    ["GitHub token", /\bgh[psoru]_[A-Za-z0-9_]{30,}\b/],
    ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ["credential assignment", /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"'\n]{12,}["']/i],
  ];
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(contents)) {
      const placeholder = /(?:placeholder|example|your[_-]?(?:api[_-]?)?(?:key|token|secret)|change[_-]?me)/i.test(
        contents,
      );
      findings.push(
        finding(
          placeholder ? "SECRET_PLACEHOLDER" : "EMBEDDED_SECRET",
          placeholder ? "warning" : "critical",
          `Detected a possible embedded ${label}${placeholder ? " placeholder" : ""}.`,
          path,
        ),
      );
    }
  }
  const downloadExecute = [
    /\b(?:curl|wget)\b[^\n|]{0,500}\|\s*(?:sudo\s+)?(?:ba)?sh\b/i,
    /\bInvoke-(?:WebRequest|RestMethod)\b[^\n]{0,500}\|\s*Invoke-Expression\b/i,
    /\beval\s+["']?\$\([^\n]*(?:curl|wget)\b/i,
    /<(?:\s*)\((?:\s*)(?:curl|wget)\b/i,
    /\b(?:curl|wget)\b[\s\S]{0,800}(?:chmod\s+\+x|chmod\s+7\d\d)[\s\S]{0,400}(?:\.\/|\/(?:tmp|var\/tmp)\/|bash\s+|sh\s+)/i,
    /\b(?:iwr|Invoke-WebRequest|Invoke-RestMethod)\b[\s\S]{0,500}(?:\||\))\s*(?:iex|Invoke-Expression)\b/i,
  ];
  if (downloadExecute.some((pattern) => pattern.test(contents))) {
    findings.push(
      finding(
        "DOWNLOAD_AND_EXECUTE",
        "critical",
        "Detected a download-and-execute instruction that bypasses review of fetched code.",
        path,
      ),
    );
  }
  if (/\b(?:sudo\s+|chmod\s+777|rm\s+-rf|reg\s+add|Set-ExecutionPolicy\s+Unrestricted)\b/i.test(contents)) {
    findings.push(
      finding(
        "DANGEROUS_PERMISSION_REQUEST",
        "warning",
        "Detected instructions requesting elevated or broadly destructive permissions.",
        path,
      ),
    );
  }
  return findings;
}

function validateInstallBinding(record: DiscoveredSkillRecord): string | null {
  const spec = record.installSpec;
  if (!spec || !record.immutableRef || !record.contentHash) {
    return "A pinned install specification, immutable reference, and content hash are required";
  }
  const normalizedHash = record.contentHash.toLowerCase().replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(normalizedHash)) {
    return "Content hash must be an exact 64-character SHA-256 value";
  }
  if (spec.kind === "source") {
    if (
      new URL(spec.sourceUrl).toString().replace(/\/$/, "") !==
        new URL(record.sourceUrl).toString().replace(/\/$/, "") ||
      spec.immutableRef !== record.immutableRef ||
      spec.skillPath.replaceAll("\\", "/").replace(/\/$/, "") !==
        record.skillPath.replaceAll("\\", "/").replace(/\/$/, "")
    ) {
      return "Source install specification does not match source URL, ref, and skill path";
    }
    if (!/^[a-f0-9]{40,64}$/i.test(spec.immutableRef)) {
      return "Source installs require a pinned commit-like immutable reference";
    }
    return null;
  }
  if (
    spec.version !== record.immutableRef ||
    !(
      spec.registry === "skills.sh" ||
      spec.registry === "clawhub" ||
      spec.registry.startsWith("well-known:")
    )
  ) {
    return "Registry install specification is not bound to an approved registry and exact version";
  }
  if (
    (spec.registry === "skills.sh" || spec.registry === "clawhub") &&
    spec.identifier !== record.sourceRecordId
  ) {
    return "Registry identity does not match the stable source record identity";
  }
  return null;
}

function upstreamPolicyFindings(record: DiscoveredSkillRecord): {
  findings: TrustFindingInput[];
  upstreamAudits: DiscoveryValidationResult["upstreamAudits"];
} {
  if (record.provider !== "clawhub") return { findings: [], upstreamAudits: [] };
  const raw = record.raw as {
    verification?: { ok?: unknown; decision?: unknown } | null;
    scan?: {
      security?: { status?: unknown } | null;
      moderation?: { isSuspicious?: unknown; isMalwareBlocked?: unknown } | null;
    } | null;
    moderation?: { isSuspicious?: unknown; isMalwareBlocked?: unknown } | null;
    version?: { security?: { status?: unknown } | null } | null;
  };
  const decision = typeof raw.verification?.decision === "string" ? raw.verification.decision : null;
  const ok = typeof raw.verification?.ok === "boolean" ? raw.verification.ok : null;
  const securityStatus =
    typeof raw.scan?.security?.status === "string"
      ? raw.scan.security.status
      : typeof raw.version?.security?.status === "string"
        ? raw.version.security.status
        : null;
  const suspicious =
    raw.scan?.moderation?.isSuspicious === true ||
    raw.moderation?.isSuspicious === true ||
    raw.scan?.moderation?.isMalwareBlocked === true ||
    raw.moderation?.isMalwareBlocked === true;
  const explicitPass =
    ok === true &&
    ["pass", "allow"].includes(decision?.toLowerCase() ?? "") &&
    securityStatus?.toLowerCase() === "clean" &&
    !suspicious;
  const upstreamAudits = decision || securityStatus
    ? [
        {
          provider: "ClawHub",
          providerSlug: "clawhub-exact-version",
          status: explicitPass ? ("pass" as const) : ("fail" as const),
          summary: `Exact-version verification decision=${decision ?? "unavailable"}; security=${securityStatus ?? "unavailable"}; moderationSuspicious=${suspicious}.`,
          scannerVersion: null,
          raw: { decision, ok, securityStatus },
        },
      ]
    : [];
  const blocked = !explicitPass;
  return {
    findings: blocked
      ? [
          finding(
            "UPSTREAM_EXACT_VERSION_BLOCK",
            "critical",
            "Aisle policy quarantined this revision because ClawHub exact-version verification did not pass.",
          ),
        ]
      : [],
    upstreamAudits,
  };
}

export function validateAgentSkillRecord(record: DiscoveredSkillRecord): DiscoveryValidationResult {
  const installBindingError = validateInstallBinding(record);
  if (installBindingError) {
    return { valid: false, metadata: null, reason: installBindingError };
  }
  const artifact = record.artifact;
  if (!artifact || artifact.type !== "skill-md" || !artifact.contents) {
    return { valid: false, metadata: null, reason: "No bounded SKILL.md artifact was available" };
  }
  let metadata: AgentSkillMetadata;
  try {
    metadata = parseAgentSkillMetadata(artifact.contents);
  } catch (error) {
    return {
      valid: false,
      metadata: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!artifact.complete) {
    return {
      valid: false,
      metadata: null,
      reason: "The exact-version textual artifact set was incomplete",
    };
  }

  const findings: TrustFindingInput[] = [];
  const directoryName = record.skillPath.replaceAll("\\", "/").split("/").filter(Boolean).at(-1);
  const containingDirectoryName =
    directoryName === "." ? record.repository?.name ?? null : directoryName ?? null;
  if (directoryName === "." && !containingDirectoryName) {
    return {
      valid: false,
      metadata: null,
      reason: "Repository-root SKILL.md requires an authoritative repository directory name",
    };
  }
  if (containingDirectoryName && containingDirectoryName !== metadata.name) {
    return {
      valid: false,
      metadata: null,
      reason: "Frontmatter name must match the containing skill directory",
    };
  }
  const artifactInventoryPaths = new Set<string>();
  const verifiedInventory = new Map<
    string,
    { sha256: string; size: number; type: string }
  >();
  for (const file of artifact.files ?? []) {
    let normalizedPath: string | null = null;
    try {
      normalizedPath = normalizeArtifactFilePath(file.path);
    } catch {
      // Unsafe paths are retained as critical findings so the exact reason is explainable.
    }
    if (normalizedPath && artifactInventoryPaths.has(normalizedPath)) {
      return {
        valid: false,
        metadata: null,
        reason: `Artifact inventory contains duplicate path ${normalizedPath}`,
      };
    }
    if (normalizedPath) artifactInventoryPaths.add(normalizedPath);
    const sha256 = file.sha?.toLowerCase().replace(/^sha256:/, "") ?? "";
    if (
      normalizedPath &&
      (!Number.isSafeInteger(file.size) || file.size! < 0 || !/^[a-f0-9]{64}$/.test(sha256))
    ) {
      return {
        valid: false,
        metadata: null,
        reason: `Artifact inventory digest or size is unverified for ${normalizedPath}`,
      };
    }
    if (normalizedPath) {
      verifiedInventory.set(normalizedPath, {
        sha256,
        size: file.size!,
        type: file.type.toLowerCase(),
      });
    }
    if (hasTraversal(file.path)) {
      findings.push(
        finding("TRAVERSAL_PATH", "critical", "Artifact inventory contains an unsafe path.", file.path),
      );
    }
    if (file.mode === "120000" || file.type.toLowerCase() === "symlink") {
      findings.push(
        finding("SYMLINK", "critical", "Artifact inventory contains a symlink.", file.path),
      );
    }
    if (file.mode === "160000" || file.type.toLowerCase() === "commit") {
      findings.push(
        finding("SUBMODULE", "critical", "Artifact inventory contains a Git submodule.", file.path),
      );
    }
    if (isExecutableRegularFileMode(file.mode ?? "")) {
      findings.push(
        finding("EXECUTABLE_MODE", "warning", "Artifact inventory contains an executable file mode.", file.path),
      );
    }
    if (file.type.toLowerCase() === "binary") {
      findings.push(
        finding("UNEXPECTED_BINARY", "warning", "Artifact inventory identifies binary content.", file.path),
      );
    }
    if (/\.(?:exe|dll|dylib|so|bin|com|msi|apk|class|jar)$/i.test(file.path)) {
      findings.push(
        finding("UNEXPECTED_BINARY", "warning", "Artifact inventory contains an executable binary.", file.path),
      );
    }
  }
  const scannedTextFiles = artifact.textFiles?.length
    ? artifact.textFiles
    : [
        {
          path: "SKILL.md",
          contents: artifact.contents,
          sha256: createHash("sha256").update(artifact.contents).digest("hex"),
        },
      ];
  for (const file of scannedTextFiles) findings.push(...scanText(file.path, file.contents));
  const scannedTextPaths = new Set<string>();
  for (const file of scannedTextFiles) {
    const digest = createHash("sha256").update(file.contents).digest("hex");
    if (!/^[a-f0-9]{64}$/i.test(file.sha256) || digest !== file.sha256.toLowerCase()) {
      return {
        valid: false,
        metadata: null,
        reason: `${file.path} did not match its advertised SHA-256`,
      };
    }
    let normalizedPath: string;
    try {
      normalizedPath = normalizeArtifactFilePath(file.path);
    } catch (error) {
      return {
        valid: false,
        metadata: null,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (scannedTextPaths.has(normalizedPath)) {
      return {
        valid: false,
        metadata: null,
        reason: `Scanned text inventory contains duplicate path ${normalizedPath}`,
      };
    }
    scannedTextPaths.add(normalizedPath);
    const inventory = verifiedInventory.get(normalizedPath);
    if (
      !inventory ||
      inventory.sha256 !== digest ||
      inventory.size !== new TextEncoder().encode(file.contents).byteLength
    ) {
      return {
        valid: false,
        metadata: null,
        reason: `${file.path} was not bound to the verified installed-file inventory`,
      };
    }
    if (/\u0000|^\s*(?:MZ|\x7fELF|PK\u0003\u0004)/.test(file.contents)) {
      findings.push(
        finding(
          "DISGUISED_BINARY",
          "critical",
          "A scanned text path contains a binary signature or NUL byte.",
          file.path,
        ),
      );
    }
  }
  let artifactFingerprint: string;
  try {
    artifactFingerprint = computeArtifactContentHash(artifact.files ?? []);
  } catch (error) {
    return {
      valid: false,
      metadata: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (artifactFingerprint !== record.contentHash?.toLowerCase().replace(/^sha256:/, "")) {
    return {
      valid: false,
      metadata: null,
      reason: "Content hash was not bound to the exact scanned artifact inventory",
    };
  }
  const manifestText = scannedTextFiles.find(
    (file) => file.path === "SKILL.md" || file.path.endsWith("/SKILL.md"),
  );
  if (!manifestText || manifestText.contents !== artifact.contents) {
    return { valid: false, metadata: null, reason: "Scanned SKILL.md did not match the manifest" };
  }
  if (
    metadata.allowedTools &&
    /(?:^|[,\s])(?:Bash|Shell|PowerShell)(?:\s*\(\s*\*\s*\))?(?:$|[,\s])|(?:^|[,\s])\*(?:$|[,\s])|\b(?:computer-use|filesystem:\*)\b/i.test(
      metadata.allowedTools,
    )
  ) {
    findings.push(
      finding(
        "BROAD_TOOL_PERMISSION",
        "warning",
        "Metadata requests a broad shell, computer-use, or filesystem permission.",
        "SKILL.md",
        metadata.allowedTools,
      ),
    );
  }
  const upstream = upstreamPolicyFindings(record);
  findings.push(...upstream.findings);
  const critical = findings.some((entry) => entry.severity === "critical");
  const warning = findings.some((entry) => entry.severity === "warning");
  const license = resolveLicense(record, metadata);
  return {
    valid: true,
    metadata: {
      name: metadata.name,
      description: metadata.description,
      compatibility: metadata.compatibility,
      license: license.spdx,
      licenseEvidence: license.evidence,
    },
    trustAssessment: {
      scanner: AISLE_SCANNER,
      scannerVersion: AISLE_SCANNER_VERSION,
      state: critical ? "quarantined" : warning ? "warn" : "pass",
      quarantineReason: critical ? "Critical static or exact-version policy finding" : null,
      findings,
    },
    upstreamAudits: upstream.upstreamAudits,
  };
}

export function createAgentSkillValidator(): DiscoveryRecordValidator {
  return async (record) => validateAgentSkillRecord(record);
}
