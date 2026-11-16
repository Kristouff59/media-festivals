// BACKSTAGE v2 — lecture bornée et sûre d'une page Web.
// - suit les redirections (5 au plus), en revalidant chaque destination ;
// - lit au plus `maxBytes` octets puis TRONQUE au lieu de rejeter la page ;
// - n'accepte que des hôtes publics en HTTPS (protection SSRF).

export interface FetchedPage {
  ok: boolean;
  status: number;
  url: string;
  finalUrl: string;
  redirects: string[];
  contentType: string;
  html: string;
  bytes: number;
  truncated: boolean;
  error?: string; // motif lisible si ok === false
  transient?: boolean; // vrai si un nouvel essai a du sens
}

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export function isPublicHttpsUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    const h = u.hostname.toLowerCase();
    if (u.protocol !== "https:" || u.username || u.password) return false;
    if (u.port && u.port !== "443") return false;
    if (!h.includes(".") || h.endsWith(".local") || h.endsWith(".internal") || h === "localhost") return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith("[") || h.includes(":")) return false;
    return true;
  } catch {
    return false;
  }
}

function charsetOf(contentType: string): string {
  const m = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType);
  const c = (m?.[1] || "utf-8").toLowerCase();
  return ["iso-8859-1", "latin1", "windows-1252"].includes(c) ? "windows-1252" : "utf-8";
}

export async function fetchPage(
  url: string,
  opts: { fetchImpl?: FetchImpl; maxBytes?: number; timeoutMs?: number; maxRedirects?: number; userAgent?: string } = {},
): Promise<FetchedPage> {
  const fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const maxBytes = opts.maxBytes ?? 3_000_000;
  const maxRedirects = opts.maxRedirects ?? 5;
  const redirects: string[] = [];
  const fail = (error: string, status = 0, transient = false, current = url): FetchedPage => ({
    ok: false, status, url, finalUrl: current, redirects, contentType: "", html: "", bytes: 0,
    truncated: false, error, transient,
  });

  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!isPublicHttpsUrl(current)) return fail("url_non_autorisee", 0, false, current);
    let res: Response;
    try {
      res = await fetchImpl(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 12000),
        headers: {
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "Accept-Language": "fr,en;q=0.9,nl;q=0.7,de;q=0.6",
          "User-Agent": opts.userAgent ?? "Mozilla/5.0 (compatible; BACKSTAGE-verification/2.0)",
        },
      });
    } catch (e) {
      const msg = String((e as Error)?.name || e);
      return fail(/timeout|abort/i.test(msg) ? "delai_depasse" : "reseau_injoignable", 0, true, current);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return fail("redirection_sans_destination", res.status, false, current);
      current = new URL(loc, current).toString();
      redirects.push(current);
      continue;
    }
    const contentType = res.headers.get("content-type") || "";
    if (!res.ok) {
      const transient = res.status === 429 || res.status >= 500 || res.status === 403;
      return fail("http_" + res.status, res.status, transient, current);
    }
    if (contentType && !/html|xml/i.test(contentType)) return fail("contenu_non_html", res.status, false, current);

    // Lecture en flux, tronquée à maxBytes : une page lourde reste exploitable.
    let bytes = 0, truncated = false;
    const chunks: Uint8Array[] = [];
    if (res.body) {
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (bytes + value.byteLength > maxBytes) {
          chunks.push(value.subarray(0, maxBytes - bytes));
          bytes = maxBytes;
          truncated = true;
          await reader.cancel().catch(() => {});
          break;
        }
        chunks.push(value);
        bytes += value.byteLength;
      }
    }
    const all = new Uint8Array(bytes);
    let offset = 0;
    for (const c of chunks) { all.set(c, offset); offset += c.byteLength; }
    const html = new TextDecoder(charsetOf(contentType), { fatal: false }).decode(all);
    return { ok: true, status: res.status, url, finalUrl: current, redirects, contentType, html, bytes, truncated };
  }
  return fail("trop_de_redirections", 0, false, current);
}
