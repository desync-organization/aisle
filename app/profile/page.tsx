import { FolderHeart, Link2, UserRound } from "lucide-react";
import type { Metadata } from "next";

import { CollectionCreator } from "@/components/marketplace/collection-creator";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
  title: "Profile",
  description: "View and share the skill collections saved on this device.",
  path: "/profile",
});

export default function ProfilePage() {
  return (
    <div className="site-frame">
      <SiteHeader />
      <main className="profile-page shell">
        <header className="profile-hero">
          <div className="profile-hero__mark" aria-hidden="true">
            <UserRound size={24} />
          </div>
          <div>
            <Badge tone="iris">Saved on this device</Badge>
            <h1>Your profile.</h1>
            <p>Collections you create here stay together on this device. Sign-in is coming later.</p>
          </div>
          <dl>
            <div><dt>Collections</dt><dd>This device</dd></div>
            <div><dt>Sharing</dt><dd>Public links</dd></div>
            <div><dt>Account</dt><dd>Coming later</dd></div>
          </dl>
        </header>

        <section className="profile-collections" aria-labelledby="profile-collections-heading">
          <div className="market-section__heading">
            <div>
              <span>Collections</span>
              <h2 id="profile-collections-heading">Save a stack and share it.</h2>
            </div>
            <p>Choose skills anywhere in Aisle, name the set here, and send the link to anyone.</p>
          </div>
          <CollectionCreator />
        </section>

        <aside className="profile-account-note">
          <FolderHeart aria-hidden="true" size={19} />
          <div>
            <strong>Accounts are next.</strong>
            <p>For now, this browser remembers which collections are yours. When sign-in arrives, you’ll be able to move them to your account.</p>
          </div>
          <Link2 aria-hidden="true" size={17} />
        </aside>
      </main>
      <SiteFooter />
    </div>
  );
}
