import {
  Braces,
  CheckCircle2,
  Database,
  Network,
  Orbit,
  Rocket,
  ShieldCheck,
  Smartphone,
  type LucideIcon,
} from "lucide-react";

const icons: Record<string, LucideIcon> = {
  brackets: Braces,
  orbit: Orbit,
  rocket: Rocket,
  shield: ShieldCheck,
  "device-mobile": Smartphone,
  database: Database,
  network: Network,
  "check-circle": CheckCircle2,
};

export function CategoryIcon({ size = 20, token }: { size?: number; token: string }) {
  const Icon = icons[token] ?? Braces;
  return <Icon aria-hidden="true" size={size} />;
}
