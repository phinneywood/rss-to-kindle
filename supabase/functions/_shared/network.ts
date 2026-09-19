import ipaddr from "npm:ipaddr.js@2.2.0";

// Allow only globally routable unicast addresses, including embedded IPv4.
export function isPublicAddress(value: string): boolean {
  try {
    const address = ipaddr.process(value.replace(/^\[|\]$/g, ""));
    return address.range() === "unicast";
  } catch { return false; }
}

export async function assertPublic(url: URL) {
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Only public http(s) URLs are allowed.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || /\.(localhost|local|internal)$/.test(host)) throw new Error("Private network URLs are not allowed.");
  if (ipaddr.isValid(host)) {
    if (!isPublicAddress(host)) throw new Error("Private network URLs are not allowed.");
    return;
  }
  const results = await Promise.all([Deno.resolveDns(host, "A").catch(() => []), Deno.resolveDns(host, "AAAA").catch(() => [])]);
  const addresses = results.flat();
  if (!addresses.length || addresses.some(ip => !isPublicAddress(ip))) throw new Error("The host did not resolve to a public address.");
}

export async function readLimited(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length") || 0) > maxBytes) {
    await response.body?.cancel();
    throw new Error("The response is too large.");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("The response is too large.");
      chunks.push(value);
    }
  } finally { signal?.removeEventListener("abort", cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
  signal?.throwIfAborted();
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

export async function fetchPublic(input: string, options: { accept: string; maxBytes: number; timeoutMs?: number; deadline?: number }) {
  const controller = new AbortController();
  const duration = Math.min(options.timeoutMs || 12_000, (options.deadline ?? Infinity) - Date.now());
  if (duration <= 0) throw new Error("Article preparation time limit reached.");
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("The publisher took too long to respond.")); }, duration);
  });
  const operation = async () => {
    let url = new URL(input);
    for (let redirects = 0; redirects < 5; redirects++) {
      await assertPublic(url);
      controller.signal.throwIfAborted();
      const response = await fetch(url, { redirect: "manual", signal: controller.signal, headers: { Accept: options.accept, "User-Agent": "MorningReader/2.1 (+https://reader.antonioskilton.com)" } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error("The publisher returned an invalid redirect.");
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`The publisher returned HTTP ${response.status}.`);
      }
      return { response, bytes: await readLimited(response, options.maxBytes, controller.signal), url: url.toString() };
    }
    throw new Error("The publisher redirected too many times.");
  };
  try { return await Promise.race([operation(), timeout]); }
  finally { clearTimeout(timer!); }
}

export async function fetchPublicText(input: string, accept: string, maxBytes: number, deadline?: number) {
  const fetched = await fetchPublic(input, { accept, maxBytes, deadline });
  return { text: new TextDecoder().decode(fetched.bytes), url: fetched.url, response: fetched.response };
}
