export type PublicGitHubRepositoryDiscoverySeed = Readonly<{
  owner: string;
  repository: string;
  repositoryUrl: `https://github.com/${string}/${string}`;
}>;

export type PublicGitHubRepositoryUrl =
  PublicGitHubRepositoryDiscoverySeed["repositoryUrl"];

/**
 * Repositories nominated by the public-catalog research in issue #17.
 * A seed is only a discovery input; the GitHub connector independently proves
 * public visibility, paths, revisions, licensing, validation, and trust.
 */
export const defaultPublicGitHubRepositorySeeds = [
  {
    owner: "google",
    repository: "skills",
    repositoryUrl: "https://github.com/google/skills",
  },
  {
    owner: "addyosmani",
    repository: "agent-skills",
    repositoryUrl: "https://github.com/addyosmani/agent-skills",
  },
  {
    owner: "BuilderIO",
    repository: "skills",
    repositoryUrl: "https://github.com/BuilderIO/skills",
  },
  {
    owner: "antfu",
    repository: "skills",
    repositoryUrl: "https://github.com/antfu/skills",
  },
  {
    owner: "openai",
    repository: "skills",
    repositoryUrl: "https://github.com/openai/skills",
  },
  {
    owner: "NVIDIA",
    repository: "skills",
    repositoryUrl: "https://github.com/NVIDIA/skills",
  },
  {
    owner: "microsoft",
    repository: "skills",
    repositoryUrl: "https://github.com/microsoft/skills",
  },
  {
    owner: "MicrosoftDocs",
    repository: "Agent-Skills",
    repositoryUrl: "https://github.com/MicrosoftDocs/Agent-Skills",
  },
  {
    owner: "github",
    repository: "awesome-copilot",
    repositoryUrl: "https://github.com/github/awesome-copilot",
  },
  {
    owner: "googleworkspace",
    repository: "cli",
    repositoryUrl: "https://github.com/googleworkspace/cli",
  },
  {
    owner: "vercel-labs",
    repository: "agent-skills",
    repositoryUrl: "https://github.com/vercel-labs/agent-skills",
  },
] as const satisfies readonly PublicGitHubRepositoryDiscoverySeed[];

export const defaultPublicGitHubRepositoryUrls: readonly PublicGitHubRepositoryUrl[] =
  defaultPublicGitHubRepositorySeeds.map(({ repositoryUrl }) => repositoryUrl);

/**
 * Very large repositories are hydrated only for manifest paths already
 * nominated by a public registry. This avoids rejecting the entire repository
 * while keeping every remote request bounded and useful.
 */
export const targetedPublicGitHubRepositorySeeds = [
  {
    owner: "alirezarezvani",
    repository: "claude-skills",
    repositoryUrl: "https://github.com/alirezarezvani/claude-skills",
  },
] as const satisfies readonly PublicGitHubRepositoryDiscoverySeed[];
