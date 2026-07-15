import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "专家供给增长工作台",
  description: "专家招募、复核、触达与渠道分发工作台。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
