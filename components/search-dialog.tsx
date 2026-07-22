"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { ArrowRight, Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

type SearchDialogProps = {
  children: ReactNode;
};

export function SearchDialog({ children }: SearchDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    function openFromKeyboard(event: KeyboardEvent) {
      const target = event.target;
      const isTyping =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);

      if (event.key === "/" && !isTyping) {
        event.preventDefault();
        setOpen(true);
      }
    }

    window.addEventListener("keydown", openFromKeyboard);
    return () => window.removeEventListener("keydown", openFromKeyboard);
  }, []);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedQuery = query.trim();

    setOpen(false);
    router.push(normalizedQuery ? `/skills?q=${encodeURIComponent(normalizedQuery)}` : "/skills");
  }

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger asChild>{children}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="search-dialog">
          <div className="search-dialog__header">
            <div>
              <Dialog.Title>Search the public catalog</Dialog.Title>
              <Dialog.Description>
                Find by skill, source, category, or the work you want to do.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button aria-label="Close search" className="icon-button" variant="quiet">
                <X aria-hidden="true" size={19} />
              </Button>
            </Dialog.Close>
          </div>
          <form className="search-dialog__form" onSubmit={submitSearch} role="search">
            <Search aria-hidden="true" size={20} />
            <label className="sr-only" htmlFor="catalog-search">
              Search public Agent Skills
            </label>
            <input
              autoComplete="off"
              id="catalog-search"
              name="q"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Try “frontend”, “deployment”, or a source…"
              type="search"
              value={query}
            />
            <Button aria-label="Submit catalog search" className="icon-button" type="submit">
              <ArrowRight aria-hidden="true" size={19} />
            </Button>
          </form>
          <div className="search-dialog__note">
            <span className="status-dot" />
            Search only shows skills with a public source.
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
