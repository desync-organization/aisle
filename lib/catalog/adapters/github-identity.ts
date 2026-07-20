import { RegistryContractError } from "./http-transport";

const OWNER_PATTERN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;
const REPOSITORY_PATTERN = /^[a-z\d_.-]{1,100}$/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export interface GitHubSkillIdentity {
  owner: string;
  repository: string;
  repositoryFullName: string;
  repositoryUrl: string;
  directoryPath: string;
  skillFilePath: string;
  canonicalKey: string;
}

function validateOwner(owner: string): string {
  const trimmed = owner.trim();
  if (!OWNER_PATTERN.test(trimmed)) {
    throw new RegistryContractError("Registry record contains an invalid GitHub owner");
  }
  return trimmed;
}

function validateRepository(repository: string): string {
  const trimmed = repository.trim();
  if (
    !REPOSITORY_PATTERN.test(trimmed) ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.endsWith(".git")
  ) {
    throw new RegistryContractError("Registry record contains an invalid GitHub repository name");
  }
  return trimmed;
}

function validateRelativePath(path: string): string {
  const trimmed = path.trim();
  if (
    !trimmed ||
    trimmed.length > 2_048 ||
    trimmed.startsWith("/") ||
    trimmed.endsWith("/") ||
    trimmed.includes("\\") ||
    CONTROL_CHARACTER_PATTERN.test(trimmed)
  ) {
    throw new RegistryContractError("Registry record contains an invalid skill path");
  }

  const segments = trimmed.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new RegistryContractError("Registry record contains an unsafe skill path");
  }
  return segments.join("/");
}

function parseRepositoryFullName(value: string): { owner: string; repository: string } {
  const segments = value.trim().split("/");
  if (segments.length !== 2) {
    throw new RegistryContractError("Registry record contains an invalid GitHub repository identity");
  }
  return {
    owner: validateOwner(segments[0] ?? ""),
    repository: validateRepository(segments[1] ?? ""),
  };
}

function validateRepositoryUrl(
  value: string | undefined,
  owner: string,
  repository: string,
): void {
  if (value === undefined) {
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new RegistryContractError("Registry record contains an invalid GitHub URL", error);
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== "github.com" ||
    parsed.username ||
    parsed.password ||
    segments[0]?.toLowerCase() !== owner.toLowerCase() ||
    segments[1]?.replace(/\.git$/i, "").toLowerCase() !== repository.toLowerCase()
  ) {
    throw new RegistryContractError("Registry GitHub URL does not match its repository identity");
  }
}

export function normalizeGitHubSkillIdentity(input: {
  owner: string;
  repository: string;
  path: string;
  pathIncludesSkillFile: boolean;
  repositoryUrlObservation?: string;
}): GitHubSkillIdentity {
  const owner = validateOwner(input.owner);
  const repository = validateRepository(input.repository);
  const normalizedPath =
    !input.pathIncludesSkillFile && input.path.trim() === "."
      ? "."
      : validateRelativePath(input.path);
  const skillFilePath = input.pathIncludesSkillFile
    ? normalizedPath
    : normalizedPath === "."
      ? "SKILL.md"
      : `${normalizedPath}/SKILL.md`;

  if (!skillFilePath.endsWith("/SKILL.md") && skillFilePath !== "SKILL.md") {
    throw new RegistryContractError("Registry skill path must identify a SKILL.md file");
  }

  const directoryPath =
    skillFilePath === "SKILL.md" ? "." : skillFilePath.slice(0, -"/SKILL.md".length);
  validateRepositoryUrl(input.repositoryUrlObservation, owner, repository);

  return {
    owner,
    repository,
    repositoryFullName: `${owner}/${repository}`,
    repositoryUrl: `https://github.com/${owner}/${repository}`,
    directoryPath,
    skillFilePath,
    canonicalKey: `github:${owner.toLowerCase()}/${repository.toLowerCase()}/${skillFilePath}`,
  };
}

export function identityFromRepositoryFullName(input: {
  repositoryFullName: string;
  path: string;
  pathIncludesSkillFile: boolean;
  repositoryUrlObservation?: string;
}): GitHubSkillIdentity {
  const repository = parseRepositoryFullName(input.repositoryFullName);
  return normalizeGitHubSkillIdentity({
    ...repository,
    path: input.path,
    pathIncludesSkillFile: input.pathIncludesSkillFile,
    repositoryUrlObservation: input.repositoryUrlObservation,
  });
}

export function githubBranchHint(repositoryUrl: string, explicitBranch?: string): string | null {
  const candidate = explicitBranch?.trim();
  if (candidate) {
    return candidate.length <= 255 && !CONTROL_CHARACTER_PATTERN.test(candidate) ? candidate : null;
  }

  const parsed = new URL(repositoryUrl);
  const segments = parsed.pathname.split("/").filter(Boolean);
  if ((segments[2] === "tree" || segments[2] === "blob") && segments[3]) {
    return decodeURIComponent(segments[3]).slice(0, 255);
  }
  return null;
}
