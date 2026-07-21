#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';

const execFile = promisify(execFileCb);

// Provider types
const PROVIDER_LMSTUDIO = 'lmstudio';
const PROVIDER_OPENAI = 'openai';
const PROVIDER_KIMI = 'kimi';
const PROVIDER_BAILIAN = 'bailian';

export async function generateSlides(prompt, options = {}) {
  const provider = options.provider || detectProvider(options);

  // 1. Try configured provider first
  try {
    let result = null;
    if (provider === PROVIDER_LMSTUDIO) {
      result = await callLMStudio(prompt, options);
    } else if (provider === PROVIDER_BAILIAN) {
      result = await callBailian(prompt, options.model || 'qwen-max');
    } else {
      result = await callOpenAI(prompt, options);
    }
    if (result) return result;
  } catch (err) {
    if (process.env.AI_PPT_DEBUG) console.error(`[llm] ${provider} failed:`, err.message);
  }

  // 2. Try other providers as fallback
  const fallbacks = [PROVIDER_OPENAI, PROVIDER_BAILIAN].filter(p => p !== provider);
  for (const fb of fallbacks) {
    try {
      let result = null;
      if (fb === PROVIDER_BAILIAN) {
        result = await callBailian(prompt, options.model || 'qwen-max');
      } else {
        result = await callOpenAI(prompt, options);
      }
      if (result) return result;
    } catch (err) {
      if (process.env.AI_PPT_DEBUG) console.error(`[llm] fallback ${fb} failed:`, err.message);
    }
  }

  // 3. No LLM available
  return null;
}

function detectProvider(options) {
  if (options.provider) return options.provider;
  if (options.baseUrl?.includes('localhost:1234')) return PROVIDER_LMSTUDIO;
  if (options.baseUrl?.includes('kimi.com')) return PROVIDER_KIMI;
  return PROVIDER_OPENAI;
}

async function callBailian(prompt, model) {
  try {
    await execFile('which', ['bl']);
  } catch {
    return null;
  }

  return new Promise((resolve, reject) => {
    const args = ['chat', '--model', model, '--prompt', prompt];
    const child = spawn('bl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`bl exited ${code}: ${stderr}`));
      }
      resolve(cleanLlmOutput(stdout));
    });
  });
}

async function callLMStudio(prompt, options) {
  const baseUrl = (options.baseUrl || 'http://localhost:1234/v1').replace(/\/$/, '');

  // Get available models from LM Studio
  let model = options.model;
  if (!model) {
    try {
      const modelsRes = await fetch(`${baseUrl}/models`);
      if (modelsRes.ok) {
        const data = await modelsRes.json();
        if (data.data?.length > 0) {
          model = data.data[0].id;
        }
      }
    } catch {
      // ignore - just proceed without model list
    }
  }

  if (!model) {
    throw new Error('LM Studio: no model selected. Please load a model in LM Studio first.');
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are an expert presentation designer. Respond only with the requested HTML fragment.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
      max_tokens: 8192,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LM Studio API ${res.status}: ${text}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  return content ? cleanLlmOutput(content) : null;
}

async function callOpenAI(prompt, options) {
  const apiKey = options.apiKey || process.env.AI_PPT_API_KEY || process.env.OPENAI_API_KEY;
  const isKimiKey = apiKey?.startsWith('sk-kimi-');
  const defaultBaseUrl = isKimiKey ? 'https://api.kimi.com/coding/v1' : 'https://api.openai.com/v1';
  const baseUrl = (options.baseUrl || process.env.OPENAI_BASE_URL || defaultBaseUrl).replace(/\/$/, '');

  const isKimiEndpoint = baseUrl.includes('kimi.com/coding');
  const defaultModel = isKimiEndpoint ? 'kimi-for-coding' : 'gpt-4o-mini';
  const model = options.model || process.env.OPENAI_MODEL || defaultModel;

  let temperature = 0.6;
  if (process.env.AI_PPT_TEMPERATURE) {
    temperature = parseFloat(process.env.AI_PPT_TEMPERATURE);
  } else if (isKimiEndpoint) {
    temperature = 1;
  }

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are an expert presentation designer. Respond only with the requested HTML fragment.' },
        { role: 'user', content: prompt },
      ],
      temperature,
      max_tokens: 8192,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI-compatible API ${res.status}: ${text}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  return content ? cleanLlmOutput(content) : null;
}

// List models from OpenAI-compatible endpoint (including LM Studio)
export async function listModels(options = {}) {
  const baseUrl = (options.baseUrl || 'http://localhost:1234/v1').replace(/\/$/, '');
  const apiKey = options.apiKey || process.env.AI_PPT_API_KEY || process.env.OPENAI_API_KEY;

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  try {
    const res = await fetch(`${baseUrl}/models`, { headers });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || []).map(m => ({
      id: m.id,
      name: m.id,
    }));
  } catch {
    return [];
  }
}

function cleanLlmOutput(text) {
  if (!text) return '';
  return text
    .replace(/```html\s*/gi, '')
    .replace(/```\s*$/g, '')
    .replace(/^\s*<html[^>]*>[\s\S]*?<body[^>]*>/i, '')
    .replace(/<\/body>\s*<\/html>\s*$/i, '')
    .trim();
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const prompt = process.argv.slice(2).join(' ') || '生成一张关于人工智能的封面幻灯片';
  generateSlides(prompt).then((out) => {
    if (out) console.log(out);
    else console.log('<!-- No LLM available; deterministic fallback would be used -->');
  }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
