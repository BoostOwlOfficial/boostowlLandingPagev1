// ============================================================================
// Provider-agnostic AI scoring.
//
// Nothing above this file knows which model vendor is in use. Switching
// providers is a `config` row edit — no redeploy, same as every other knob.
//
//   config.ai_provider   anthropic | openai | google | openai_compatible
//   config.ai_model      the model id for that provider
//   config.ai_base_url   override (required for openai_compatible)
//   AI_API_KEY           generic key, or a provider-specific alias
//
// `openai_compatible` covers anything speaking the OpenAI chat-completions
// shape: Groq, Together, OpenRouter, DeepSeek, Fireworks, Mistral, vLLM,
// Ollama, LM Studio. Point ai_base_url at it and set ai_model.
//
// Every provider returns the SAME normalised result, so cron/score.js has no
// vendor-specific branches:
//   { json, inputTokens, outputTokens, model, pdfUsed }
// ============================================================================

'use strict';

const DEFAULT_TIMEOUT_MS = 60000;

/** First env var that is set, in order. */
function firstEnv(names) {
  for (const n of names) if (process.env[n]) return process.env[n];
  return null;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------
const PROVIDERS = {

  /* ---------------------------------------------------------------- */
  anthropic: {
    label: 'Anthropic (Claude)',
    keyEnv: ['ANTHROPIC_API_KEY', 'AI_API_KEY'],
    defaultModel: 'claude-haiku-4-5',
    defaultBaseUrl: 'https://api.anthropic.com',
    supportsPdf: true,

    request({ baseUrl, apiKey, model, prompt, pdfBase64, schema, maxTokens }) {
      const content = [];
      if (pdfBase64) {
        content.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
        });
      }
      content.push({ type: 'text', text: prompt });

      return {
        url: `${baseUrl}/v1/messages`,
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: {
          model,
          max_tokens: maxTokens,
          output_config: { format: { type: 'json_schema', schema } },
          messages: [{ role: 'user', content }],
        },
      };
    },

    parse(body) {
      if (body.stop_reason === 'refusal') {
        throw new Error('model declined to score this application');
      }
      const block = (body.content || []).find((b) => b.type === 'text');
      if (!block) throw new Error('no text block in response');
      const u = body.usage || {};
      return {
        json: JSON.parse(block.text),
        inputTokens: u.input_tokens || 0,
        outputTokens: u.output_tokens || 0,
        model: body.model,
      };
    },
  },

  /* ---------------------------------------------------------------- */
  openai: {
    label: 'OpenAI',
    keyEnv: ['OPENAI_API_KEY', 'AI_API_KEY'],
    defaultModel: null,           // must be set explicitly in config.ai_model
    defaultBaseUrl: 'https://api.openai.com',
    supportsPdf: false,           // needs the Files API, not inline base64

    request({ baseUrl, apiKey, model, prompt, schema, maxTokens }) {
      return {
        url: `${baseUrl}/v1/chat/completions`,
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: {
          model,
          max_completion_tokens: maxTokens,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'application_score', strict: true, schema },
          },
          messages: [{ role: 'user', content: prompt }],
        },
      };
    },

    parse(body) {
      const choice = (body.choices || [])[0];
      if (!choice) throw new Error('no choices in response');
      if (choice.finish_reason === 'content_filter') {
        throw new Error('provider content filter blocked this application');
      }
      const u = body.usage || {};
      return {
        json: JSON.parse(choice.message.content),
        inputTokens: u.prompt_tokens || 0,
        outputTokens: u.completion_tokens || 0,
        model: body.model,
      };
    },
  },

  /* ---------------------------------------------------------------- */
  google: {
    label: 'Google Gemini',
    keyEnv: ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'AI_API_KEY'],
    defaultModel: null,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    supportsPdf: true,            // inlineData accepts application/pdf

    request({ baseUrl, apiKey, model, prompt, pdfBase64, schema, maxTokens }) {
      const parts = [];
      if (pdfBase64) parts.push({ inlineData: { mimeType: 'application/pdf', data: pdfBase64 } });
      parts.push({ text: prompt });

      return {
        // Key travels in a header, not the query string, so it stays out of logs.
        url: `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
        body: {
          contents: [{ role: 'user', parts }],
          generationConfig: {
            maxOutputTokens: maxTokens,
            responseMimeType: 'application/json',
            responseSchema: stripUnsupported(schema),
          },
        },
      };
    },

    parse(body) {
      const cand = (body.candidates || [])[0];
      if (!cand) {
        const reason = body.promptFeedback && body.promptFeedback.blockReason;
        throw new Error(reason ? `blocked: ${reason}` : 'no candidates in response');
      }
      const text = ((cand.content || {}).parts || []).map((p) => p.text || '').join('');
      if (!text) throw new Error('empty response');
      const u = body.usageMetadata || {};
      return {
        json: JSON.parse(text),
        inputTokens: u.promptTokenCount || 0,
        outputTokens: u.candidatesTokenCount || 0,
        model: body.modelVersion || null,
      };
    },
  },

  /* ---------------------------------------------------------------- */
  openai_compatible: {
    label: 'OpenAI-compatible endpoint',
    keyEnv: ['AI_API_KEY', 'OPENAI_API_KEY'],
    defaultModel: null,
    defaultBaseUrl: null,         // config.ai_base_url is mandatory
    supportsPdf: false,
    keyOptional: true,            // local runtimes (Ollama, LM Studio) need none

    request({ baseUrl, apiKey, model, prompt, schema, maxTokens }) {
      const headers = { 'content-type': 'application/json' };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;

      return {
        url: `${baseUrl}/v1/chat/completions`,
        headers,
        body: {
          model,
          max_tokens: maxTokens,
          // Strict json_schema support is inconsistent across these gateways,
          // so ask for json_object and put the schema in the prompt instead
          // (buildScoringPrompt appends it when schemaInPrompt is true).
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: prompt }],
        },
      };
    },
    schemaInPrompt: true,

    parse(body) {
      const choice = (body.choices || [])[0];
      if (!choice) throw new Error('no choices in response');
      const u = body.usage || {};
      return {
        json: parseLooseJson(choice.message.content),
        inputTokens: u.prompt_tokens || 0,
        outputTokens: u.completion_tokens || 0,
        model: body.model,
      };
    },
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Gemini's responseSchema rejects some JSON Schema keywords. */
function stripUnsupported(schema) {
  const out = JSON.parse(JSON.stringify(schema));
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    delete n.additionalProperties;
    delete n.$schema;
    if (n.properties) Object.values(n.properties).forEach(walk);
    if (n.items) walk(n.items);
  })(out);
  return out;
}

/** Smaller models like to wrap JSON in prose or a ```json fence. */
function parseLooseJson(text) {
  const s = String(text || '').trim();
  try { return JSON.parse(s); } catch (e) { /* fall through */ }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch (e) { /* fall through */ } }

  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) return JSON.parse(s.slice(first, last + 1));

  throw new Error('response was not valid JSON');
}

function resolveProvider(config) {
  const name = String(config.ai_provider || 'anthropic').toLowerCase().replace(/-/g, '_');
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(`unknown ai_provider "${name}" (expected: ${Object.keys(PROVIDERS).join(', ')})`);
  }
  return { name, provider };
}

/**
 * Is scoring configured and runnable? Called before any work is claimed so a
 * misconfiguration never leaves rows stuck in 'scoring'.
 * @returns {{ok:true, ...} | {ok:false, reason:string}}
 */
function describeProvider(config) {
  let name, provider;
  try { ({ name, provider } = resolveProvider(config)); }
  catch (err) { return { ok: false, reason: err.message }; }

  const apiKey = firstEnv(provider.keyEnv);
  if (!apiKey && !provider.keyOptional) {
    return { ok: false, reason: `${provider.label}: set one of ${provider.keyEnv.join(' or ')}` };
  }

  const baseUrl = String(config.ai_base_url || provider.defaultBaseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) {
    return { ok: false, reason: `${provider.label}: config.ai_base_url is required` };
  }

  const model = config.ai_model || provider.defaultModel;
  if (!model) {
    return { ok: false, reason: `${provider.label}: set config.ai_model` };
  }

  return {
    ok: true, name, label: provider.label, model, baseUrl,
    supportsPdf: provider.supportsPdf === true,
    schemaInPrompt: provider.schemaInPrompt === true,
    apiKey,
  };
}

/**
 * Run one scoring call. Vendor-neutral in and out.
 *
 * @returns {{json, inputTokens, outputTokens, model, pdfUsed, provider}}
 */
async function generateJson({ config, prompt, schema, pdfBase64, maxTokens = 1024, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const info = describeProvider(config);
  if (!info.ok) throw new Error(info.reason);

  const { provider } = resolveProvider(config);

  // Providers that cannot read a PDF still score from the written answers.
  const usePdf = Boolean(pdfBase64) && info.supportsPdf;

  const req = provider.request({
    baseUrl: info.baseUrl,
    apiKey: info.apiKey,
    model: info.model,
    prompt,
    pdfBase64: usePdf ? pdfBase64 : null,
    schema,
    maxTokens,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let body;
  try {
    const resp = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: controller.signal,
    });
    const text = await resp.text();
    if (!resp.ok) {
      const err = new Error(`${info.label} ${resp.status}: ${text.slice(0, 300)}`);
      err.retryable = resp.status === 429 || resp.status >= 500;
      throw err;
    }
    body = JSON.parse(text);
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error(`${info.label} timed out after ${timeoutMs}ms`);
      e.retryable = true;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const parsed = provider.parse(body);
  return Object.assign({ pdfUsed: usePdf, provider: info.name, model: info.model }, parsed);
}

/** Cost in USD. Prices are config rows so a provider switch needs no deploy. */
function estimateCost(config, inputTokens, outputTokens) {
  const inRate  = Number(config.ai_price_in_per_mtok);
  const outRate = Number(config.ai_price_out_per_mtok);
  if (!Number.isFinite(inRate) || !Number.isFinite(outRate)) return 0;
  return (inputTokens / 1e6) * inRate + (outputTokens / 1e6) * outRate;
}

module.exports = {
  PROVIDERS,
  describeProvider,
  generateJson,
  estimateCost,
  parseLooseJson,
};
