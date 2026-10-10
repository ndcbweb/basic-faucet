import "./globals.css";

export const metadata = {
  title: "Faucet",
  description: "Get test tokens",
};

const themeBoot = `try{var t=localStorage.getItem("faucet-theme");var d=t?t==="dark":true;document.documentElement.classList.toggle("dark",d)}catch(e){}`;

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
