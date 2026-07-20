"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { ArrowUpRight, Layers3, Menu, Search, X } from "lucide-react";
import Link from "next/link";

import { SearchDialog } from "@/components/search-dialog";
import { Button } from "@/components/ui/button";

const navigation = [
  { href: "/packages", label: "Packages" },
  { href: "/skills", label: "Skills" },
  { href: "/categories", label: "Categories" },
  { href: "/docs", label: "Docs" },
] as const;

function Brand() {
  return (
    <Link aria-label="Aisle home" className="brand" href="/">
      <span aria-hidden="true" className="brand__mark">
        <i />
        <i />
        <i />
      </span>
      <span className="brand__word">aisle</span>
    </Link>
  );
}

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="shell site-header__inner">
        <Brand />
        <nav aria-label="Primary navigation" className="desktop-nav">
          {navigation.map((item) => (
            <Link href={item.href} key={item.href}>
              {item.label}
            </Link>
          ))}
          <a
            className="desktop-nav__external"
            href="https://github.com/Krishang-Zinzuwadia/aisle"
            rel="noreferrer"
            target="_blank"
          >
            GitHub <ArrowUpRight aria-hidden="true" size={13} />
          </a>
        </nav>
        <div className="site-header__actions">
          <SearchDialog>
            <Button className="search-trigger" variant="secondary">
              <Search aria-hidden="true" size={16} />
              <span>Search</span>
              <kbd>/</kbd>
            </Button>
          </SearchDialog>
          <Link aria-label="Your Stack, 0 selected" className="stack-link" href="/skills">
            <Layers3 aria-hidden="true" size={16} />
            <span>Your Stack</span>
            <strong>0</strong>
          </Link>
          <Dialog.Root>
            <Dialog.Trigger asChild>
              <Button aria-label="Open navigation" className="mobile-menu-trigger" variant="secondary">
                <Menu aria-hidden="true" size={20} />
              </Button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="dialog-overlay" />
              <Dialog.Content className="mobile-sheet">
                <div className="mobile-sheet__header">
                  <Dialog.Title>Navigate Aisle</Dialog.Title>
                  <Dialog.Close asChild>
                    <Button aria-label="Close navigation" className="icon-button" variant="quiet">
                      <X aria-hidden="true" size={20} />
                    </Button>
                  </Dialog.Close>
                </div>
                <Dialog.Description>
                  Browse packages, individual public skills, categories, and documentation.
                </Dialog.Description>
                <nav aria-label="Mobile navigation" className="mobile-nav">
                  {navigation.map((item, index) => (
                    <Dialog.Close asChild key={item.href}>
                      <Link href={item.href}>
                        <span>0{index + 1}</span>
                        {item.label}
                        <ArrowUpRight aria-hidden="true" size={17} />
                      </Link>
                    </Dialog.Close>
                  ))}
                </nav>
                <a
                  className="mobile-sheet__github"
                  href="https://github.com/Krishang-Zinzuwadia/aisle"
                  rel="noreferrer"
                  target="_blank"
                >
                  View the source on GitHub <ArrowUpRight aria-hidden="true" size={16} />
                </a>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </div>
      </div>
    </header>
  );
}
