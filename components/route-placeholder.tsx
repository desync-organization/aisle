import { ArrowLeft, CircleDashed } from "lucide-react";
import type { ReactNode } from "react";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";

type RoutePlaceholderProps = {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
};

export function RoutePlaceholder({ children, description, eyebrow, title }: RoutePlaceholderProps) {
  return (
    <div className="site-frame">
      <SiteHeader />
      <main className="route-page shell">
        <Badge tone="iris">{eyebrow}</Badge>
        <h1>{title}</h1>
        <p className="route-page__lede">{description}</p>
        <div className="route-state">
          <CircleDashed aria-hidden="true" size={24} />
          <div>
            <strong>Foundation ready</strong>
            <p>Real catalog data and workflows will connect here without changing the shared shell.</p>
          </div>
        </div>
        {children}
        <ButtonLink href="/" variant="secondary">
          <ArrowLeft aria-hidden="true" size={16} /> Back to Aisle
        </ButtonLink>
      </main>
      <SiteFooter />
    </div>
  );
}
