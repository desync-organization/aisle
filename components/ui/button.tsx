import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps } from "react";

import { cn } from "@/lib/utils";

type ButtonVariant = "primary" | "secondary" | "quiet";

function buttonClasses(variant: ButtonVariant) {
  return cn("button", `button--${variant}`);
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
};

export function Button({ className, type = "button", variant = "primary", ...props }: ButtonProps) {
  return <button className={cn(buttonClasses(variant), className)} type={type} {...props} />;
}

type ButtonLinkProps = ComponentProps<typeof Link> & {
  variant?: ButtonVariant;
};

export function ButtonLink({ className, variant = "primary", ...props }: ButtonLinkProps) {
  return <Link className={cn(buttonClasses(variant), className)} {...props} />;
}
