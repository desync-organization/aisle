import { ArrowRight, CircleDashed, ShieldCheck } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";

const filters = ["Frontend", "Motion & 3D", "Deployment", "Security", "Mobile"];

export function CatalogPlaceholder() {
  return (
    <section aria-labelledby="catalog-heading" className="catalog-preview shell">
      <div className="section-heading">
        <div>
          <Badge tone="iris">Catalog surface</Badge>
          <h2 id="catalog-heading">Built for signal, not shelf space.</h2>
        </div>
        <p>
          Filter by what you need, inspect where it came from, and keep the final choice in view.
        </p>
      </div>
      <div aria-label="Example catalog categories" className="filter-row">
        <span className="filter-row__label">Explore by</span>
        {filters.map((filter) => (
          <button disabled key={filter} type="button">
            {filter}
          </button>
        ))}
      </div>
      <div className="catalog-empty">
        <div className="catalog-empty__icon">
          <CircleDashed aria-hidden="true" size={23} />
        </div>
        <div>
          <span className="eyebrow">Source connection pending</span>
          <h3>No invented listings while the public catalog comes online.</h3>
          <p>
            This foundation intentionally ships without sample skills. Every future card must resolve to a real public upstream revision.
          </p>
        </div>
        <Link href="/docs">
          Read the policy <ArrowRight aria-hidden="true" size={15} />
        </Link>
        <div className="catalog-empty__trust">
          <ShieldCheck aria-hidden="true" size={15} /> Public-only boundary active
        </div>
      </div>
    </section>
  );
}
