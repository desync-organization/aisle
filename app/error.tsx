"use client";

import { RotateCcw } from "lucide-react";
import { useEffect } from "react";

import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="site-frame">
      <SiteHeader />
      <main className="route-page shell">
        <span className="eyebrow">Aisle interrupted</span>
        <h1>That route slipped off the rail.</h1>
        <p className="route-page__lede">
          Nothing was installed or changed. Try the request again.
        </p>
        <Button onClick={reset}>
          <RotateCcw aria-hidden="true" size={16} /> Try again
        </Button>
      </main>
    </div>
  );
}
