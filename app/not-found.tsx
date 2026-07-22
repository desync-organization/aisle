import { CornerDownLeft } from "lucide-react";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { ButtonLink } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="site-frame">
      <SiteHeader />
      <main className="route-page shell">
        <span className="eyebrow">404</span>
        <h1>Page not found.</h1>
        <p className="route-page__lede">
          The link may be old, or the page may have moved.
        </p>
        <ButtonLink href="/">
          <CornerDownLeft aria-hidden="true" size={16} /> Return home
        </ButtonLink>
      </main>
      <SiteFooter />
    </div>
  );
}
