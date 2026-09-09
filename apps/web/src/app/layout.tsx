import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Loom Agent Studio",
  description: "Desktop-first coding agent · Plan Board · Skills · multi-model",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=JSON.parse(localStorage.getItem('loom.settings.v1')||'{}');var t=s.theme||'studio';var d=s.density||'comfortable';var a=s.accent||'blue';var r=s.showRailLabels===false?'0':'1';document.documentElement.dataset.theme=t;document.documentElement.dataset.density=d;document.documentElement.dataset.accent=a;document.documentElement.dataset.railLabels=r;}catch(e){document.documentElement.dataset.theme='studio';document.documentElement.dataset.accent='blue';}})();`,
          }}
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
