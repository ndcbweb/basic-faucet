/**
 * Proof-of-work solver run in a Web Worker. Plain-JS SHA-256 because crypto.subtle is missing on
 * plain-http origins (a faucet before SSL is active) and is slower for millions of tiny hashes.
 */
const WORKER_SOURCE = `
const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
const w = new Uint32Array(64);
function firstWord(msg) {
  const l = msg.length, blocks = ((l + 8) >> 6) + 1, W = new Uint32Array(blocks * 16);
  for (let i = 0; i < l; i++) W[i >> 2] |= msg.charCodeAt(i) << (24 - (i & 3) * 8);
  W[l >> 2] |= 0x80 << (24 - (l & 3) * 8);
  W[blocks * 16 - 1] = l * 8;
  let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
  for (let blk = 0; blk < blocks; blk++) {
    for (let t = 0; t < 16; t++) w[t] = W[blk * 16 + t];
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15], y = w[t - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[t] + w[t]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0=(h0+a)|0;h1=(h1+b)|0;h2=(h2+c)|0;h3=(h3+d)|0;h4=(h4+e)|0;h5=(h5+f)|0;h6=(h6+g)|0;h7=(h7+h)|0;
  }
  return h0 >>> 0;
}
onmessage = (event) => {
  const { salt, difficulty } = event.data;
  for (let nonce = 0; ; nonce++) {
    if (Math.clz32(firstWord(salt + nonce)) >= difficulty) {
      postMessage({ nonce: String(nonce) });
      return;
    }
    if ((nonce & 0x3ffff) === 0 && nonce) postMessage({ progress: nonce });
  }
};
`;

export function solveChallenge(challenge, onProgress) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
    const worker = new Worker(url);
    const expected = 2 ** challenge.difficulty;
    worker.onmessage = (event) => {
      if (event.data.progress != null) {
        onProgress?.(Math.min(95, Math.round((event.data.progress / expected) * 100)));
        return;
      }
      worker.terminate();
      URL.revokeObjectURL(url);
      resolve({ ...challenge, nonce: event.data.nonce });
    };
    worker.onerror = (error) => {
      worker.terminate();
      URL.revokeObjectURL(url);
      reject(error);
    };
    worker.postMessage({ salt: challenge.salt, difficulty: challenge.difficulty });
  });
}
