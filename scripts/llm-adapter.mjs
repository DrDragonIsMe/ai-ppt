#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';

const execFile = promisify(execFileCb);

export async function generateSlides(prompt, options = {}) {
  // 1. Try OpenAI-compatible API (Kimi Code, etc.) if configured
  try {
    const result = await callOpenAI(prompt, options);
    if (result) return result;
  } catch (err) {
    if (process.env.AI_PPT_DEBUG) console.error('[llm] OpenAI-compatible failed:', err.message);
  }

  // 2. Try Bailian CLI if installed
  const model = options.model || process.env.AI_PPT_MODEL || 'qwen-max';
  try {
    const result = await callBailian(prompt, model);
    if (result) return result;
  } catch (err) {
    if (process.env.AI_PPT_DEBUG) console.error('[llm] Bailian failed:', err.message);
  }

  // 3. No LLM available
  return null;
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

async function callOpenAI(prompt, options) {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  // Auto-detect Kimi Code endpoint when key has the kimi prefix and no base URL is set
  const isKimiKey = apiKey.startsWith('sk-kimi-');
  const defaultBaseUrl = isKimiKey ? 'https://api.kimi.com/coding/v1' : 'https://api.openai.com/v1';
  const baseUrl = (options.baseUrl || process.env.OPENAI_BASE_URL || defaultBaseUrl).replace(/\/$/, '');

  const isKimiEndpoint = baseUrl.includes('kimi.com/coding');
  const defaultModel = isKimiEndpoint ? 'kimi-for-coding' : 'gpt-4o-mini';
  const model = options.openaiModel || process.env.OPENAI_MODEL || defaultModel;

  let temperature = 0.6;
  if (process.env.AI_PPT_TEMPERATURE) {
    temperature = parseFloat(process.env.AI_PPT_TEMPERATURE);
  } else if (isKimiEndpoint) {
    temperature = 1;
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
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
    throw new Error(`OpenAI API ${res.status}: ${text}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  return content ? cleanLlmOutput(content) : null;
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
