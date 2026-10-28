"use client";

import { useEffect, useState, type FormEvent } from "react";
import { adjacentPage, parsePageNumber } from "../viewer/page-state";

export default function PageNavigation({
  pageNumber, pageCount, busy, onNavigate,
}: {
  pageNumber: number;
  pageCount: number;
  busy: boolean;
  onNavigate(page: number): void;
}) {
  const [entry, setEntry] = useState(String(pageNumber));
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setEntry(String(pageNumber));
    setInvalid(false);
  }, [pageNumber, pageCount]);

  function request(page: number | null) {
    if (page === null) return;
    setInvalid(false);
    setEntry(String(page));
    onNavigate(page);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const page = parsePageNumber(entry, pageCount);
    if (page === null) {
      setInvalid(true);
      return;
    }
    request(page);
  }

  return (
    <nav aria-label="PDF page navigation"
      style={{ display: "flex", flexWrap: "wrap", alignItems: "center",
        justifyContent: "center", gap: "0.75rem" }}>
      <button type="button" data-testid="page-previous"
        disabled={adjacentPage(pageNumber, -1, pageCount) === null}
        onClick={() => request(adjacentPage(pageNumber, -1, pageCount))}>
        Previous
      </button>
      <form onSubmit={submit} style={{ display: "flex", gap: "0.45rem", alignItems: "center" }}>
        <label htmlFor="viewer-page-entry">Page</label>
        <input id="viewer-page-entry" data-testid="page-entry"
          type="text" inputMode="numeric" autoComplete="off"
          value={entry} aria-invalid={invalid}
          aria-describedby={invalid ? "page-count-total page-entry-error" : "page-count-total"}
          onChange={event => { setEntry(event.target.value); setInvalid(false); }}
          style={{ width: "4.5rem", padding: "0.35rem", font: "inherit" }} />
        <span id="page-count-total">of {pageCount}</span>
        <button type="submit" data-testid="page-go">Go</button>
      </form>
      <button type="button" data-testid="page-next"
        disabled={adjacentPage(pageNumber, 1, pageCount) === null}
        onClick={() => request(adjacentPage(pageNumber, 1, pageCount))}>
        Next
      </button>
      {busy && <span data-testid="page-busy" role="status">Rendering…</span>}
      {invalid && <span id="page-entry-error" role="alert">
        Enter a whole page number from 1 to {pageCount}.
      </span>}
    </nav>
  );
}
