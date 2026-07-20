"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

type CommandBlockProps = {
  command: string;
  label?: string;
};

export function CommandBlock({
  command,
  label = "Command preview · installer not connected",
}: CommandBlockProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (copyState === "idle") return;

    const timeout = window.setTimeout(() => setCopyState("idle"), 1800);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  const copied = copyState === "copied";

  return (
    <div className="command-block">
      <div className="command-block__meta">
        <span>{label}</span>
        <span className="command-block__status">Future install shape</span>
      </div>
      <div className="command-block__row">
        <code>{command}</code>
        <Button
          aria-label={copied ? "Command copied" : copyState === "failed" ? "Copy failed" : "Copy command"}
          className="command-block__copy"
          onClick={copyCommand}
          variant="quiet"
        >
          {copied ? <Check aria-hidden="true" size={16} /> : <Copy aria-hidden="true" size={16} />}
          <span>{copied ? "Copied" : copyState === "failed" ? "Retry" : "Copy"}</span>
        </Button>
      </div>
      <p aria-live="polite" className="sr-only">
        {copied
          ? "Command copied to the clipboard."
          : copyState === "failed"
            ? "The command could not be copied. Select the command text and copy it manually."
            : ""}
      </p>
    </div>
  );
}
