import { ArrowUpRight, Boxes, Grid2X2, Layers3, ShieldCheck } from "lucide-react";
import Link from "next/link";

const destinations = [
  { href: "/packages", icon: Boxes, id: "packages", label: "Packages", note: "Ready-made sets" },
  { href: "/skills", icon: Layers3, id: "skills", label: "Skills", note: "Browse all skills" },
  { href: "/categories", icon: Grid2X2, id: "categories", label: "Categories", note: "Browse by topic" },
] as const;

export function ExploreRail({ active }: { active: (typeof destinations)[number]["id"] }) {
  return (
    <aside aria-label="Marketplace navigation" className="explore-rail">
      <div className="explore-rail__label">Browse</div>
      <nav>
        {destinations.map(({ href, icon: Icon, id, label, note }, index) => (
          <Link aria-current={active === id ? "page" : undefined} href={href} key={href}>
            <span className="explore-rail__index">0{index + 1}</span>
            <Icon aria-hidden="true" size={17} />
            <span>
              <strong>{label}</strong>
              <small>{note}</small>
            </span>
            <ArrowUpRight aria-hidden="true" className="explore-rail__arrow" size={15} />
          </Link>
        ))}
      </nav>
      <Link className="explore-rail__safety" href="/safety">
        <ShieldCheck aria-hidden="true" size={15} />
        <span>How eligibility works</span>
      </Link>
    </aside>
  );
}
