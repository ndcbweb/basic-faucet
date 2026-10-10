import { mkdirSync } from "node:fs";
import { isIP } from "node:net";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { getAddress, isAddress } from "viem";
import { BRANDING_DIR, ENV, getSettings, publicSettings } from "./config.js";
import { issueChallenge, verifyAdmin, verifyCaptcha, verifyPow } from "./captcha.js";
import {
  account,
  balanceOf,
  faucetBalances,
  formatUnits,
  holderBalance,
  isContract,
  parseUnits,
  publicClient,
  sendAsset,
  serialize,
} from "./chain.js";
import { adminClaims, claimCounts, claimTotals, finishClaim, globalCount, recentClaims, reserveClaim } from "./store.js";

const CAPTCHA_ORIGINS = {
  turnstile: "https://challenges.cloudflare.com",
  hcaptcha: "https://hcaptcha.com https://*.hcaptcha.com",
  recaptcha: "https://www.google.com https://www.gstatic.com https://www.recaptcha.net",
};

class ClaimError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function ipMatches(ip, rule) {
  const value = ip.replace(/^::ffff:/, "");
  if (!rule.includes("/")) return value === rule;
  const [base, bitsText] = rule.split("/");
  const bits = Number(bitsText);
  if (isIP(value) !== 4 || isIP(base) !== 4 || !(bits >= 0 && bits <= 32)) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(value) & mask) === (ipv4ToInt(base) & mask);
}

function waitText(ms) {
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  return `${hours} h${mins % 60 ? ` ${mins % 60} min` : ""}`;
}

const app = Fastify({
  // Caddy terminates TLS on the same host; only trust its forwarded IP.
  trustProxy: "127.0.0.1",
  bodyLimit: 16 * 1024,
  logger: { level: "info" },
});

app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
  request.rawBody = body;
  try {
    done(null, body ? JSON.parse(body) : {});
  } catch {
    done(Object.assign(new Error("Invalid JSON"), { statusCode: 400 }));
  }
});

app.addHook("onSend", async (request, reply, payload) => {
  const captcha = CAPTCHA_ORIGINS[getSettings().security.captcha] || "";
  reply.header(
    "content-security-policy",
    [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline' ${captcha}`,
      `frame-src ${captcha || "'none'"}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "worker-src 'self' blob:",
      `connect-src 'self' ${captcha}`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ")
  );
  reply.header("x-content-type-options", "nosniff");
  reply.header("referrer-policy", "strict-origin-when-cross-origin");
  reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
  return payload;
});

await app.register(rateLimit, {
  global: true,
  max: 120,
  timeWindow: "1 minute",
  allowList: (request) => request.url === "/api/health",
});

app.get("/api/health", async () => {
  let head = null;
  try {
    head = Number(await publicClient.getBlockNumber());
  } catch {
    /* reported as rpcOk: false */
  }
  return { ok: true, rpcOk: head != null, head, chainId: ENV.chainId, address: account.address };
});

app.get("/api/config", async () => ({ ...publicSettings(getSettings()), address: account.address }));

app.get("/api/status", async () => {
  const settings = getSettings();
  return {
    address: account.address,
    balances: await faucetBalances(settings.assets.filter((asset) => asset.enabled)),
    claims: claimTotals(),
  };
});

app.get("/api/recent", async () => ({ claims: recentClaims(12) }));

app.get("/api/challenge", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async () =>
  issueChallenge(getSettings().security.powDifficulty)
);

app.post(
  "/api/claim",
  { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } },
  async (request, reply) => {
    const settings = getSettings();
    const { security, limits } = settings;
    const body = request.body || {};
    const ip = request.ip;

    try {
      if (security.paused) throw new ClaimError(security.pausedMessage || "The faucet is paused. Try again later.", 503);
      // Hidden form field that real visitors never fill in.
      if (body.website) throw new ClaimError("Request rejected");

      const rawAddress = String(body.address || "").trim();
      if (!isAddress(rawAddress, { strict: false })) throw new ClaimError("Enter a valid 0x wallet address");
      const address = getAddress(rawAddress);
      const key = address.toLowerCase();

      const asset = settings.assets.find((item) => item.enabled && item.id === String(body.asset || "native"));
      if (!asset) throw new ClaimError("Select a token");

      const powError = verifyPow(body.pow, security.powDifficulty);
      if (powError) throw new ClaimError(powError);
      const captchaError = await verifyCaptcha(security, body.captchaToken, ip);
      if (captchaError) throw new ClaimError(captchaError);

      if (security.blockedIps.some((rule) => ipMatches(ip, rule))) throw new ClaimError("Requests from your network are blocked", 403);
      if (security.blockedAddresses.includes(key)) throw new ClaimError("This address is blocked", 403);
      if (security.allowlistOnly && !security.allowedAddresses.includes(key)) {
        throw new ClaimError("This faucet only serves approved addresses", 403);
      }
      if (address.toLowerCase() === account.address.toLowerCase()) throw new ClaimError("Enter your own wallet address");

      if (security.blockContracts && (await isContract(address).catch(() => false))) {
        throw new ClaimError("Contract addresses cannot claim, use a wallet address");
      }
      if (limits.maxRecipientBalance) {
        const max = parseUnits(String(limits.maxRecipientBalance), 18);
        const current = await publicClient.getBalance({ address }).catch(() => 0n);
        if (current >= max) {
          throw new ClaimError(
            `Your wallet already holds ${formatUnits(current, 18)} ${ENV.currencySymbol}. The faucet only tops up wallets below ${limits.maxRecipientBalance} ${ENV.currencySymbol}.`
          );
        }
      }
      if (security.holder.enabled && security.holder.rpcUrl && security.holder.minBalance) {
        const need = parseUnits(String(security.holder.minBalance), 18);
        const held = await holderBalance(security.holder.rpcUrl, address).catch(() => null);
        if (held == null) throw new ClaimError("Could not check your balance right now, try again", 503);
        if (held < need) {
          throw new ClaimError(`You need at least ${security.holder.minBalance} ${security.holder.label || "on mainnet"} to use this faucet`, 403);
        }
      }

      const result = await serialize(async () => {
        const windowMs = Math.max(1, Number(limits.windowHours) || 24) * 3600_000;
        const since = Date.now() - windowMs;
        const counts = claimCounts({ address: key, ip, since });
        if (limits.perAddress > 0 && counts.address >= limits.perAddress) {
          throw new ClaimError(`This address already claimed. Try again in ${waitText(counts.addressLast + windowMs - Date.now())}.`, 429);
        }
        if (limits.perIp > 0 && counts.ip >= limits.perIp) {
          throw new ClaimError(`Your network reached its limit. Try again in ${waitText(counts.ipLast + windowMs - Date.now())}.`, 429);
        }
        const cooldownMs = Number(limits.cooldownMinutes || 0) * 60_000;
        const last = Math.max(counts.addressLast, counts.ipLast);
        if (cooldownMs && last && Date.now() - last < cooldownMs) {
          throw new ClaimError(`Please wait ${waitText(last + cooldownMs - Date.now())} before the next claim.`, 429);
        }
        if (limits.globalPerWindow > 0 && globalCount(since) >= limits.globalPerWindow) {
          throw new ClaimError("The faucet reached its daily limit. Try again later.", 429);
        }

        const claimId = reserveClaim({ address: key, ip, asset: asset.id, symbol: asset.symbol, amount: String(asset.amount) });
        try {
          const txHash = await sendAsset(asset, address, asset.amount);
          finishClaim(claimId, { status: "sent", txHash });
          return { txHash };
        } catch (error) {
          finishClaim(claimId, { status: "failed", error: error?.shortMessage || error?.message });
          if (error instanceof ClaimError || error?.statusCode) throw error;
          request.log.error({ err: error }, "send failed");
          throw new ClaimError("The transaction could not be sent. Try again in a minute.", 502);
        }
      });

      return { ok: true, txHash: result.txHash, amount: String(asset.amount), symbol: asset.symbol };
    } catch (error) {
      if (!(error instanceof ClaimError) && !error?.statusCode) request.log.error({ err: error }, "claim failed");
      return reply.code(error.statusCode || 500).send({ ok: false, error: error.message || "Request failed" });
    }
  }
);

async function requireAdmin(request, reply) {
  if (!verifyAdmin(request, request.rawBody)) {
    reply.code(401).send({ ok: false, error: "Unauthorized" });
  }
}

app.get("/api/admin/claims", { preHandler: requireAdmin }, async (request) => ({
  ok: true,
  claims: adminClaims(Number(request.query?.limit) || 100),
  totals: claimTotals(),
}));

app.post("/api/admin/withdraw", { preHandler: requireAdmin }, async (request, reply) => {
  const settings = getSettings();
  const { to, assetId, amount } = request.body || {};
  if (!isAddress(String(to || ""), { strict: false })) return reply.code(400).send({ ok: false, error: "Enter a valid 0x address" });
  const asset = settings.assets.find((item) => item.id === String(assetId || "native"));
  if (!asset) return reply.code(400).send({ ok: false, error: "Unknown asset" });
  try {
    const txHash = await serialize(async () => {
      let value = String(amount || "").trim();
      if (value === "max") {
        const balance = await balanceOf(asset, account.address);
        let spendable = balance;
        if (asset.type === "native") {
          const gasPrice = await publicClient.getGasPrice();
          spendable = balance - gasPrice * 2n * 21000n;
        }
        if (spendable <= 0n) throw Object.assign(new Error("Nothing to withdraw"), { statusCode: 400 });
        value = formatUnits(spendable, asset.decimals);
      }
      if (!/^\d+(\.\d+)?$/.test(value)) throw Object.assign(new Error("Enter an amount"), { statusCode: 400 });
      return sendAsset(asset, getAddress(to), value);
    });
    return { ok: true, txHash };
  } catch (error) {
    return reply.code(error.statusCode || 502).send({ ok: false, error: error.shortMessage || error.message || "Withdraw failed" });
  }
});

mkdirSync(BRANDING_DIR, { recursive: true });
await app.register(fastifyStatic, {
  root: BRANDING_DIR,
  prefix: "/branding/",
  decorateReply: false,
  allowedPath: (path) => /^\/?(logo|favicon)\.(png|jpg|svg|webp|ico|gif)$/.test(path),
  maxAge: 300_000,
});

await app.register(fastifyStatic, { root: ENV.webDir, prefix: "/", wildcard: false });
app.setNotFoundHandler((request, reply) => {
  if (/^\/(api|branding)\//.test(request.url)) return reply.code(404).send({ ok: false, error: "Not found" });
  return reply.sendFile("index.html");
});

await app.listen({ port: ENV.port, host: "0.0.0.0" });
app.log.info(`Faucet ${account.address} on chain ${ENV.chainId}`);
