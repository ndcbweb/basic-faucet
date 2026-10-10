import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ENV } from "./config.js";
import { consumeToken } from "./store.js";

const CHALLENGE_TTL_MS = 5 * 60_000;

const sign = (text) => createHmac("sha256", ENV.secret).update(text).digest("hex");

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Proof-of-work challenge: the browser must find a nonce so sha256(salt + nonce) starts with `difficulty` zero bits. */
export function issueChallenge(difficulty) {
  const expires = Date.now() + CHALLENGE_TTL_MS;
  const salt = `${randomBytes(16).toString("hex")}.${expires}`;
  return { salt, difficulty, expires, signature: sign(`${salt}|${difficulty}`) };
}

function leadingZeroBits(buffer) {
  let bits = 0;
  for (const byte of buffer) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

export function verifyPow(pow, requiredDifficulty) {
  if (!requiredDifficulty) return null;
  if (!pow || typeof pow !== "object") return "Complete the verification first";
  const { salt, difficulty, signature, nonce } = pow;
  if (typeof salt !== "string" || !/^[0-9a-f]{32}\.\d{13}$/.test(salt)) return "Verification is invalid, try again";
  if (Number(difficulty) !== requiredDifficulty || !safeEqual(signature, sign(`${salt}|${difficulty}`))) {
    return "Verification is invalid, try again";
  }
  const expires = Number(salt.split(".")[1]);
  if (expires < Date.now()) return "Verification expired, try again";
  if (!/^\d{1,16}$/.test(String(nonce))) return "Verification is invalid, try again";
  const hash = createHash("sha256").update(`${salt}${nonce}`).digest();
  if (leadingZeroBits(hash) < requiredDifficulty) return "Verification is invalid, try again";
  if (!consumeToken(`pow:${salt}`, expires)) return "Verification was already used, try again";
  return null;
}

const VERIFY_URLS = {
  turnstile: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
  hcaptcha: "https://api.hcaptcha.com/siteverify",
  recaptcha: "https://www.google.com/recaptcha/api/siteverify",
};

export async function verifyCaptcha(security, token, ip) {
  const url = VERIFY_URLS[security.captcha];
  if (!url || !security.captchaSecret) return null;
  if (!token || typeof token !== "string" || token.length > 4096) return "Complete the captcha first";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: security.captchaSecret, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => null);
    return data?.success ? null : "Captcha failed, try again";
  } catch {
    return "Captcha service did not respond, try again";
  }
}

/** Console admin calls carry an HMAC over timestamp, method, path and body, valid for 60 s and only once. */
export function verifyAdmin(request, rawBody) {
  const ts = Number(request.headers["x-faucet-ts"]);
  const sig = String(request.headers["x-faucet-sig"] || "");
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 60_000) return false;
  const path = request.url.split("?")[0];
  const expected = sign(`${ts}.${request.method}.${path}.${rawBody || ""}`);
  if (!safeEqual(sig, expected)) return false;
  return consumeToken(`admin:${sig}`, ts + 120_000);
}
