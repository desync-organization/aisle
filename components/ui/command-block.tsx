"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

type CommandBlockProps = {
  command: string;
  label?: string;
};

export function CommandBlock({ command, label = "Install command format" }: CommandBlockProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;

    const timeout = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  async function copyCommand() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
  }

  return (
    <div className="command-block">
      <div className="command-block__meta">
        <span>{label}</span>
        <span className="command-block__status">One selection · one command</span>
      </div>
      <div className="command-block__row">
        <code>{command}</code>
        <Button
          aria-label={copied ? "Command copied" : "Copy command"}
          className="command-block__copy"
          onClick={copyCommand}
          variant="quiet"
        >
          {copied ? <Check aria-hidden="true" size={16} /> : <Copy aria-hidden="true" size={16} />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </Button>
      </div>
      <p aria-live="polite" className="sr-only">
        {copied ? "Command copied to the clipboard." : ""}
      </p>
    </div>
  );
}
