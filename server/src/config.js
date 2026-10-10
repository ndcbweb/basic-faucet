import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const env = (key, fallback = "") => String(process.env[key] ?? fallback).trim();

export const ENV = {
  port: Number(env("PORT", "80")),
  dataDir: env("DATA_DIR", "/data"),
  webDir: env("WEB_DIR", fileURLToPath(new URL("../../web/out", import.meta.url))),
  rpcUrl: env("RPC_URL"),
  chainId: Number(env("CHAIN_ID", "0")),
  chainName: env("CHAIN_NAME", "Chain"),
  currencySymbol: env("CURRENCY_SYMBOL", "ETH"),
  currencyName: env("CURRENCY_NAME", "Ether"),
  privateKey: env("FAUCET_PRIVATE_KEY"),
  // Signs proof-of-work challenges and authenticates console admin calls.
  secret: env("FAUCET_SECRET"),
};

if (!/^0x[0-9a-fA-F]{64}$/.test(ENV.privateKey)) throw new Error("FAUCET_PRIVATE_KEY must be a 0x-prefixed 32-byte key");
if (ENV.secret.length < 32) throw new Error("FAUCET_SECRET must be at least 32 characters");
if (!ENV.rpcUrl || !ENV.chainId) throw new Error("RPC_URL and CHAIN_ID are required");

export const BRANDING_DIR = join(ENV.dataDir, "branding");
const SETTINGS_FILE = join(BRANDING_DIR, "settings.json");

export const DEFAULTS = {
  name: "",
  title: "",
  subtitle: "",
  hideNameWithLogo: false,
  logo: "",
  favicon: "",
  brandColor: "#f0b90b",
  defaultTheme: "dark",
  explorerUrl: "",
  assets: [{ id: "native", type: "native", symbol: "", decimals: 18, amount: "0.1", enabled: true }],
  limits: {
    windowHours: 24,
    perAddress: 1,
    perIp: 3,
    cooldownMinutes: 0,
    globalPerWindow: 0,
    maxRecipientBalance: "",
  },
  security: {
    powDifficulty: 17,
    captcha: "none",
    captchaSiteKey: "",
    captchaSecret: "",
    blockContracts: true,
    allowlistOnly: false,
    allowedAddresses: [],
    blockedAddresses: [],
    blockedIps: [],
    holder: { enabled: false, rpcUrl: "", minBalance: "", label: "" },
    paused: false,
    pausedMessage: "",
  },
  notices: [],
  faq: [],
  website: "",
  twitter: "",
  telegram: "",
  discord: "",
  github: "",
  footerText: "",
  metaTitle: "",
  metaDescription: "",
  announcementEnabled: false,
  announcementText: "",
  announcementLink: "",
};

let cache = { mtime: 0, value: null };

function merge(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra || {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object") {
      out[key] = merge(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/** The console rewrites settings.json on every save, so it is reread whenever its mtime changes. */
export function getSettings() {
  let mtime = 0;
  try {
    mtime = statSync(SETTINGS_FILE).mtimeMs;
  } catch {
    mtime = -1;
  }
  if (cache.value && cache.mtime === mtime) return cache.value;
  let saved = {};
  if (mtime > 0) {
    try {
      saved = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
    } catch (error) {
      console.error("[settings] unreadable settings.json, keeping previous:", error.message);
      if (cache.value) return cache.value;
    }
  }
  const value = merge(DEFAULTS, saved);
  value.assets = (Array.isArray(value.assets) && value.assets.length ? value.assets : DEFAULTS.assets).map((asset) => ({
    ...asset,
    symbol: asset.type === "native" ? asset.symbol || ENV.currencySymbol : asset.symbol,
    decimals: asset.type === "native" ? 18 : Number(asset.decimals ?? 18),
  }));
  cache = { mtime, value };
  return value;
}

/** Settings safe to send to browsers: no captcha secret, allow/block lists, or holder RPC. */
export function publicSettings(settings) {
  const { security, limits, ...rest } = settings;
  return {
    ...rest,
    chain: {
      id: ENV.chainId,
      name: settings.name || ENV.chainName,
      symbol: ENV.currencySymbol,
      currencyName: ENV.currencyName,
      rpcUrl: ENV.rpcUrl,
    },
    assets: settings.assets.filter((asset) => asset.enabled).map(({ id, type, symbol, decimals, amount, address }) => ({
      id,
      type,
      symbol,
      decimals,
      amount,
      address: type === "erc20" ? address : undefined,
    })),
    limits: {
      windowHours: limits.windowHours,
      perAddress: limits.perAddress,
      perIp: limits.perIp,
      cooldownMinutes: limits.cooldownMinutes,
      maxRecipientBalance: limits.maxRecipientBalance,
    },
    security: {
      powDifficulty: security.powDifficulty,
      captcha: security.captcha,
      captchaSiteKey: security.captchaSiteKey,
      blockContracts: security.blockContracts,
      allowlistOnly: security.allowlistOnly,
      holder: security.holder.enabled
        ? { enabled: true, minBalance: security.holder.minBalance, label: security.holder.label }
        : { enabled: false },
      paused: security.paused,
      pausedMessage: security.pausedMessage,
    },
  };
}
