import { createFileRoute } from "@tanstack/react-router";
import { PlainPage } from "@/components/gathr/plain-page";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy — gathr" },
      { name: "description", content: "How gathr approaches document handling." },
      { property: "og:title", content: "Privacy — gathr" },
      { property: "og:description", content: "How gathr approaches document handling." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: () => <PlainPage eyebrow="Privacy" title={<>Handled <em>with care.</em></>} paragraphs={["This prototype runs entirely in your browser. Uploaded files are not sent anywhere; processing results shown are demonstration data.", "When storage is connected, original files, source page references, extracted values and your corrections will be kept together so every record can be traced.", "A full privacy policy will be published before gathr processes real documents."]} />,
});
