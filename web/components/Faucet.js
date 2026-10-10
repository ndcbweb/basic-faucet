"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Captcha } from "@/components/Captcha";
import { solveChallenge } from "@/lib/pow";

const POLL_MS = 20_000;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function inkFor(hex) {
  const match = /^#([0-9a-f]{6})$/i.exec(hex || "");
  if (!match) return "#181a20";
  const n = Number.parseInt(match[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? "#181a20" : "#ffffff";
}

function windowLabel(hours) {
  return Number(hours) === 24 ? "24 hours" : `${hours} hours`;
}

function times(n) {
  return n === 1 ? "once" : `${n} times`;
}

function defaultFaq(config) {
  const { chain, limits, assets } = config;
  const native = assets.find((asset) => asset.type === "native");
  return [
    {
      q: `What are ${chain.name} test tokens?`,
      a: `They are ${chain.symbol} on ${chain.name} (Chain ID ${chain.id}) for deploying and testing contracts. They have no real-world value.`,
    },
    {
      q: "Are there any rate limits?",
      a: `Each wallet can claim ${times(limits.perAddress || 1)} every ${windowLabel(limits.windowHours)}${
        limits.perIp ? `, and each network ${times(limits.perIp)}` : ""
      }.`,
    },
    {
      q: "What if I need a larger amount?",
      a: "Contact the team through the links below with your use case and wallet address.",
    },
    {
      q: "Which tokens does the faucet send?",
      a: assets.map((asset) => `${asset.amount} ${asset.symbol}`).join(", ") || `${native?.amount || ""} ${chain.symbol}`,
    },
    {
      q: "What if my request keeps failing?",
      a: "Make sure the address is a regular wallet (not a contract), wait for the cooldown, and refresh the page before trying again.",
    },
  ];
}

function Icon({ path, className = "h-4 w-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

const ICONS = {
  check: "M20 6 9 17l-5-5",
  sun: "M12 3v2m0 14v2M5.6 5.6l1.4 1.4m10 10 1.4 1.4M3 12h2m14 0h2M5.6 18.4 7 17m10-10 1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  external: "M14 4h6v6m0-6L10 14M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5",
  wallet: "M3 7a2 2 0 0 1 2-2h13v4M3 7v10a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2m14 7h.01",
  shield: "M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z",
};

const SOCIALS = [
  ["website", "Website"],
  ["twitter", "X"],
  ["telegram", "Telegram"],
  ["discord", "Discord"],
  ["github", "GitHub"],
];

function txLink(explorerUrl, hash) {
  return explorerUrl ? `${explorerUrl.replace(/\/$/, "")}/tx/${hash}` : "";
}

export function Faucet() {
  const [config, setConfig] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [status, setStatus] = useState(null);
  const [recent, setRecent] = useState([]);
  const [dark, setDark] = useState(true);
  const [address, setAddress] = useState("");
  const [assetId, setAssetId] = useState("");
  const [honeypot, setHoneypot] = useState("");
  const [captchaToken, setCaptchaToken] = useState("");
  const [captchaKey, setCaptchaKey] = useState(0);
  const [phase, setPhase] = useState("idle");
  const [powProgress, setPowProgress] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [openFaq, setOpenFaq] = useState(-1);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
    fetch("/api/config")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error())))
      .then((data) => {
        setConfig(data);
        setAssetId(data.assets[0]?.id || "");
        const root = document.documentElement;
        root.style.setProperty("--brand", data.brandColor || "#f0b90b");
        root.style.setProperty("--brand-ink", inkFor(data.brandColor || "#f0b90b"));
        let stored = null;
        try {
          stored = localStorage.getItem("faucet-theme");
        } catch {
          /* private mode */
        }
        if (!stored && data.defaultTheme !== "system") {
          root.classList.toggle("dark", data.defaultTheme !== "light");
          setDark(data.defaultTheme !== "light");
        } else if (!stored) {
          const prefers = window.matchMedia("(prefers-color-scheme: dark)").matches;
          root.classList.toggle("dark", prefers);
          setDark(prefers);
        }
        document.title = data.metaTitle || `${data.chain.name} Faucet`;
        if (data.metaDescription) {
          let meta = document.querySelector('meta[name="description"]');
          if (!meta) {
            meta = document.createElement("meta");
            meta.name = "description";
            document.head.appendChild(meta);
          }
          meta.content = data.metaDescription;
        }
        if (data.favicon) {
          const link = document.querySelector('link[rel="icon"]') || document.createElement("link");
          link.rel = "icon";
          link.href = `/branding/${data.favicon}?v=${data.version || ""}`;
          document.head.appendChild(link);
        }
      })
      .catch(() => setLoadError("The faucet is starting up. Refresh in a moment."));
  }, []);

  const refresh = useCallback(async () => {
    const [statusRes, recentRes] = await Promise.all([
      fetch("/api/status").catch(() => null),
      fetch("/api/recent").catch(() => null),
    ]);
    if (statusRes?.ok) setStatus(await statusRes.json());
    if (recentRes?.ok) setRecent((await recentRes.json()).claims || []);
  }, []);

  useEffect(() => {
    if (!config) return undefined;
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [config, refresh]);

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("faucet-theme", next ? "dark" : "light");
    } catch {
      /* private mode */
    }
  }

  async function connectWallet() {
    if (!window.ethereum) {
      setError("No browser wallet found. Paste your address instead.");
      return;
    }
    try {
      const [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
      if (account) setAddress(account);
    } catch {
      /* user closed the wallet */
    }
  }

  async function addNetwork() {
    if (!window.ethereum || !config) return;
    try {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: `0x${config.chain.id.toString(16)}`,
            chainName: config.chain.name,
            nativeCurrency: { name: config.chain.currencyName, symbol: config.chain.symbol, decimals: 18 },
            rpcUrls: [config.chain.rpcUrl],
            ...(config.explorerUrl ? { blockExplorerUrls: [config.explorerUrl] } : {}),
          },
        ],
      });
    } catch {
      /* user rejected */
    }
  }

  const onCaptchaToken = useCallback((token) => setCaptchaToken(token), []);
  const needsCaptcha = Boolean(config && config.security.captcha !== "none" && config.security.captchaSiteKey);
  const asset = config?.assets.find((item) => item.id === assetId);
  const validAddress = ADDRESS_RE.test(address.trim());
  const busy = phase !== "idle";
  const canSend = Boolean(config && asset && validAddress && !busy && !config.security.paused && (!needsCaptcha || captchaToken));

  async function claim(event) {
    event.preventDefault();
    if (!canSend) return;
    setError("");
    setResult(null);
    try {
      let pow = null;
      if (config.security.powDifficulty > 0) {
        setPhase("verifying");
        setPowProgress(0);
        const res = await fetch("/api/challenge");
        const challenge = await res.json();
        if (!res.ok) throw new Error(challenge.error || challenge.message || "Too many requests, slow down");
        pow = await solveChallenge(challenge, setPowProgress);
      }
      setPhase("sending");
      const res = await fetch("/api/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: address.trim(), asset: assetId, pow, captchaToken, website: honeypot }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || data.message || "Request failed");
      setResult(data);
      refresh();
    } catch (err) {
      setError(err.message || "Request failed");
    } finally {
      setPhase("idle");
      setCaptchaToken("");
      setCaptchaKey((key) => key + 1);
    }
  }

  const faq = useMemo(() => (config ? (config.faq?.length ? config.faq : defaultFaq(config)) : []), [config]);

  if (!config) {
    return (
      <div className="grid min-h-screen place-items-center px-6 text-center text-sm text-muted">
        {loadError || (
          <span className="inline-flex items-center gap-2">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
            Loading faucet…
          </span>
        )}
      </div>
    );
  }

  const { chain, limits, security } = config;
  const name = chain.name;
  const notices = [
    `Every ${windowLabel(limits.windowHours)}, a wallet can claim ${times(limits.perAddress || 1)}.`,
    ...(security.holder?.enabled
      ? [`${security.holder.minBalance} ${security.holder.label || "on mainnet"} is needed to use this faucet.`]
      : []),
    ...(limits.maxRecipientBalance ? [`Only wallets holding under ${limits.maxRecipientBalance} ${chain.symbol} can claim.`] : []),
    ...(config.notices || []),
  ];
  const socials = SOCIALS.filter(([key]) => config[key]);
  const year = new Date().getFullYear();
  const card = "rounded-2xl bg-white ring-1 ring-black/5 dark:bg-panel dark:ring-white/5";
  const field = "brand-ring h-12 w-full rounded-lg bg-[#f5f5f5] px-4 text-sm text-ink placeholder:text-muted dark:bg-field dark:text-[#eaecef]";

  return (
    <div className="flex min-h-screen flex-col">
      {config.announcementEnabled && config.announcementText ? (
        <div className="brand-bg px-4 py-2 text-center text-sm font-medium">
          {config.announcementLink ? (
            <a href={config.announcementLink} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
              {config.announcementText}
            </a>
          ) : (
            config.announcementText
          )}
        </div>
      ) : null}

      <header className="border-b border-black/5 bg-white/80 backdrop-blur dark:border-white/5 dark:bg-night/80">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-5">
          <a href="/" className="flex min-w-0 items-center gap-2.5">
            {config.logo ? (
              <img src={`/branding/${config.logo}?v=${config.version || ""}`} alt={name} className="h-8 max-w-[160px] object-contain" />
            ) : (
              <span className="brand-bg grid h-8 w-8 place-items-center rounded-lg text-sm font-black">{name.slice(0, 1)}</span>
            )}
            {!config.logo || !config.hideNameWithLogo ? (
              <span className="brand-text truncate text-base font-bold uppercase tracking-wide">{name}</span>
            ) : null}
          </a>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={addNetwork}
              className="hidden h-9 items-center gap-1.5 rounded-full px-3.5 text-xs font-semibold ring-1 ring-[var(--brand)] brand-text transition hover:bg-[var(--brand)]/10 sm:inline-flex"
            >
              <Icon path={ICONS.plus} className="h-3.5 w-3.5" /> Add {name}
            </button>
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
              className="grid h-9 w-9 place-items-center rounded-full text-muted transition hover:bg-black/5 hover:text-ink dark:hover:bg-white/10 dark:hover:text-white"
            >
              <Icon path={dark ? ICONS.sun : ICONS.moon} />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[640px] flex-1 px-5 pb-20 pt-14">
        <h1 className="text-center text-4xl font-black uppercase tracking-tight sm:text-5xl">
          {config.title || (
            <>
              {name} <span className="brand-text">Faucet</span>
            </>
          )}
        </h1>
        {config.subtitle ? <p className="mt-3 text-center text-sm text-muted">{config.subtitle}</p> : null}

        <form onSubmit={claim} className={`${card} mt-10 p-6 sm:p-7`} noValidate>
          <h2 className="text-lg font-semibold">Get Test Tokens</h2>
          <ul className="mt-3 space-y-1.5">
            {notices.map((line) => (
              <li key={line} className="flex items-start gap-2 text-xs text-muted">
                <Icon path={ICONS.check} className="mt-px h-3.5 w-3.5 shrink-0 text-emerald-500" />
                <span>{line}</span>
              </li>
            ))}
          </ul>

          <div className="my-6 h-px bg-black/5 dark:bg-white/5" />

          {security.paused ? (
            <p className="mb-5 rounded-lg bg-amber-500/10 px-4 py-3 text-sm text-amber-600 dark:text-amber-400">
              {security.pausedMessage || "The faucet is paused. Check back soon."}
            </p>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <label className="block">
              <span className="mb-2 block text-xs text-muted">Select token</span>
              <select value={assetId} onChange={(event) => setAssetId(event.target.value)} className={`${field} cursor-pointer appearance-none bg-no-repeat pr-10`}>
                {config.assets.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.amount} {item.symbol}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-2 flex items-center justify-between text-xs text-muted">
                Wallet Address
                <button type="button" onClick={connectWallet} className="brand-text inline-flex items-center gap-1 font-medium hover:underline">
                  <Icon path={ICONS.wallet} className="h-3.5 w-3.5" /> Use wallet
                </button>
              </span>
              <input
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                placeholder={`Enter your ${name} address`}
                spellCheck={false}
                autoComplete="off"
                className={`${field} font-mono`}
              />
            </label>
          </div>
          {address && !validAddress ? <p className="mt-2 text-xs text-red-500">Enter a 0x address with 40 hex characters.</p> : null}

          <input
            type="text"
            name="website"
            tabIndex={-1}
            autoComplete="off"
            value={honeypot}
            onChange={(event) => setHoneypot(event.target.value)}
            className="absolute -left-[9999px] h-px w-px opacity-0"
            aria-hidden="true"
          />

          {needsCaptcha ? (
            <div className="mt-5">
              <Captcha
                key={`${captchaKey}-${dark}`}
                provider={security.captcha}
                siteKey={security.captchaSiteKey}
                theme={dark ? "dark" : "light"}
                onToken={onCaptchaToken}
              />
            </div>
          ) : null}

          <button
            type="submit"
            disabled={!canSend}
            className="brand-bg mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-lg text-sm font-semibold transition hover:brightness-95 disabled:cursor-not-allowed disabled:bg-black/10 disabled:text-muted dark:disabled:bg-white/10"
          >
            {busy ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" /> : null}
            {phase === "verifying"
              ? `Verifying you are human… ${powProgress}%`
              : phase === "sending"
                ? "Sending…"
                : `Send ${asset ? `${asset.amount} ${asset.symbol}` : ""}`}
          </button>
          {security.powDifficulty > 0 ? (
            <p className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-muted">
              <Icon path={ICONS.shield} className="h-3 w-3" /> Protected by proof-of-work verification and rate limits
            </p>
          ) : null}

          {error ? <p className="mt-4 rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
          {result ? (
            <div className="mt-4 rounded-lg bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-400">
              <p className="font-semibold">
                Sent {result.amount} {result.symbol}
              </p>
              <p className="mt-1 break-all font-mono text-xs">
                {txLink(config.explorerUrl, result.txHash) ? (
                  <a href={txLink(config.explorerUrl, result.txHash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
                    {result.txHash} <Icon path={ICONS.external} className="h-3 w-3 shrink-0" />
                  </a>
                ) : (
                  result.txHash
                )}
              </p>
            </div>
          ) : null}
        </form>

        {status?.balances?.length ? (
          <section className={`${card} mt-6 grid grid-cols-2 gap-px overflow-hidden sm:grid-cols-3`}>
            {status.balances.map((item) => (
              <div key={item.id} className="p-5">
                <p className="text-xs text-muted">Faucet balance</p>
                <p className="mt-1 truncate text-lg font-semibold">
                  {item.balance == null ? "—" : Number(item.balance).toLocaleString("en-US", { maximumFractionDigits: 4 })}{" "}
                  <span className="text-sm text-muted">{item.symbol}</span>
                </p>
              </div>
            ))}
            <div className="p-5">
              <p className="text-xs text-muted">Claims, last 24 h</p>
              <p className="mt-1 text-lg font-semibold">{status.claims.last24h.toLocaleString("en-US")}</p>
            </div>
          </section>
        ) : null}

        {recent.length ? (
          <section className={`${card} mt-6 p-6`}>
            <h2 className="text-base font-semibold">Recent drips</h2>
            <ul className="mt-4 divide-y divide-black/5 text-sm dark:divide-white/5">
              {recent.map((row) => (
                <li key={row.txHash} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="font-mono text-xs">{row.address}</span>
                  <span className="text-xs text-muted">{new Date(row.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  {txLink(config.explorerUrl, row.txHash) ? (
                    <a href={txLink(config.explorerUrl, row.txHash)} target="_blank" rel="noreferrer" className="brand-text font-medium hover:underline">
                      {row.amount} {row.symbol}
                    </a>
                  ) : (
                    <span className="font-medium">
                      {row.amount} {row.symbol}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="mt-20">
          <h2 className="text-center text-2xl font-bold">FAQ</h2>
          <ul className="mt-8 border-t border-black/10 dark:border-white/10">
            {faq.map((item, index) => {
              const open = openFaq === index;
              return (
                <li key={item.q} className="border-b border-black/10 dark:border-white/10">
                  <button
                    type="button"
                    onClick={() => setOpenFaq(open ? -1 : index)}
                    aria-expanded={open}
                    className="flex w-full items-center gap-5 py-4 text-left"
                  >
                    <span className="w-6 shrink-0 text-sm text-muted">{String(index + 1).padStart(2, "0")}</span>
                    <span className="flex-1 text-[15px] font-medium">{item.q}</span>
                    <Icon path={open ? ICONS.minus : ICONS.plus} className="h-4 w-4 shrink-0 text-muted" />
                  </button>
                  {open ? <p className="pb-5 pl-11 pr-8 text-sm leading-relaxed text-muted">{item.a}</p> : null}
                </li>
              );
            })}
          </ul>
        </section>
      </main>

      <footer className="border-t border-black/5 bg-white dark:border-white/5 dark:bg-[#181a20]">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-10 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-sm">
            <p className="brand-text font-bold uppercase tracking-wide">{name}</p>
            <p className="mt-2 text-sm text-muted">
              {config.footerText || `Free ${chain.symbol} test tokens for builders on ${name}. Chain ID ${chain.id}.`}
            </p>
          </div>
          {socials.length ? (
            <nav className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
              {socials.map(([key, label]) => (
                <a key={key} href={config[key]} target="_blank" rel="noreferrer" className="text-muted transition hover:text-ink dark:hover:text-white">
                  {label}
                </a>
              ))}
              {config.explorerUrl ? (
                <a href={config.explorerUrl} target="_blank" rel="noreferrer" className="text-muted transition hover:text-ink dark:hover:text-white">
                  Explorer
                </a>
              ) : null}
            </nav>
          ) : null}
        </div>
        <div className="border-t border-black/5 px-5 py-4 text-center text-xs text-muted dark:border-white/5">
          © {year} {name}. Faucet by Nadcab Labs.
        </div>
      </footer>
    </div>
  );
}
