import { createFileRoute } from "@tanstack/react-router";
import { PlainPage } from "@/components/gathr/plain-page";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Terms — gathr" },
      { name: "description", content: "Terms of use for the gathr prototype." },
      { property: "og:title", content: "Terms — gathr" },
      { property: "og:description", content: "Terms of use for the gathr prototype." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: () => <PlainPage eyebrow="Terms" title={<>Terms, <em>plainly.</em></>} paragraphs={["gathr is currently a prototype. Extraction results are simulated and must not be relied on for accounting or tax purposes.", "Confidence scores are review hints, not proof of financial accuracy. Always verify values against the original document."]} />,
});
