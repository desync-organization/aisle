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
