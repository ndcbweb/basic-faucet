"use client";

import { useEffect, useRef } from "react";

const PROVIDERS = {
  turnstile: { src: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit", global: "turnstile" },
  hcaptcha: { src: "https://js.hcaptcha.com/1/api.js?render=explicit", global: "hcaptcha" },
  recaptcha: { src: "https://www.google.com/recaptcha/api.js?render=explicit", global: "grecaptcha" },
};

const loading = {};

function loadScript(provider) {
  const meta = PROVIDERS[provider];
  if (!loading[provider]) {
    loading[provider] = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = meta.src;
      script.async = true;
      script.onerror = () => reject(new Error("Captcha failed to load"));
      script.onload = () => {
        const started = Date.now();
        const wait = () => {
          const api = window[meta.global];
          if (api?.render) resolve(api);
          else if (Date.now() - started > 10_000) reject(new Error("Captcha failed to load"));
          else setTimeout(wait, 100);
        };
        wait();
      };
      document.head.appendChild(script);
    });
  }
  return loading[provider];
}

/** Third-party captcha widget; remount (change key) to reset after a claim. */
export function Captcha({ provider, siteKey, theme, onToken }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!PROVIDERS[provider] || !siteKey) return undefined;
    let alive = true;
    loadScript(provider)
      .then((api) => {
        if (!alive || !ref.current) return;
        ref.current.innerHTML = "";
        api.render(ref.current, {
          sitekey: siteKey,
          theme,
          callback: (token) => onToken(token),
          "expired-callback": () => onToken(""),
          "error-callback": () => onToken(""),
        });
      })
      .catch(() => onToken(""));
    return () => {
      alive = false;
    };
  }, [provider, siteKey, theme, onToken]);

  if (!PROVIDERS[provider] || !siteKey) return null;
  return <div ref={ref} className="flex min-h-[65px] justify-center" />;
}
