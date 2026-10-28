/** One-based page numbers are UI-only; the PDF adapter uses zero-based indexes. */
export function validPageNumber(page: number, pageCount: number): boolean {
  return Number.isSafeInteger(pageCount) && pageCount > 0 &&
    Number.isSafeInteger(page) && page >= 1 && page <= pageCount;
}

/** Reject decimals, signs, exponents, whitespace, and nonnumeric entries. */
export function parsePageNumber(raw: string, pageCount: number): number | null {
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const page = Number(raw);
  return validPageNumber(page, pageCount) ? page : null;
}

export function adjacentPage(
  current: number, delta: -1 | 1, pageCount: number,
): number | null {
  const next = current + delta;
  return validPageNumber(next, pageCount) ? next : null;
}
