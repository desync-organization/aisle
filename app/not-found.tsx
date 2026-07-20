import { CornerDownLeft } from "lucide-react";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { ButtonLink } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="site-frame">
      <SiteHeader />
      <main className="route-page shell">
        <span className="eyebrow">404 · End of aisle</span>
        <h1>There’s nothing stocked at this address.</h1>
        <p className="route-page__lede">
          The page may have moved, or the public catalog has not connected it yet.
        </p>
        <ButtonLink href="/">
          <CornerDownLeft aria-hidden="true" size={16} /> Return home
        </ButtonLink>
      </main>
      <SiteFooter />
    </div>
  );
}
