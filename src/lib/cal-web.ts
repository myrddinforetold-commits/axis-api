export interface CalWebSnippet {
  title: string;
  url: string;
  snippet: string;
}

export interface CalWebContext {
  query: string;
  source: 'brave' | 'duckduckgo';
  searched_at: string;
  snippets: CalWebSnippet[];
}

const CAL_WEB_SEARCH_ENABLED = String(process.env.CAL_WEB_SEARCH_ENABLED || 'true').toLowerCase() !== 'false';
const CAL_BRAVE_API_KEY = process.env.CAL_BRAVE_API_KEY || process.env.BRAVE_API_KEY || '';
const CAL_WEB_TIMEOUT_MS = Math.max(1000, Number(process.env.CAL_WEB_TIMEOUT_MS || 3500));
const CAL_WEB_MAX_SNIPPETS = Math.max(1, Math.min(6, Number(process.env.CAL_WEB_MAX_SNIPPETS || 4)));

function nowIso(): string {
  return new Date().toISOString();
}

function shouldSearchWeb(message: string): boolean {
  const text = message.toLowerCase();
  return [
    'latest',
    'today',
    'news',
    'current',
    'recent',
    'just happened',
    'what happened',
    'search',
    'look up',
    'find online',
    'on the internet',
    'web',
    'x.com',
    'twitter',
    'price',
    'market',
    'stocks',
    'crypto',
  ].some((keyword) => text.includes(keyword));
}

async function fetchJsonWithTimeout<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });

    if (!response.ok) {
      const details = (await response.text()).slice(0, 400);
      throw new Error(`HTTP ${response.status}: ${details}`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

interface BraveSearchResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveSearchResult[];
  };
}

async function searchWithBrave(query: string): Promise<CalWebContext | null> {
  if (!CAL_BRAVE_API_KEY) return null;

  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${CAL_WEB_MAX_SNIPPETS}&spellcheck=0`;
  const body = await fetchJsonWithTimeout<BraveSearchResponse>(
    url,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': CAL_BRAVE_API_KEY,
      },
    },
    CAL_WEB_TIMEOUT_MS,
  );

  const snippets: CalWebSnippet[] = (body.web?.results || [])
    .map((item) => ({
      title: String(item.title || '').trim(),
      url: String(item.url || '').trim(),
      snippet: String(item.description || '').trim(),
    }))
    .filter((item) => item.title && item.url)
    .slice(0, CAL_WEB_MAX_SNIPPETS);

  if (snippets.length === 0) return null;

  return {
    query,
    source: 'brave',
    searched_at: nowIso(),
    snippets,
  };
}

interface DuckRelatedTopic {
  Text?: string;
  FirstURL?: string;
  Topics?: DuckRelatedTopic[];
}

interface DuckResponse {
  Heading?: string;
  AbstractText?: string;
  AbstractURL?: string;
  RelatedTopics?: DuckRelatedTopic[];
}

function flattenDuckTopics(topics: DuckRelatedTopic[]): DuckRelatedTopic[] {
  const out: DuckRelatedTopic[] = [];
  for (const topic of topics) {
    if (Array.isArray(topic.Topics)) {
      out.push(...flattenDuckTopics(topic.Topics));
    } else {
      out.push(topic);
    }
  }
  return out;
}

async function searchWithDuckDuckGo(query: string): Promise<CalWebContext | null> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const body = await fetchJsonWithTimeout<DuckResponse>(
    url,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    },
    CAL_WEB_TIMEOUT_MS,
  );

  const snippets: CalWebSnippet[] = [];
  if (body.AbstractText && body.AbstractURL) {
    snippets.push({
      title: body.Heading || query,
      url: body.AbstractURL,
      snippet: body.AbstractText,
    });
  }

  const related = flattenDuckTopics(body.RelatedTopics || []);
  for (const item of related) {
    if (snippets.length >= CAL_WEB_MAX_SNIPPETS) break;
    const title = String(item.Text || '').trim();
    const link = String(item.FirstURL || '').trim();
    if (!title || !link) continue;
    snippets.push({
      title,
      url: link,
      snippet: title,
    });
  }

  if (snippets.length === 0) return null;

  return {
    query,
    source: 'duckduckgo',
    searched_at: nowIso(),
    snippets: snippets.slice(0, CAL_WEB_MAX_SNIPPETS),
  };
}

async function searchWithJinaDuckDuckGo(query: string): Promise<CalWebContext | null> {
  const url = `https://r.jina.ai/http://duckduckgo.com/?q=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CAL_WEB_TIMEOUT_MS + 1000);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'text/plain' },
      signal: controller.signal,
    });

    if (!response.ok) return null;
    const text = await response.text();
    const links = [...text.matchAll(/\[([^\]]{3,180})\]\((https?:\/\/[^)\s]+)\)/g)];

    const snippets: CalWebSnippet[] = [];
    const seen = new Set<string>();
    for (const match of links) {
      if (snippets.length >= CAL_WEB_MAX_SNIPPETS) break;
      const title = (match[1] || '').trim().replace(/\s+/g, ' ');
      const targetUrl = (match[2] || '').trim();
      const lowerUrl = targetUrl.toLowerCase();

      if (!title || !targetUrl) continue;
      if (lowerUrl.includes('duckduckgo.com')) continue;
      if (lowerUrl.includes('external-content.duckduckgo.com')) continue;
      if (lowerUrl.endsWith('.ico')) continue;
      if (lowerUrl.includes('/y.js?')) continue;

      const key = targetUrl.split('#')[0];
      if (seen.has(key)) continue;
      seen.add(key);

      snippets.push({
        title,
        url: targetUrl,
        snippet: title,
      });
    }

    if (snippets.length === 0) return null;
    return {
      query,
      source: 'duckduckgo',
      searched_at: nowIso(),
      snippets,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function maybeFetchCalWebContext(message: string): Promise<CalWebContext | null> {
  if (!CAL_WEB_SEARCH_ENABLED) return null;
  if (!shouldSearchWeb(message)) return null;

  const query = message.trim();
  if (!query) return null;

  try {
    const brave = await searchWithBrave(query);
    if (brave) return brave;
  } catch {
    // Continue to fallback source.
  }

  try {
    const ddg = await searchWithDuckDuckGo(query);
    if (ddg) return ddg;
  } catch {
    // Continue to next fallback source.
  }

  try {
    return await searchWithJinaDuckDuckGo(query);
  } catch {
    return null;
  }
}

export function renderCalWebContext(context: CalWebContext): string {
  const lines: string[] = [
    `Web search source: ${context.source}`,
    `Searched at: ${context.searched_at}`,
    `Query: ${context.query}`,
  ];

  for (const item of context.snippets) {
    lines.push(`- ${item.title}`);
    lines.push(`  URL: ${item.url}`);
    if (item.snippet) {
      lines.push(`  Snippet: ${item.snippet}`);
    }
  }

  return lines.join('\n');
}
