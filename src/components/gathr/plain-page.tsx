import { PageIntro, SiteFooter, SiteHeader } from "./site-chrome";

export function PlainPage({
  eyebrow,
  title,
  paragraphs,
}: {
  eyebrow: string;
  title: React.ReactNode;
  paragraphs: string[];
}) {
  return (
    <div className="min-h-screen">
      <SiteHeader />
      <PageIntro eyebrow={eyebrow} title={title} />
      <section className="mx-auto max-w-[1240px] px-6 pb-28">
        <div className="max-w-2xl space-y-5 border-t border-foreground pt-10 text-[16px] leading-relaxed text-muted-foreground">
          {paragraphs.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
      </section>
      <SiteFooter />
    </div>
  );
}
