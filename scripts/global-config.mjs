#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const GLOBAL_CONFIG_PATH = path.join(ROOT, '.ai-ppt-config.json');

export const DEFAULT_GLOBAL_CONFIG = {
  modelConfig: {
    presetId: 'volc-ark-doubao-seed-2.0-lite',
    provider: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    model: 'doubao-seed-2.0-lite',
  },
};

function envModelConfig() {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_BASE_URL;
  const model = process.env.OPENAI_MODEL;
  if (!apiKey && !baseUrl && !model) return null;

  if (apiKey?.startsWith('sk-kimi-')) {
    return {
      presetId: 'kimi-code',
      provider: 'kimi',
      baseUrl: baseUrl || 'https://api.kimi.com/coding/v1',
      model: model || 'kimi-for-coding',
    };
  }

  if (baseUrl?.includes('volces.com')) {
    return {
      presetId: 'volc-ark-doubao-seed-2.0-lite',
      provider: 'openai',
      baseUrl,
      model: model || 'doubao-seed-2.0-lite',
    };
  }

  return {
    presetId: 'custom',
    provider: 'openai',
    baseUrl: baseUrl || '',
    model: model || '',
  };
}

export function readGlobalConfig() {
  let fileConfig = null;
  if (fs.existsSync(GLOBAL_CONFIG_PATH)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf8'));
    } catch {
      fileConfig = null;
    }
  }

  const envCfg = envModelConfig();
  return {
    modelConfig: envCfg || fileConfig?.modelConfig || DEFAULT_GLOBAL_CONFIG.modelConfig,
  };
}

export function writeGlobalConfig(config) {
  const existing = readGlobalConfig();
  const safe = JSON.parse(JSON.stringify(config));
  if (safe.modelConfig) delete safe.modelConfig.apiKey;
  const merged = { ...existing, ...safe };
  fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const cmd = process.argv[2];
  if (cmd === 'show') {
    console.log(JSON.stringify(readGlobalConfig(), null, 2));
  } else if (cmd === 'set-model') {
    const presetId = process.argv[3];
    const baseUrl = process.argv[4];
    const model = process.argv[5];
    const provider = process.argv[6] || 'openai';
    writeGlobalConfig({ modelConfig: { presetId, provider, baseUrl, model } });
    console.log('Global model config updated');
  } else {
    console.log('Usage: node scripts/global-config.mjs [show | set-model <presetId> <baseUrl> <model> [provider]]');
  }
}
