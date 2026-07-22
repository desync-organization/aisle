import { ArrowUpRight } from "lucide-react";
import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="shell site-footer__inner">
        <div>
          <Link className="site-footer__brand" href="/">
            Aisle
          </Link>
          <p>Find public agent skills and install them together.</p>
        </div>
        <div className="site-footer__links">
          <Link href="/skills">Skills</Link>
          <Link href="/packages">Packages</Link>
          <Link href="/profile">Profile</Link>
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
          Aisle links to third-party skills. Review each source before installing.
        </p>
      </div>
    </footer>
  );
}
