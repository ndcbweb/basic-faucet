import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  http,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ENV } from "./config.js";

export const chain = defineChain({
  id: ENV.chainId,
  name: ENV.chainName,
  nativeCurrency: { name: ENV.currencyName, symbol: ENV.currencySymbol, decimals: 18 },
  rpcUrls: { default: { http: [ENV.rpcUrl] } },
});

const transport = http(ENV.rpcUrl, { timeout: 15_000, retryCount: 1 });
export const publicClient = createPublicClient({ chain, transport });
export const account = privateKeyToAccount(ENV.privateKey);
const walletClient = createWalletClient({ account, chain, transport });

let queue = Promise.resolve();

/** Runs fn after every earlier call has settled, so limit checks and nonces never race. */
export function serialize(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

export async function balanceOf(asset, owner) {
  if (asset.type === "erc20") {
    return publicClient.readContract({ address: asset.address, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
  }
  return publicClient.getBalance({ address: owner });
}

export async function faucetBalances(assets) {
  return Promise.all(
    assets.map(async (asset) => {
      try {
        const raw = await balanceOf(asset, account.address);
        const amount = parseUnits(String(asset.amount || "0"), asset.decimals);
        return {
          id: asset.id,
          symbol: asset.symbol,
          balance: formatUnits(raw, asset.decimals),
          claimsLeft: amount > 0n ? (raw / amount).toString() : null,
        };
      } catch {
        return { id: asset.id, symbol: asset.symbol, balance: null, claimsLeft: null };
      }
    })
  );
}

export async function isContract(address) {
  const code = await publicClient.getCode({ address });
  return Boolean(code && code !== "0x");
}

export async function sendAsset(asset, to, amountText) {
  const amount = parseUnits(String(amountText), asset.decimals);
  if (amount <= 0n) throw Object.assign(new Error("Drip amount is not set"), { statusCode: 503 });
  const balance = await balanceOf(asset, account.address);
  if (balance < amount) throw Object.assign(new Error(`The faucet is out of ${asset.symbol}. Try again later.`), { statusCode: 503 });

  const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
  if (asset.type === "erc20") {
    return walletClient.sendTransaction({
      to: asset.address,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }),
      nonce,
    });
  }
  return walletClient.sendTransaction({ to, value: amount, nonce });
}

/** Balance on a second chain (e.g. mainnet) for "hold X to use the faucet" checks. */
export async function holderBalance(rpcUrl, address) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json();
  if (typeof data?.result !== "string") throw new Error("bad response");
  return BigInt(data.result);
}

export { formatUnits, parseUnits };
