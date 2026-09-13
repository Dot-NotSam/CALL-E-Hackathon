import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppProviders } from "@/components/shell/AppProviders";

/* Display serif, interface sans, and live data mono variables */
let garamondVar = "";
let figtreeVar = "";
let geistMonoVar = "";

try {
  const { EB_Garamond, Figtree, Geist_Mono } = require("next/font/google");
  const garamond = EB_Garamond({ variable: "--font-garamond", subsets: ["latin"], style: ["normal", "italic"] });
  const figtree = Figtree({ variable: "--font-figtree", subsets: ["latin"] });
  const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
  garamondVar = garamond.variable;
  figtreeVar = figtree.variable;
  geistMonoVar = geistMono.variable;
} catch {
  // Fallback if offline
}

export const metadata: Metadata = {
  title: "Sentinel Ops — wholesale coordination on CALL-E",
  description:
    "Sentinel Ops calls the wholesaler, negotiates stock and dispatch, and writes the commitment back to the order.",
};

export const viewport: Viewport = {
  themeColor: "#FFFFEB",
  colorScheme: "light dark",
};

/**
 * Cream is the default and the demo theme. This runs before paint so an
 * operator who chose dark never sees a cream flash, and vice versa.
 */
const THEME_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem("sentinel.theme");
    document.documentElement.dataset.theme = stored === "dark" ? "dark" : "light";
  } catch (e) {
    document.documentElement.dataset.theme = "light";
  }
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      data-theme="light"
      suppressHydrationWarning
      className={`${garamondVar} ${figtreeVar} ${geistMonoVar} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full">
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
