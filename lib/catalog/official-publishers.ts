import { normalizeSourceUrl } from "./normalization";
import type { DiscoveredSkillRecord } from "./source-contract";

/**
 * Repository-scoped publisher identities reviewed for Aisle's launch
 * packages. This is an identity assertion only; trust, license, and revision
 * eligibility remain independent fail-closed checks.
 */
const verifiedOfficialGithubRepositories = new Set([
  "anthropics/skills",
  "cloudflare/security-audit-skill",
  "cloudflare/skills",
  "expo/skills",
  "firebase/agent-skills",
  "heygen-com/hyperframes",
  "huggingface/skills",
  "microsoft/azure-skills",
  "microsoft/playwright-cli",
  "neondatabase/agent-skills",
  "obra/superpowers",
  "pbakaus/impeccable",
  "shadcn-ui/ui",
  "supabase/agent-skills",
  "vercel-labs/agent-browser",
]);

export function isVerifiedOfficialPublisher(record: DiscoveredSkillRecord): boolean {
  const repository = record.repository;
  if (
    record.provider.toLowerCase() !== "github" ||
    repository?.provider.toLowerCase() !== "github" ||
    !repository.owner ||
    !repository.name ||
    repository.visibility !== "public"
  ) {
    return false;
  }
  const coordinate = `${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}`;
  if (!verifiedOfficialGithubRepositories.has(coordinate)) return false;
  return (
    normalizeSourceUrl(record.sourceUrl) === normalizeSourceUrl(repository.url) &&
    normalizeSourceUrl(repository.url) === `https://github.com/${coordinate}`
  );
}
