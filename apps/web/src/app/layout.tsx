import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Adobo Acrobatics",
  description: "The foundation for a private PDF workspace.",
  icons: {
    icon: {
      type: "image/svg+xml",
      url:
        "data:image/svg+xml," +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="10" fill="#f5f4ef"/><path d="M14 7h13l8 8v26H14V7Zm13 0v9h8M20 24h9M20 30h9" fill="none" stroke="#53685b" stroke-width="2" stroke-linejoin="round"/></svg>',
        ),
    },
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
