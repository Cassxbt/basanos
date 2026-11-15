import OpenAI from "openai";

export type Provider = "dolphin" | "serv";

// USD per million tokens, from each provider's live catalog (Nov 2026).
const PRICES: Record<string, { input: number; output: number }> = {
  "deepseek-ai/DeepSeek-V4.1-Flash": { input: 0.01, output: 0.07 },
  "gpt-6-luna": { input: 0.13, output: 0.65 },
  "gpt-5.4-mini": { input: 1.0, output: 6.0 },
};

export interface Call<T> {
  value: T;
  provider: Provider;
  model: string;
  requestId: string | null;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  ms: number;
}

export interface JsonRequest {
  provider: Provider;
  model: string;
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  maxTokens: number;
  promptGuard?: boolean;
}

let clients: Partial<Record<Provider, OpenAI>> = {};

function client(provider: Provider): OpenAI {
  if (!clients[provider]) {
    const apiKey = provider === "serv" ? process.env.SERV_API_KEY : process.env.DOLPHIN_API_KEY;
    if (!apiKey) throw new Error(`missing ${provider === "serv" ? "SERV_API_KEY" : "DOLPHIN_API_KEY"}`);
    clients[provider] = new OpenAI({
      apiKey,
      baseURL: provider === "serv" ? "https://inference-api.openserv.ai/v1" : "https://lighthouse.dphn.ai/run/text-v/v1",
      maxRetries: 3,
      timeout: 180_000,
    });
  }
  return clients[provider]!;
}

export function cost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICES[model];
  if (!p) throw new Error(`no price for ${model}`);
  return (inputTokens * p.input + outputTokens * p.output) / 1e6;
}

export class GuardBlocked extends Error {}

export async function callJson<T>(req: JsonRequest): Promise<Call<T>> {
  const started = Date.now();
  const body: Record<string, unknown> = {
    model: req.model,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: req.schemaName, strict: true, schema: req.schema },
    },
  };
  if (req.provider === "serv") {
    body.max_completion_tokens = req.maxTokens;
    if (req.promptGuard) body.tools = [{ type: "function", function: { name: "serv_prompt_guard" } }];
  } else {
    body.max_tokens = req.maxTokens;
    body.chat_template_kwargs = { thinking: false };
  }

  const { data, response } = await client(req.provider)
    .chat.completions.create(body as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming)
    .withResponse();

  const message = data.choices[0]?.message;
  const requestId = response.headers.get("x-openserv-request-id") ?? data.id ?? null;
  const inputTokens = data.usage?.prompt_tokens ?? 0;
  const outputTokens = data.usage?.completion_tokens ?? 0;
  const meta = {
    provider: req.provider,
    model: req.model,
    requestId,
    inputTokens,
    outputTokens,
    usd: cost(req.model, inputTokens, outputTokens),
    ms: Date.now() - started,
  };

  if (message?.refusal) throw new GuardBlocked(`${req.provider} refused (${requestId}): ${message.refusal}`);
  const text = message?.content;
  if (!text) throw new Error(`${req.provider} returned no content (${requestId}), finish=${data.choices[0]?.finish_reason}`);
  try {
    return { value: JSON.parse(text) as T, ...meta };
  } catch {
    throw new Error(`${req.provider} returned non-JSON (${requestId}): ${text.slice(0, 200)}`);
  }
}
