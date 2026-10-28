"use client";

import type { ChangeEvent } from "react";

export default function PdfFileInput({
  onSelect,
}: {
  onSelect(file: File): void;
}) {
  function selected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    // A native cancel does not dispatch change; reselecting the same file does.
    event.currentTarget.value = "";
    if (file) onSelect(file);
  }

  return (
    <div style={{ display: "grid", justifyItems: "center", gap: "0.75rem" }}>
      <label htmlFor="viewer-pdf-file" style={{ fontWeight: 650 }}>
        Choose a PDF from your device
      </label>
      <input
        id="viewer-pdf-file"
        data-testid="viewer-file"
        type="file"
        accept=".pdf,application/pdf"
        onChange={selected}
        aria-describedby="pdf-local-notice"
        style={{ maxWidth: "100%", font: "inherit" }}
      />
      <small id="pdf-local-notice" style={{ color: "#53685b" }}>
        Local processing only · PDF stays in this browser · 25 MiB maximum
      </small>
    </div>
  );
}
