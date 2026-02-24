import { Type } from "@sinclair/typebox";
import { formatCliCommand } from "../../cli/command-format.js";
import type { OpenClawConfig } from "../../config/config.js";
import { wrapWebContent } from "../../security/external-content.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import {
  CacheEntry,
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  withTimeout,
  writeCache,
} from "./web-shared.js";

const SEARCH_PROVIDERS = ["brave", "perplexity", "grok", "baidu"] as const;
const DEFAULT_SEARCH_COUNT = 5;
const MAX_SEARCH_COUNT = 10;

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const BAIDU_SEARCH_ENDPOINT = "https://www.baidu.com/s";
const BAIDU_QIANFAN_API_ENDPOINT = "https://qianfan.baidubce.com/v2/ai_search/web_summary"; // 智能搜索生成（高性能版）
const BAIDU_CHAT_COMPLETIONS_ENDPOINT = "https://qianfan.baidubce.com/v2/ai_search/chat/completions"; // 智能搜索生成
const BAIDU_WEB_SEARCH_ENDPOINT = "https://qianfan.baidubce.com/v2/ai_search/web_search"; // 百度搜索
const DEFAULT_PERPLEXITY_BASE_URL = "https://openrouter.ai/api/v1";
const PERPLEXITY_DIRECT_BASE_URL = "https://api.perplexity.ai";
const DEFAULT_PERPLEXITY_MODEL = "perplexity/sonar-pro";
const PERPLEXITY_KEY_PREFIXES = ["pplx-"];
const OPENROUTER_KEY_PREFIXES = ["sk-or-"];

const XAI_API_ENDPOINT = "https://api.x.ai/v1/responses";
const DEFAULT_GROK_MODEL = "grok-4-1-fast";

// 百度搜索API默认配置
const DEFAULT_BAIDU_API_KEY = "";

const SEARCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();
const BRAVE_FRESHNESS_SHORTCUTS = new Set(["pd", "pw", "pm", "py"]);
const BRAVE_FRESHNESS_RANGE = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/;

const WebSearchSchema = Type.Object({
  query: Type.String({ description: "Search query string." }),
  count: Type.Optional(
    Type.Number({
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: MAX_SEARCH_COUNT,
    }),
  ),
  country: Type.Optional(
    Type.String({
      description:
        "2-letter country code for region-specific results (e.g., 'DE', 'US', 'ALL'). Default: 'US'.",
    }),
  ),
  search_lang: Type.Optional(
    Type.String({
      description: "ISO language code for search results (e.g., 'de', 'en', 'fr').",
    }),
  ),
  ui_lang: Type.Optional(
    Type.String({
      description: "ISO language code for UI elements.",
    }),
  ),
  freshness: Type.Optional(
    Type.String({
      description:
        "Filter results by discovery time. Brave supports 'pd', 'pw', 'pm', 'py', and date range 'YYYY-MM-DDtoYYYY-MM-DD'. Perplexity supports 'pd', 'pw', 'pm', and 'py'.",
    }),
  ),
  baiduSearchType: Type.Optional(
    Type.String({
      description:
        "Baidu search API type: 'intelligent' (高性能版), 'chat_completions' (智能搜索生成), 'web_search' (百度搜索).",
    }),
  ),
});

type WebSearchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { search?: infer Search }
    ? Search
    : undefined
  : undefined;

type BraveSearchResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
};

type BraveSearchResponse = {
  web?: {
    results?: BraveSearchResult[];
  };
};

type PerplexityConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

type PerplexityApiKeySource = "config" | "perplexity_env" | "openrouter_env" | "none";

type GrokConfig = {
  apiKey?: string;
  model?: string;
  inlineCitations?: boolean;
};

type GrokSearchResponse = {
  output?: Array<{
    type?: string;
    role?: string;
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{
        type?: string;
        url?: string;
        start_index?: number;
        end_index?: number;
      }>;
    }>;
  }>;
  output_text?: string; // deprecated field - kept for backwards compatibility
  citations?: string[];
  inline_citations?: Array<{
    start_index: number;
    end_index: number;
    url: string;
  }>;
};

// 百度搜索请求类型
type BaiduSearchType = 'intelligent' | 'chat_completions' | 'web_search';

// 百度搜索API响应类型
type BaiduSearchResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
  siteName?: string;
};

// 百度搜索API通用请求参数
type BaiduSearchParams = {
  query: string;
  apiKey: string;
  count: number;
  timeoutSeconds: number;
  freshness?: string;
  searchType?: BaiduSearchType;
  model?: string;
};

type PerplexitySearchResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  citations?: string[];
};

type PerplexityBaseUrlHint = "direct" | "openrouter";

function extractGrokContent(data: GrokSearchResponse): {
  text: string | undefined;
  annotationCitations: string[];
} {
  // xAI Responses API format: find the message output with text content
  for (const output of data.output ?? []) {
    if (output.type !== "message") {
      continue;
    }
    for (const block of output.content ?? []) {
      if (block.type === "output_text" && typeof block.text === "string" && block.text) {
        // Extract url_citation annotations from this content block
        const urls = (block.annotations ?? [])
          .filter((a) => a.type === "url_citation" && typeof a.url === "string")
          .map((a) => a.url as string);
        return { text: block.text, annotationCitations: [...new Set(urls)] };
      }
    }
  }
  // Fallback: deprecated output_text field
  const text = typeof data.output_text === "string" ? data.output_text : undefined;
  return { text, annotationCitations: [] };
}

function resolveSearchConfig(cfg?: OpenClawConfig): WebSearchConfig {
  const search = cfg?.tools?.web?.search;
  if (!search || typeof search !== "object") {
    return undefined;
  }
  return search as WebSearchConfig;
}

function resolveSearchEnabled(params: { search?: WebSearchConfig; sandboxed?: boolean }): boolean {
  if (typeof params.search?.enabled === "boolean") {
    return params.search.enabled;
  }
  if (params.sandboxed) {
    return true;
  }
  return true;
}

function resolveSearchApiKey(search?: WebSearchConfig): string | undefined {
  const fromConfig = 
    search && "apiKey" in search && typeof search.apiKey === "string"
      ? normalizeSecretInput(search.apiKey)
      : "";
  const fromEnv = normalizeSecretInput(process.env.BRAVE_API_KEY);
  const baiduApiKey = normalizeSecretInput(process.env.BAIDU_API_KEY);
  return fromConfig || fromEnv || baiduApiKey;
}

function missingSearchKeyPayload(provider: (typeof SEARCH_PROVIDERS)[number]) {
  if (provider === "perplexity") {
    return {
      error: "missing_perplexity_api_key",
      message:
        "web_search (perplexity) needs an API key. Set PERPLEXITY_API_KEY or OPENROUTER_API_KEY in the Gateway environment, or configure tools.web.search.perplexity.apiKey.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  if (provider === "grok") {
    return {
      error: "missing_xai_api_key",
      message:
        "web_search (grok) needs an xAI API key. Set XAI_API_KEY in the Gateway environment, or configure tools.web.search.grok.apiKey.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  if (provider === "baidu") {
    return {
      error: "baidu_search_no_api_key",
      message: "web_search (baidu) needs a Baidu Qianfan API key. Set BAIDU_API_KEY in the Gateway environment, or configure tools.web.search.apiKey.",
      docs: "https://cloud.baidu.com/doc/qianfan-api/s/wmjqtqr7w",
    };
  }
  return {
    error: "missing_brave_api_key",
    message: `web_search needs a Brave Search API key. Run \`${formatCliCommand("openclaw configure --section web")}\` to store it, or set BRAVE_API_KEY in the Gateway environment.`,
    docs: "https://docs.openclaw.ai/tools/web",
  };
}

function resolveSearchProvider(search?: WebSearchConfig): (typeof SEARCH_PROVIDERS)[number] {
  const raw = 
    search && "provider" in search && typeof search.provider === "string"
      ? search.provider.trim().toLowerCase()
      : "";
  if (raw === "perplexity") {
    return "perplexity";
  }
  if (raw === "grok") {
    return "grok";
  }
  if (raw === "baidu") {
    return "baidu";
  }
  if (raw === "brave") {
    return "brave";
  }
  return "baidu";
}

// 版本标识，用于区分修改后的代码
const WEB_SEARCH_VERSION = "1.2.0-fallback-fix";

function resolvePerplexityConfig(search?: WebSearchConfig): PerplexityConfig {
  if (!search || typeof search !== "object") {
    return {};
  }
  const perplexity = "perplexity" in search ? search.perplexity : undefined;
  if (!perplexity || typeof perplexity !== "object") {
    return {};
  }
  return perplexity as PerplexityConfig;
}

function resolvePerplexityApiKey(perplexity?: PerplexityConfig): {
  apiKey?: string;
  source: PerplexityApiKeySource;
} {
  const fromConfig = normalizeApiKey(perplexity?.apiKey);
  if (fromConfig) {
    return { apiKey: fromConfig, source: "config" };
  }

  const fromEnvPerplexity = normalizeApiKey(process.env.PERPLEXITY_API_KEY);
  if (fromEnvPerplexity) {
    return { apiKey: fromEnvPerplexity, source: "perplexity_env" };
  }

  const fromEnvOpenRouter = normalizeApiKey(process.env.OPENROUTER_API_KEY);
  if (fromEnvOpenRouter) {
    return { apiKey: fromEnvOpenRouter, source: "openrouter_env" };
  }

  return { apiKey: undefined, source: "none" };
}

function normalizeApiKey(key: unknown): string {
  return normalizeSecretInput(key);
}

function inferPerplexityBaseUrlFromApiKey(apiKey?: string): PerplexityBaseUrlHint | undefined {
  if (!apiKey) {
    return undefined;
  }
  const normalized = apiKey.toLowerCase();
  if (PERPLEXITY_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "direct";
  }
  if (OPENROUTER_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "openrouter";
  }
  return undefined;
}

function resolvePerplexityBaseUrl(
  perplexity?: PerplexityConfig,
  apiKeySource: PerplexityApiKeySource = "none",
  apiKey?: string,
): string {
  const fromConfig =
    perplexity && "baseUrl" in perplexity && typeof perplexity.baseUrl === "string"
      ? perplexity.baseUrl.trim()
      : "";
  if (fromConfig) {
    return fromConfig;
  }
  if (apiKeySource === "perplexity_env") {
    return PERPLEXITY_DIRECT_BASE_URL;
  }
  if (apiKeySource === "openrouter_env") {
    return DEFAULT_PERPLEXITY_BASE_URL;
  }
  if (apiKeySource === "config") {
    const inferred = inferPerplexityBaseUrlFromApiKey(apiKey);
    if (inferred === "direct") {
      return PERPLEXITY_DIRECT_BASE_URL;
    }
    if (inferred === "openrouter") {
      return DEFAULT_PERPLEXITY_BASE_URL;
    }
  }
  return DEFAULT_PERPLEXITY_BASE_URL;
}

function resolvePerplexityModel(perplexity?: PerplexityConfig): string {
  const fromConfig =
    perplexity && "model" in perplexity && typeof perplexity.model === "string"
      ? perplexity.model.trim()
      : "";
  return fromConfig || DEFAULT_PERPLEXITY_MODEL;
}

function isDirectPerplexityBaseUrl(baseUrl: string): boolean {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return false;
  }
  try {
    return new URL(trimmed).hostname.toLowerCase() === "api.perplexity.ai";
  } catch {
    return false;
  }
}

function resolvePerplexityRequestModel(baseUrl: string, model: string): string {
  if (!isDirectPerplexityBaseUrl(baseUrl)) {
    return model;
  }
  return model.startsWith("perplexity/") ? model.slice("perplexity/".length) : model;
}

function resolveGrokConfig(search?: WebSearchConfig): GrokConfig {
  if (!search || typeof search !== "object") {
    return {};
  }
  const grok = "grok" in search ? search.grok : undefined;
  if (!grok || typeof grok !== "object") {
    return {};
  }
  return grok as GrokConfig;
}

function resolveGrokApiKey(grok?: GrokConfig): string | undefined {
  const fromConfig = normalizeApiKey(grok?.apiKey);
  if (fromConfig) {
    return fromConfig;
  }
  const fromEnv = normalizeApiKey(process.env.XAI_API_KEY);
  return fromEnv || undefined;
}

function resolveGrokModel(grok?: GrokConfig): string {
  const fromConfig =
    grok && "model" in grok && typeof grok.model === "string" ? grok.model.trim() : "";
  return fromConfig || DEFAULT_GROK_MODEL;
}

function resolveGrokInlineCitations(grok?: GrokConfig): boolean {
  return grok?.inlineCitations === true;
}

function resolveSearchCount(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const clamped = Math.max(1, Math.min(MAX_SEARCH_COUNT, Math.floor(parsed)));
  return clamped;
}

function normalizeFreshness(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const lower = trimmed.toLowerCase();
  if (BRAVE_FRESHNESS_SHORTCUTS.has(lower)) {
    return lower;
  }

  const match = trimmed.match(BRAVE_FRESHNESS_RANGE);
  if (!match) {
    return undefined;
  }

  const [, start, end] = match;
  if (!isValidIsoDate(start) || !isValidIsoDate(end)) {
    return undefined;
  }
  if (start > end) {
    return undefined;
  }

  return `${start}to${end}`;
}

/**
 * Map normalized freshness values (pd/pw/pm/py) to Perplexity's
 * search_recency_filter values (day/week/month/year).
 */
function freshnessToPerplexityRecency(freshness: string | undefined): string | undefined {
  if (!freshness) {
    return undefined;
  }
  const map: Record<string, string> = {
    pd: "day",
    pw: "week",
    pm: "month",
    py: "year",
  };
  return map[freshness] ?? undefined;
}

/**
 * Map normalized freshness values (pd/pw/pm/py) to Baidu's
 * search_recency_filter values (week/month/semiyear/year).
 */
function freshnessToBaiduRecency(freshness: string | undefined): string | undefined {
  if (!freshness) {
    return undefined;
  }
  const map: Record<string, string> = {
    pd: "week", // 百度API最小支持最近7天
    pw: "week",
    pm: "month",
    py: "year",
  };
  return map[freshness] ?? undefined;
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return false;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function resolveSiteName(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function parseBaiduSearchResults(html: string, maxResults: number): Array<{ title?: string; url?: string; description?: string; age?: string }> {
  const results: Array<{ title?: string; url?: string; description?: string; age?: string }> = [];
  
  // 检测是否是百度验证码页面
  if (html.includes('验证码') || html.includes('验证中心') || html.includes('安全验证')) {
    return [
      {
        title: "百度安全验证",
        url: "https://www.baidu.com",
        description: "百度需要安全验证，请在浏览器中完成验证后再搜索。"
      }
    ];
  }
  
  // 清理HTML，移除多余的空白字符和注释
  const cleanedHtml = html
    .replace(/\s+/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  
  // 尝试匹配百度搜索结果的不同格式
  const resultPatterns = [
    // 标准搜索结果格式
    /<div[^>]*class=["']result["'][^>]*>.*?<h3[^>]*class=["']t["'][^>]*>.*?<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>.*?<div[^>]*class=["']c-abstract["'][^>]*>(.*?)<\/div>/gs,
    // 其他可能的格式
    /<div[^>]*class=["']result-op["'][^>]*>.*?<h3[^>]*class=["']t["'][^>]*>.*?<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>.*?<div[^>]*class=["']c-abstract["'][^>]*>(.*?)<\/div>/gs,
    // 更通用的格式
    /<div[^>]*class=["']c-container["'][^>]*>.*?<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>.*?<div[^>]*class=["']c-abstract["'][^>]*>(.*?)<\/div>/gs,
    // 简化的格式
    /<h3[^>]*class=["']t["'][^>]*>.*?<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>.*?<div[^>]*class=["']c-abstract["'][^>]*>(.*?)<\/div>/gs,
    // 最通用的格式
    /<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>.*?<div[^>]*class=["']c-abstract["'][^>]*>(.*?)<\/div>/gs
  ];
  
  // 调试：输出清理后的HTML的前500个字符
  console.log('清理后的HTML预览:', cleanedHtml.substring(0, 500));
  
  for (const pattern of resultPatterns) {
    let match;
    while ((match = pattern.exec(cleanedHtml)) !== null && results.length < maxResults) {
      const [, url, titleHtml, descHtml] = match;
      
      // 清理HTML标签
      const title = titleHtml.replace(/<[^>]*>/g, '').trim();
      const description = descHtml.replace(/<[^>]*>/g, '').trim();
      
      if (title && url) {
        // 处理百度URL
        let processedUrl = url;
        if (processedUrl.includes('/url?q=')) {
          processedUrl = decodeURIComponent(processedUrl.replace(/\/url\?q=/, '').split('&')[0]);
        }
        
        // 调试：输出找到的结果
        console.log('找到搜索结果:', { title, url: processedUrl, description });
        
        results.push({
          title,
          url: processedUrl,
          description
        });
      }
    }
  }
  
  // 如果没有找到结果，返回模拟数据
  if (results.length === 0) {
    // 调试：输出未找到结果的原因
    console.log('未找到百度搜索结果，返回默认消息');
    return [
      {
        title: "百度搜索结果",
        url: "https://www.baidu.com",
        description: "无法解析百度搜索结果，请在浏览器中查看。"
      }
    ];
  }
  
  return results;
}

async function runPerplexitySearch(params: {
  query: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
  freshness?: string;
}): Promise<{ content: string; citations: string[] }> {
  const baseUrl = params.baseUrl.trim().replace(/\/$/, "");
  const endpoint = `${baseUrl}/chat/completions`;
  const model = resolvePerplexityRequestModel(baseUrl, params.model);

  const body: Record<string, unknown> = {
    model,
    messages: [
      {
        role: "user",
        content: params.query,
      },
    ],
  };

  const recencyFilter = freshnessToPerplexityRecency(params.freshness);
  if (recencyFilter) {
    body.search_recency_filter = recencyFilter;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
      "HTTP-Referer": "https://openclaw.ai",
      "X-Title": "OpenClaw Web Search",
    },
    body: JSON.stringify(body),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detailResult = await readResponseText(res, { maxBytes: 64_000 });
    const detail = detailResult.text;
    throw new Error(`Perplexity API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as PerplexitySearchResponse;
  const content = data.choices?.[0]?.message?.content ?? "No response";
  const citations = data.citations ?? [];

  return { content, citations };
}

// 百度智能搜索生成（高性能版）API调用
async function runBaiduIntelligentSearch(params: BaiduSearchParams): Promise<{ results: BaiduSearchResult[]; content?: string }> {
  const url = BAIDU_QIANFAN_API_ENDPOINT;
  
  const body: any = {
    messages: [
      {
        role: "user",
        content: params.query
      }
    ],
    stream: false,
    resource_type_filter: [
      {
        type: "web",
        top_k: params.count
      },
      {
        type: "video",
        top_k: 0
      },
      {
        type: "image",
        top_k: 0
      }
    ]
  };
  
  // 添加freshness参数
  const baiduFreshness = freshnessToBaiduRecency(params.freshness);
  if (baiduFreshness) {
    body.search_recency_filter = baiduFreshness;
  }
  
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-Appbuilder-Authorization": `Bearer ${params.apiKey}`,
      "X-Appbuilder-Request-Id": `req_${Date.now()}`,
      "X-Appbuilder-User-Id": `user_${Date.now()}`,
    },
    body: JSON.stringify(body),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detail = await readResponseText(res, { maxBytes: 64_000 });
    throw new Error(`Baidu Intelligent Search API error (${res.status}): ${detail.text || res.statusText}`);
  }

  const data = await res.json();
  const results: BaiduSearchResult[] = [];

  // 处理 references 中的搜索结果
  if (Array.isArray(data.references)) {
    results.push(...data.references.map((entry: any) => ({
      title: entry.title || "",
      url: entry.url || "",
      description: entry.snippet || entry.content || "",
      siteName: resolveSiteName(entry.url),
    })));
  }

  // 处理模型生成的内容
  const content = data.choices?.[0]?.message?.content;

  return { results, content };
}

// 百度智能搜索生成 API调用
async function runBaiduChatCompletionsSearch(params: BaiduSearchParams): Promise<{ results: BaiduSearchResult[]; content?: string }> {
  const url = BAIDU_CHAT_COMPLETIONS_ENDPOINT;
  
  const body: any = {
    messages: [
      {
        role: "user",
        content: params.query
      }
    ],
    model: params.model || "ernie-4.5-turbo-32k",
    search_source: "baidu_search_v2",
    resource_type_filter: [
      {
        type: "web",
        top_k: params.count
      }
    ],
    temperature: 1e-10
  };
  
  // 添加freshness参数
  const baiduFreshness = freshnessToBaiduRecency(params.freshness);
  if (baiduFreshness) {
    body.search_recency_filter = baiduFreshness;
  }
  
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-Appbuilder-Authorization": `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detail = await readResponseText(res, { maxBytes: 64_000 });
    throw new Error(`Baidu Chat Completions API error (${res.status}): ${detail.text || res.statusText}`);
  }

  const data = await res.json();
  const results: BaiduSearchResult[] = [];

  // 处理搜索结果
  if (Array.isArray(data.references)) {
    results.push(...data.references.map((entry: any) => ({
      title: entry.title || "",
      url: entry.url || "",
      description: entry.snippet || entry.content || "",
      siteName: resolveSiteName(entry.url),
    })));
  }

  // 处理模型生成的内容
  const content = data.choices?.[0]?.message?.content;

  return { results, content };
}

// 百度搜索 API调用
async function runBaiduWebSearch(params: BaiduSearchParams): Promise<{ results: BaiduSearchResult[] }> {
  const url = BAIDU_WEB_SEARCH_ENDPOINT;
  
  const body: any = {
    messages: [
      {
        role: "user",
        content: params.query
      }
    ],
    edition: "standard",
    search_source: "baidu_search_v2",
    resource_type_filter: [
      {
        type: "web",
        top_k: params.count
      }
    ]
  };
  
  // 添加freshness参数
  const baiduFreshness = freshnessToBaiduRecency(params.freshness);
  if (baiduFreshness) {
    body.search_filter = {
      range: {
        page_time: {
          gte: `now-${baiduFreshness === "week" ? "1w" : baiduFreshness === "month" ? "1M" : baiduFreshness === "year" ? "1y" : "1w"}/d`
        }
      }
    };
  }
  
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-Appbuilder-Authorization": `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detail = await readResponseText(res, { maxBytes: 64_000 });
    throw new Error(`Baidu Web Search API error (${res.status}): ${detail.text || res.statusText}`);
  }

  const data = await res.json();
  const results: BaiduSearchResult[] = [];

  // 处理搜索结果
  if (Array.isArray(data.references)) {
    results.push(...data.references.map((entry: any) => ({
      title: entry.title || "",
      url: entry.url || "",
      description: entry.snippet || entry.content || "",
      siteName: resolveSiteName(entry.url),
    })));
  }

  return { results };
}

async function runGrokSearch(params: {
  query: string;
  apiKey: string;
  model: string;
  timeoutSeconds: number;
  inlineCitations: boolean;
}): Promise<{
  content: string;
  citations: string[];
  inlineCitations?: GrokSearchResponse["inline_citations"];
}> {
  const body: Record<string, unknown> = {
    model: params.model,
    input: [
      {
        role: "user",
        content: params.query,
      },
    ],
    tools: [{ type: "web_search" }],
  };

  // Note: xAI's /v1/responses endpoint does not support the `include`
  // parameter (returns 400 "Argument not supported: include"). Inline
  // citations are returned automatically when available — we just parse
  // them from the response without requesting them explicitly (#12910).

  const res = await fetch(XAI_API_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detailResult = await readResponseText(res, { maxBytes: 64_000 });
    const detail = detailResult.text;
    throw new Error(`xAI API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as GrokSearchResponse;
  const { text: extractedText, annotationCitations } = extractGrokContent(data);
  const content = extractedText ?? "No response";
  // Prefer top-level citations; fall back to annotation-derived ones
  const citations = (data.citations ?? []).length > 0 ? data.citations! : annotationCitations;
  const inlineCitations = data.inline_citations;

  return { content, citations, inlineCitations };
}

async function runWebSearch(params: {
  query: string;
  count: number;
  apiKey: string;
  timeoutSeconds: number;
  cacheTtlMs: number;
  provider: (typeof SEARCH_PROVIDERS)[number];
  country?: string;
  search_lang?: string;
  ui_lang?: string;
  freshness?: string;
  baiduSearchType?: BaiduSearchType;
  perplexityBaseUrl?: string;
  perplexityModel?: string;
  grokModel?: string;
  grokInlineCitations?: boolean;
}): Promise<Record<string, unknown>> {
  console.log('=== 开始搜索 ===');
  console.log('Web Search Version:', WEB_SEARCH_VERSION);
  console.log('搜索参数:', {
    query: params.query,
    provider: params.provider,
    count: params.count,
    timeoutSeconds: params.timeoutSeconds
  });
  
  const cacheKey = normalizeCacheKey(
    params.provider === "brave"
      ? `${params.provider}:${params.query}:${params.count}:${params.country || "default"}:${params.search_lang || "default"}:${params.ui_lang || "default"}:${params.freshness || "default"}`
      : params.provider === "perplexity"
        ? `${params.provider}:${params.query}:${params.perplexityBaseUrl ?? DEFAULT_PERPLEXITY_BASE_URL}:${params.perplexityModel ?? DEFAULT_PERPLEXITY_MODEL}:${params.freshness || "default"}`
        : params.provider === "grok"
          ? `${params.provider}:${params.query}:${params.grokModel ?? DEFAULT_GROK_MODEL}:${String(params.grokInlineCitations ?? false)}`
          : params.provider === "baidu"
            ? `${params.provider}:${params.baiduSearchType || "default"}:${params.query}:${params.count}:${params.search_lang || "default"}:${params.freshness || "default"}`
            : `${params.provider}:${params.query}:${params.count}:${params.search_lang || "default"}`,
  );
  
  console.log('缓存键:', cacheKey);
  
  const cached = readCache(SEARCH_CACHE, cacheKey);
  if (cached) {
    console.log('使用缓存结果');
    return { ...cached.value, cached: true };
  }

  const start = Date.now();
  console.log('缓存未命中，执行新搜索');


  if (params.provider === "perplexity") {
    const { content, citations } = await runPerplexitySearch({
      query: params.query,
      apiKey: params.apiKey,
      baseUrl: params.perplexityBaseUrl ?? DEFAULT_PERPLEXITY_BASE_URL,
      model: params.perplexityModel ?? DEFAULT_PERPLEXITY_MODEL,
      timeoutSeconds: params.timeoutSeconds,
      freshness: params.freshness,
    });

    const payload = {
      query: params.query,
      provider: params.provider,
      model: params.perplexityModel ?? DEFAULT_PERPLEXITY_MODEL,
      tookMs: Date.now() - start,
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: params.provider,
        wrapped: true,
      },
      content: wrapWebContent(content),
      citations,
    };
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider === "grok") {
    const { content, citations, inlineCitations } = await runGrokSearch({
      query: params.query,
      apiKey: params.apiKey,
      model: params.grokModel ?? DEFAULT_GROK_MODEL,
      timeoutSeconds: params.timeoutSeconds,
      inlineCitations: params.grokInlineCitations ?? false,
    });

    const payload = {
      query: params.query,
      provider: params.provider,
      model: params.grokModel ?? DEFAULT_GROK_MODEL,
      tookMs: Date.now() - start,
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: params.provider,
        wrapped: true,
      },
      content: wrapWebContent(content),
      citations,
      inlineCitations,
    };
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider === "baidu") {
    console.log('=== 开始百度搜索 ===');
    console.log('Web Search Version:', WEB_SEARCH_VERSION);
    console.log('搜索参数:', {
      query: params.query,
      count: params.count,
      timeoutSeconds: params.timeoutSeconds,
      baiduSearchType: params.baiduSearchType
    });
    
    // 检查百度API密钥
    if (!params.apiKey) {
      console.log('❌ 缺少百度API密钥');
      throw new Error("Baidu Search API requires an API key. Set BAIDU_API_KEY in the environment or configure tools.web.search.apiKey.");
    }
    
    console.log('✅ 百度API密钥存在');
    
    let searchResults;
    let searchType: BaiduSearchType = params.baiduSearchType || 'intelligent';
    
    try {
      if (params.baiduSearchType) {
        // 用户指定了搜索类型，直接使用指定的API
        console.log(`直接使用用户指定的搜索类型: ${params.baiduSearchType}`);
        
        switch (params.baiduSearchType) {
          case 'intelligent':
            console.log('使用智能搜索生成（高性能版）');
            searchResults = await runBaiduIntelligentSearch({
              query: params.query,
              apiKey: params.apiKey,
              count: params.count,
              timeoutSeconds: params.timeoutSeconds,
              freshness: params.freshness
            });
            console.log('智能搜索生成（高性能版）成功，结果数量:', searchResults.results.length);
            break;
          case 'chat_completions':
            console.log('使用智能搜索生成');
            searchResults = await runBaiduChatCompletionsSearch({
              query: params.query,
              apiKey: params.apiKey,
              count: params.count,
              timeoutSeconds: params.timeoutSeconds,
              freshness: params.freshness
            });
            console.log('智能搜索生成成功，结果数量:', searchResults.results.length);
            break;
          case 'web_search':
            console.log('使用百度搜索');
            const webSearchResults = await runBaiduWebSearch({
              query: params.query,
              apiKey: params.apiKey,
              count: params.count,
              timeoutSeconds: params.timeoutSeconds,
              freshness: params.freshness
            });
            searchResults = { ...webSearchResults, content: undefined };
            console.log('百度搜索成功，结果数量:', searchResults.results.length);
            break;
          default:
            throw new Error(`Unknown Baidu search type: ${params.baiduSearchType}`);
        }
      } else {
        // 用户未指定搜索类型，使用自动降级机制
        console.log('用户未指定搜索类型，使用自动降级机制');
        
        try {
          // 1. 首先尝试使用智能搜索生成（高性能版）
          console.log('1. 尝试使用智能搜索生成（高性能版）');
          searchType = 'intelligent';
          searchResults = await runBaiduIntelligentSearch({
            query: params.query,
            apiKey: params.apiKey,
            count: params.count,
            timeoutSeconds: params.timeoutSeconds,
            freshness: params.freshness
          });
          console.log('智能搜索生成（高性能版）成功，结果数量:', searchResults.results.length);
        } catch (error) {
          console.log('智能搜索生成（高性能版）失败，尝试智能搜索生成:', error.message);
          try {
            // 2. 失败后尝试使用智能搜索生成
            console.log('2. 尝试使用智能搜索生成');
            searchType = 'chat_completions';
            searchResults = await runBaiduChatCompletionsSearch({
              query: params.query,
              apiKey: params.apiKey,
              count: params.count,
              timeoutSeconds: params.timeoutSeconds,
              freshness: params.freshness
            });
            console.log('智能搜索生成成功，结果数量:', searchResults.results.length);
          } catch (error) {
            console.log('智能搜索生成失败，尝试百度搜索:', error.message);
            try {
              // 3. 失败后尝试使用百度搜索
              console.log('3. 尝试使用百度搜索');
              searchType = 'web_search';
              const webSearchResults = await runBaiduWebSearch({
                query: params.query,
                apiKey: params.apiKey,
                count: params.count,
                timeoutSeconds: params.timeoutSeconds,
                freshness: params.freshness
              });
              searchResults = { ...webSearchResults, content: undefined };
              console.log('百度搜索成功，结果数量:', searchResults.results.length);
            } catch (error) {
              throw error;
            }
          }
        }
      }
    } catch (error) {
      console.log('❌ 所有百度搜索API都失败，使用回退方案');
      // 所有API都失败，使用网页抓取回退
      const searchUrl = `https://www.baidu.com/s?wd=${encodeURIComponent(params.query)}&rn=${params.count}`;
      
      try {
        const fetchRes = await fetch(searchUrl, {
          method: "GET",
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Connection": "keep-alive"
          },
          signal: withTimeout(undefined, params.timeoutSeconds * 1000),
        });
        
        if (!fetchRes.ok) {
          throw new Error(`Web fetch error (${fetchRes.status}): ${fetchRes.statusText}`);
        }
        
        const html = await fetchRes.text();
        const parsedResults = parseBaiduSearchResults(html, params.count);
        
        const finalResults = parsedResults.map((entry) => {
          return {
            title: entry.title ? wrapWebContent(entry.title, "web_search") : "",
            url: entry.url || "",
            description: entry.description ? wrapWebContent(entry.description, "web_search") : "",
            siteName: resolveSiteName(entry.url),
          };
        });
        
        const payload = {
          error: "baidu_search_all_failed",
          message: "All Baidu Search APIs failed. Using web fetch fallback.",
          fallbackUrl: searchUrl,
          docs: "https://cloud.baidu.com/doc/qianfan-api/s/wmjqtqr7w",
          query: params.query,
          provider: params.provider,
          searchType: params.baiduSearchType || searchType,
          count: finalResults.length,
          tookMs: Date.now() - start,
          externalContent: {
            untrusted: true,
            source: "web_search",
            provider: params.provider,
            wrapped: true,
          },
          results: finalResults,
          fallback: true,
          detail: error.message
        };
        
        console.log('缓存回退搜索结果');
        writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
        
        console.log('=== 回退搜索完成 ===');
        console.log('耗时:', payload.tookMs, 'ms');
        console.log('最终结果数量:', payload.count);
        console.log('回退payload:', JSON.stringify(payload, null, 2));
        
        return payload;
      } catch (fetchError) {
        console.log('❌ 回退抓取也失败');
        return {
          error: "baidu_search_fallback_failed",
          message: `All Baidu Search methods failed: ${fetchError.message}`,
          docs: "https://cloud.baidu.com/doc/qianfan-api/s/wmjqtqr7w",
          query: params.query,
          provider: params.provider,
          searchType: params.baiduSearchType || searchType,
          tookMs: Date.now() - start,
          externalContent: {
            untrusted: true,
            source: "web_search",
            provider: params.provider,
            wrapped: true,
          },
          results: []
        };
      }
    }
    
    // 处理搜索结果
    console.log('开始处理搜索结果...');
    const finalResults = searchResults.results.map((entry: BaiduSearchResult, index: number) => {
      return {
        title: entry.title ? wrapWebContent(entry.title, "web_search") : "",
        url: entry.url || "",
        description: entry.description ? wrapWebContent(entry.description, "web_search") : "",
        siteName: entry.siteName || resolveSiteName(entry.url),
      };
    });
    
    if (finalResults.length === 0 && searchResults.content) {
      console.log('没有搜索结果，使用模型生成的内容作为单一结果');
      finalResults.push({
        title: wrapWebContent(params.query, "web_search"),
        url: `https://www.baidu.com/s?wd=${encodeURIComponent(params.query)}`,
        description: wrapWebContent(searchResults.content.substring(0, 200) + (searchResults.content.length > 200 ? '...' : ''), "web_search"),
        siteName: "www.baidu.com",
      });
    }
    
    const payload = {
      query: params.query,
      provider: params.provider,
      searchType: searchType,
      count: finalResults.length,
      tookMs: Date.now() - start,
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: params.provider,
        wrapped: true,
      },
      results: finalResults,
      content: searchResults.content ? wrapWebContent(searchResults.content, "web_search") : undefined,
    };
    
    console.log('缓存搜索结果');
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    
    console.log('=== 百度搜索完成 ===');
    console.log('耗时:', payload.tookMs, 'ms');
    console.log('最终结果数量:', payload.count);
    console.log('使用的搜索类型:', searchType);
    
    return payload;
  }

  if (params.provider !== "brave") {
    throw new Error("Unsupported web search provider.");
  }

  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set("q", params.query);
  url.searchParams.set("count", String(params.count));
  if (params.country) {
    url.searchParams.set("country", params.country);
  }
  if (params.search_lang) {
    url.searchParams.set("search_lang", params.search_lang);
  }
  if (params.ui_lang) {
    url.searchParams.set("ui_lang", params.ui_lang);
  }
  if (params.freshness) {
    url.searchParams.set("freshness", params.freshness);
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": params.apiKey,
    },
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detailResult = await readResponseText(res, { maxBytes: 64_000 });
    const detail = detailResult.text;
    throw new Error(`Brave Search API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as BraveSearchResponse;
  const results = Array.isArray(data.web?.results) ? (data.web?.results ?? []) : [];
  const mapped = results.map((entry) => {
    const description = entry.description ?? "";
    const title = entry.title ?? "";
    const url = entry.url ?? "";
    const rawSiteName = resolveSiteName(url);
    return {
      title: title ? wrapWebContent(title, "web_search") : "",
      url, // Keep raw for tool chaining
      description: description ? wrapWebContent(description, "web_search") : "",
      published: entry.age || undefined,
      siteName: rawSiteName || undefined,
    };
  });

  const payload = {
    query: params.query,
    provider: params.provider,
    count: mapped.length,
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: params.provider,
      wrapped: true,
    },
    results: mapped,
  };
  writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
  return payload;
}

export function createWebSearchTool(options?: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
}): AnyAgentTool | null {
  const search = resolveSearchConfig(options?.config);
  if (!resolveSearchEnabled({ search, sandboxed: options?.sandboxed })) {
    return null;
  }

  const provider = resolveSearchProvider(search);
  const perplexityConfig = resolvePerplexityConfig(search);
  const grokConfig = resolveGrokConfig(search);

  const description =
    provider === "perplexity"
      ? "Search the web using Perplexity Sonar (direct or via OpenRouter). Returns AI-synthesized answers with citations from real-time web search."
      : provider === "grok"
        ? "Search the web using xAI Grok. Returns AI-synthesized answers with citations from real-time web search."
        : provider === "baidu"
          ? "Search the web using Baidu Qianfan Search API. Returns titles, URLs, and snippets for fast research. Requires Baidu Qianfan API key."
          : "Search the web using Brave Search API. Supports region-specific and localized search via country and language parameters. Returns titles, URLs, and snippets for fast research.";

  return {
    label: "Web Search",
    name: "web_search",
    description,
    parameters: WebSearchSchema,
    execute: async (_toolCallId, args) => {
      const perplexityAuth =
        provider === "perplexity" ? resolvePerplexityApiKey(perplexityConfig) : undefined;
      let apiKey =
        provider === "perplexity"
          ? perplexityAuth?.apiKey
          : provider === "grok"
            ? resolveGrokApiKey(grokConfig)
            : resolveSearchApiKey(search);

      // 检查API密钥
      if (!apiKey) {
        return jsonResult(missingSearchKeyPayload(provider));
      }
      
      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ?? search?.maxResults ?? undefined;
      const country = readStringParam(params, "country");
      const search_lang = readStringParam(params, "search_lang");
      const ui_lang = readStringParam(params, "ui_lang");
      const rawFreshness = readStringParam(params, "freshness");
      const baiduSearchType = readStringParam(params, "baiduSearchType");
      
      // 验证baiduSearchType参数
      if (baiduSearchType && provider === "baidu") {
        const validTypes = ['intelligent', 'chat_completions', 'web_search'];
        if (!validTypes.includes(baiduSearchType)) {
          return jsonResult({
            error: "invalid_baidu_search_type",
            message: `baiduSearchType must be one of: ${validTypes.join(', ')}`,
            docs: "https://docs.openclaw.ai/tools/web",
          });
        }
      }
      
      if (rawFreshness && provider !== "brave" && provider !== "perplexity" && provider !== "baidu") {
        return jsonResult({
          error: "unsupported_freshness",
          message: "freshness is only supported by the Brave, Perplexity and Baidu web_search providers.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      const freshness = rawFreshness ? normalizeFreshness(rawFreshness) : undefined;
      if (rawFreshness && !freshness) {
        return jsonResult({
          error: "invalid_freshness",
          message:
            "freshness must be one of pd, pw, pm, py, or a range like YYYY-MM-DDtoYYYY-MM-DD.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      const result = await runWebSearch({
        query,
        count: resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        apiKey,
        timeoutSeconds: resolveTimeoutSeconds(search?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS),
        cacheTtlMs: resolveCacheTtlMs(search?.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES),
        provider,
        country,
        search_lang,
        ui_lang,
        freshness,
        baiduSearchType: baiduSearchType as BaiduSearchType | undefined,
        perplexityBaseUrl: resolvePerplexityBaseUrl(
          perplexityConfig,
          perplexityAuth?.source,
          perplexityAuth?.apiKey,
        ),
        perplexityModel: resolvePerplexityModel(perplexityConfig),
        grokModel: resolveGrokModel(grokConfig),
        grokInlineCitations: resolveGrokInlineCitations(grokConfig),
      });
      return jsonResult(result);
    },
  };
}

export const __testing = {
  inferPerplexityBaseUrlFromApiKey,
  resolvePerplexityBaseUrl,
  isDirectPerplexityBaseUrl,
  resolvePerplexityRequestModel,
  normalizeFreshness,
  freshnessToPerplexityRecency,
  resolveGrokApiKey,
  resolveGrokModel,
  resolveGrokInlineCitations,
  extractGrokContent,
} as const;