import { ArrowUpRight } from "lucide-react";
import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="shell site-footer__inner">
        <div>
          <Link className="site-footer__brand" href="/">
            Aisle<span>®</span>
          </Link>
          <p>Public skills. Clear provenance. One composed stack.</p>
        </div>
        <div className="site-footer__links">
          <Link href="/skills">Skills</Link>
          <Link href="/packages">Packages</Link>
          <Link href="/docs">Documentation</Link>
          <Link href="/safety">Safety</Link>
          <Link href="/coverage">Coverage</Link>
          <Link href="/privacy">Privacy</Link>
          <a
            href="https://agentskills.io/specification"
            rel="noreferrer"
            target="_blank"
          >
            Agent Skills spec <ArrowUpRight aria-hidden="true" size={13} />
          </a>
        </div>
        <p className="site-footer__note">
          Aisle indexes public upstream work; it does not author or guarantee third-party skills.
        </p>
      </div>
    </footer>
  );
}
