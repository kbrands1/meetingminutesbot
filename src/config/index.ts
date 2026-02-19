import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { AppConfig, FoldersConfiguration } from '../types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadJsonConfig<T>(filename: string): T {
  const configPath = join(__dirname, '../../config', filename);
  const content = readFileSync(configPath, 'utf-8');
  return JSON.parse(content) as T;
}

// Load configurations
export const appConfig: AppConfig = loadJsonConfig<AppConfig>('default.json');
export const foldersConfig: FoldersConfiguration = loadJsonConfig<FoldersConfiguration>('folders.json');

// Environment-based overrides
export function getConfig(): AppConfig {
  return {
    ...appConfig,
    gcp: {
      ...appConfig.gcp,
      projectId: process.env.GCP_PROJECT_ID || appConfig.gcp.projectId,
    },
  };
}

// Get environment variables with defaults
export function getEnvVar(name: string, defaultValue?: string): string {
  const value = process.env[name];
  if (!value && defaultValue === undefined) {
    throw new Error(`Environment variable ${name} is required but not set`);
  }
  return value || defaultValue!;
}

// API key getters (these should come from environment or Secret Manager)
export function getOpenAIApiKey(): string {
  return getEnvVar('OPENAI_API_KEY');
}

export function getClickUpApiKey(): string {
  return getEnvVar('CLICKUP_API_KEY');
}

// Chat function URL for Workspace Add-on card actions
export function getChatFunctionUrl(): string {
  return getEnvVar('CHAT_FUNCTION_URL', 'https://handlechatinteraction-jrgrpko2qa-uc.a.run.app');
}
