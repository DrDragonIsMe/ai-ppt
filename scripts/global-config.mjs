#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './fs-utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
// AI_PPT_CONFIG_PATH 可重定向配置文件位置（测试隔离用）；未设时才是仓库根那份。
// 每次调用即时求值，不做模块级缓存，与 sourcesConfig 的即时读盘口径一致。
function globalConfigPath() {
  const override = process.env.AI_PPT_CONFIG_PATH;
  return override ? path.resolve(override) : path.join(ROOT, '.ai-ppt-config.json');
}

export const DEFAULT_GLOBAL_CONFIG = {
  appConfig: {
    brandName: '小龙哥@薪灵AI',
  },
  agentConfig: {
    assistantName: '薪小灵',
    responseStyle: 'concise',
    allowSettingsMutation: true,
    allowKnowledgeMutation: true,
  },
  sourcesConfig: {
    allowExternalPaths: false,
    pruneGuard: true,
    pruneGuardRatio: 0.2,
  },
  modelConfig: {
    presetId: 'volc-ark-doubao-seed-2.0-lite',
    provider: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    model: 'doubao-seed-2.0-lite',
  },
  imageModelConfig: {
    provider: 'arkcli',
    model: '',
  },
  videoModelConfig: {
    provider: 'arkcli',
    model: '',
  },
  pdfConfig: {
    defaultEngine: 'puppeteer',
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
  const configPath = globalConfigPath();
  let fileConfig = null;
  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      fileConfig = null;
    }
  }

  const envCfg = envModelConfig();
  return {
    appConfig: { ...DEFAULT_GLOBAL_CONFIG.appConfig, ...fileConfig?.appConfig },
    agentConfig: { ...DEFAULT_GLOBAL_CONFIG.agentConfig, ...fileConfig?.agentConfig },
    sourcesConfig: { ...DEFAULT_GLOBAL_CONFIG.sourcesConfig, ...fileConfig?.sourcesConfig },
    modelConfig: envCfg || fileConfig?.modelConfig || DEFAULT_GLOBAL_CONFIG.modelConfig,
    imageModelConfig: { ...DEFAULT_GLOBAL_CONFIG.imageModelConfig, ...fileConfig?.imageModelConfig },
    videoModelConfig: { ...DEFAULT_GLOBAL_CONFIG.videoModelConfig, ...fileConfig?.videoModelConfig },
    pdfConfig: { ...DEFAULT_GLOBAL_CONFIG.pdfConfig, ...fileConfig?.pdfConfig },
  };
}

export function writeGlobalConfig(config) {
  const existing = readGlobalConfig();
  const safe = JSON.parse(JSON.stringify(config));
  // persistApiKey === true 时允许三组配置的 apiKey 落盘；否则一律剥离（默认行为）
  const persistApiKey = safe.persistApiKey === true;
  delete safe.persistApiKey;
  if (!persistApiKey) {
    for (const key of ['modelConfig', 'imageModelConfig', 'videoModelConfig']) {
      if (safe[key]) delete safe[key].apiKey;
    }
  }
  const merged = { ...existing, ...safe };
  for (const key of ['appConfig', 'agentConfig', 'sourcesConfig', 'modelConfig', 'imageModelConfig', 'videoModelConfig', 'pdfConfig']) {
    if (safe[key]) merged[key] = { ...existing[key], ...safe[key] };
  }
  writeJsonAtomic(globalConfigPath(), merged);
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
  } else if (cmd === 'set-media') {
    const kind = process.argv[3];
    const provider = process.argv[4];
    const model = process.argv[5];
    const baseUrl = process.argv[6];
    if (kind !== 'image' && kind !== 'video') {
      console.error('kind 必须是 image 或 video');
      process.exit(1);
    }
    if (!provider) {
      console.error('缺少 provider（arkcli | bailian | openai）');
      process.exit(1);
    }
    const cfg = { provider, model: model || '' };
    if (baseUrl) cfg.baseUrl = baseUrl;
    writeGlobalConfig({ [kind === 'image' ? 'imageModelConfig' : 'videoModelConfig']: cfg });
    console.log(`Global ${kind} model config updated`);
  } else {
    console.log('Usage: node scripts/global-config.mjs [show | set-model <presetId> <baseUrl> <model> [provider] | set-media <image|video> <provider> <model> [baseUrl]]');
  }
}
