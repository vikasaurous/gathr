import { Link } from "@tanstack/react-router";
import { Menu, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Wordmark } from "./brand";

const NAV = [
  { to: "/product", label: "Product" },
  { to: "/how-it-works", label: "How it works" },
  { to: "/features", label: "Features" },
  { to: "/pricing", label: "Pricing" },
] as const;

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-[1240px] items-center justify-between px-6">
        <Wordmark />
        <nav className="hidden items-center gap-8 md:flex">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              className="text-[13.5px] text-muted-foreground transition-colors hover:text-foreground"
              activeProps={{ className: "text-foreground" }}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="hidden items-center gap-2 md:flex">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/login">Sign in</Link>
          </Button>
          <Button variant="ink" size="sm" asChild>
            <Link to="/register">Get started</Link>
          </Button>
        </div>
        <button className="md:hidden" onClick={() => setOpen(!open)} aria-label="Menu">
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </div>
      {open && (
        <div className="border-t border-border px-6 py-4 md:hidden">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              onClick={() => setOpen(false)}
              className="block border-b border-border py-3 text-sm"
            >
              {n.label}
            </Link>
          ))}
          <div className="mt-4 flex gap-2">
            <Button variant="outline" className="flex-1" asChild>
              <Link to="/login">Sign in</Link>
            </Button>
            <Button variant="ink" className="flex-1" asChild>
              <Link to="/register">Get started</Link>
            </Button>
          </div>
        </div>
      )}
    </header>
  );
}

export function SiteFooter() {
  const cols = [
    {
      h: "Product",
      items: [
        ["/product", "Product"],
        ["/features", "Features"],
        ["/how-it-works", "How it works"],
        ["/pricing", "Pricing"],
      ],
    },
    {
      h: "Company",
      items: [
        ["/privacy", "Privacy"],
        ["/terms", "Terms"],
        ["/contact", "Contact"],
      ],
    },
  ] as const;
  return (
    <footer className="border-t border-border">
      <div className="mx-auto grid max-w-[1240px] gap-12 px-6 py-16 md:grid-cols-12">
        <div className="md:col-span-6">
          <Wordmark />
          <p className="mt-4 max-w-xs text-sm text-muted-foreground">
            Bring every invoice together.
          </p>
        </div>
        {cols.map((c) => (
          <div key={c.h} className="md:col-span-3">
            <p className="eyebrow mb-4">{c.h}</p>
            <ul className="space-y-2.5">
              {c.items.map(([to, l]) => (
                <li key={to}>
                  <Link
                    to={to}
                    className="text-sm text-foreground/80 transition-colors hover:text-foreground"
                  >
                    {l}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="mx-auto flex max-w-[1240px] justify-between border-t border-border px-6 py-6 text-xs text-muted-foreground">
        <span>© {new Date().getFullYear()} gathr</span>{" "}
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true">&#9829;&#xFE0E;</span>
          <span>
            Designed and developed by{" "}
            <a
              href="#"
              target="_blank"
              rel="noopener noreferrer"
              className="group relative inline-block italic transition-colors duration-300 ease-out hover:text-foreground"
            >
              Slate.
              <span
                aria-hidden="true"
                className="absolute bottom-0 left-0 h-px w-full origin-left scale-x-0 bg-current transition-transform duration-300 ease-out group-hover:scale-x-100"
              />
            </a>
          </span>
        </span>
      </div>
    </footer>
  );
}

export function PageIntro({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <section className="mx-auto max-w-[1240px] px-6 pb-16 pt-20 md:pt-28">
      <p className="eyebrow">{eyebrow}</p>
      <h1 className="display mt-6 max-w-4xl text-[56px] md:text-[96px]">{title}</h1>
      {children && (
        <div className="mt-8 max-w-xl text-lg leading-relaxed text-muted-foreground">
          {children}
        </div>
      )}
    </section>
  );
}
