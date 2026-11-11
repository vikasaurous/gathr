import { createFileRoute } from "@tanstack/react-router";
import { PlainPage } from "@/components/gathr/plain-page";

export const Route = createFileRoute("/contact")({
  head: () => ({
    meta: [
      { title: "Contact — gathr" },
      { name: "description", content: "Get in touch with the gathr team." },
      { property: "og:title", content: "Contact — gathr" },
      { property: "og:description", content: "Get in touch with the gathr team." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: () => (
    <PlainPage
      eyebrow="Contact"
      title={
        <>
          Say <em>hello.</em>
        </>
      }
      paragraphs={[
        "We would like to hear how you handle invoices today.",
        "Write to hello@gathr.example — a placeholder address for this prototype.",
      ]}
    />
  ),
});
