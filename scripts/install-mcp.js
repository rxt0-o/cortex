#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const serverDir = path.join(repoRoot, 'server');
const bundlePath = path.join(serverDir, 'dist', 'bundle.js');
const mcpConfigPath = path.join(repoRoot, '.mcp.json');
const isWindows = process.platform === 'win32';
const vecDllPath = path.join(serverDir, 'native', 'vec0.dll');
const sqliteVecModuleDir = path.join(serverDir, 'node_modules', 'sqlite-vec');
const SQLITE_VEC_VERSION = process.env.CORTEX_SQLITE_VEC_VERSION || '0.1.7-alpha.2';

const npmCmd = 'npm';
const codexCmd = 'codex';
const claudeCmd = 'claude';

const args = process.argv.slice(2);
const isGlobal = args.includes('--global');
const isUninstall = args.includes('--uninstall');

function quoteCmdArg(arg) {
  if (!/[\s"&|<>^]/.test(arg)) return arg;
  return `"${String(arg).replace(/"/g, '""')}"`;
}

function spawnPlatform(command, args, options = {}) {
  if (!isWindows) {
    return spawnSync(command, args, {
      ...options,
      shell: false,
    });
  }

  const comspec = process.env.ComSpec || 'cmd.exe';
  const cmdLine = [command, ...args].map(quoteCmdArg).join(' ');
  return spawnSync(comspec, ['/d', '/s', '/c', cmdLine], {
    ...options,
    shell: false,
  });
}

function runOrThrow(command, args, cwd) {
  const result = spawnPlatform(command, args, {
    cwd,
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function canRun(command, args) {
  const result = spawnPlatform(command, args, {
    stdio: 'ignore',
  });
  return !result.error && result.status === 0;
}

// --- Pfad-Normalisierung für plattformübergreifende Nutzung ---

function normalizePath(p) {
  return isWindows ? p : p.replace(/\\/g, '/');
}

// --- Home-Dir Settings ---

function getClaudeSettingsPath() {
  const homeDir = os.homedir();
  return path.join(homeDir, '.claude', 'settings.json');
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

function writeJsonFile(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

// --- Lokaler Install (wie bisher) ---

function writeClaudeMcpConfig() {
  const config = {
    mcpServers: {
      cortex: {
        command: 'node',
        args: ['./server/dist/bundle.js'],
      },
    },
  };
  fs.writeFileSync(mcpConfigPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

function codexHasCortex() {
  const result = spawnPlatform(codexCmd, ['mcp', 'list'], {
    encoding: 'utf-8',
  });
  if (result.error || result.status !== 0) return false;
  return result.stdout.includes('cortex');
}

function tryRegisterCodex() {
  if (process.env.CORTEX_SKIP_CODEX === '1') {
    console.log('Skipping Codex auto-registration (CORTEX_SKIP_CODEX=1).');
    return;
  }

  if (!canRun(codexCmd, ['--version'])) {
    console.log('Codex CLI not found. Skipping Codex auto-registration.');
    console.log(`Manual command: codex mcp add cortex -- node "${bundlePath}"`);
    return;
  }

  if (codexHasCortex()) {
    console.log('Codex MCP entry "cortex" already exists.');
    return;
  }

  console.log('Registering cortex MCP server in Codex...');
  const result = spawnPlatform(
    codexCmd,
    ['mcp', 'add', 'cortex', '--', 'node', bundlePath],
    {
      stdio: 'inherit',
    }
  );
  if (result.error || result.status !== 0) {
    console.log('Codex auto-registration failed. Run this manually:');
    console.log(`codex mcp add cortex -- node "${bundlePath}"`);
  }
}

// --- Global Install ---

function buildCortexHooksConfig() {
  const scriptsDir = path.join(repoRoot, 'scripts');
  const abs = (name) => {
    const p = path.join(scriptsDir, name);
    // Quote if path contains spaces
    return /\s/.test(p) ? `"${p}"` : p;
  };

  return {
    SessionStart: [{
      matcher: '',
      hooks: [{ type: 'command', command: `node ${abs('on-session-start.js')}`, timeout: 15 }],
    }],
    PreToolUse: [{
      matcher: 'Write|Edit',
      hooks: [{ type: 'command', command: `node ${abs('on-pre-tool-use.js')}`, timeout: 5 }],
    }],
    PostToolUse: [{
      matcher: 'Read|Write|Edit',
      hooks: [{ type: 'command', command: `node ${abs('on-post-tool-use.js')}`, timeout: 10 }],
    }],
    Stop: [{
      matcher: '',
      hooks: [{ type: 'command', command: `node ${abs('on-session-end.js')}`, timeout: 30 }],
    }],
  };
}

function isCortexHookCommand(command) {
  if (typeof command !== 'string') return false;
  // Normalize to forward slashes for matching
  const normalized = command.replace(/\\/g, '/');
  return normalized.includes('scripts/on-') && normalized.includes('cortex');
}

function isCortexHookEntry(entry) {
  return entry && Array.isArray(entry.hooks) &&
    entry.hooks.some(h => isCortexHookCommand(h.command));
}

function mergeHooksIntoSettings(settings) {
  const cortexHooks = buildCortexHooksConfig();
  const existing = settings.hooks || {};

  for (const [event, cortexEntries] of Object.entries(cortexHooks)) {
    const existingArr = Array.isArray(existing[event]) ? existing[event] : [];
    // Entferne alte Cortex-Einträge um Duplikate zu vermeiden
    const filtered = existingArr.filter(entry => !isCortexHookEntry(entry));
    existing[event] = [...filtered, ...cortexEntries];
  }

  settings.hooks = existing;
  return settings;
}

function removeCortexHooksFromSettings(settings) {
  if (!settings.hooks) return settings;

  for (const event of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[event])) continue;
    settings.hooks[event] = settings.hooks[event].filter(entry => !isCortexHookEntry(entry));
    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
  }

  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  return settings;
}

function globalRegisterClaudeMcp() {
  const absBundlePath = normalizePath(bundlePath);

  if (canRun(claudeCmd, ['--version'])) {
    console.log('Registering cortex MCP server globally via claude CLI...');
    const result = spawnPlatform(
      claudeCmd,
      ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'cortex', '--', 'node', absBundlePath],
      { stdio: 'inherit' }
    );
    if (result.error || result.status !== 0) {
      console.log('claude mcp add failed. Run manually:');
      console.log(`  claude mcp add --scope user --transport stdio cortex -- node "${absBundlePath}"`);
    } else {
      console.log('Claude Code: cortex MCP server registered globally.');
    }
  } else {
    console.log('Claude CLI not found. Register manually:');
    console.log(`  claude mcp add --scope user --transport stdio cortex -- node "${absBundlePath}"`);
  }
}

function globalUnregisterClaudeMcp() {
  if (canRun(claudeCmd, ['--version'])) {
    console.log('Removing cortex MCP server from Claude Code...');
    const result = spawnPlatform(claudeCmd, ['mcp', 'remove', 'cortex'], { stdio: 'inherit' });
    if (result.error || result.status !== 0) {
      console.log('claude mcp remove failed (may not have been registered).');
    } else {
      console.log('Claude Code: cortex MCP server removed.');
    }
  } else {
    console.log('Claude CLI not found. Remove manually: claude mcp remove cortex');
  }
}

function globalRegisterCodex() {
  if (process.env.CORTEX_SKIP_CODEX === '1') {
    console.log('Skipping Codex registration (CORTEX_SKIP_CODEX=1).');
    return;
  }

  if (!canRun(codexCmd, ['--version'])) {
    console.log('Codex CLI not found. Skipping.');
    console.log(`Manual: codex mcp add cortex -- node "${bundlePath}"`);
    return;
  }

  if (codexHasCortex()) {
    console.log('Codex MCP entry "cortex" already exists.');
    return;
  }

  console.log('Registering cortex in Codex...');
  const result = spawnPlatform(
    codexCmd,
    ['mcp', 'add', 'cortex', '--', 'node', bundlePath],
    { stdio: 'inherit' }
  );
  if (result.error || result.status !== 0) {
    console.log('Codex registration failed. Run manually:');
    console.log(`  codex mcp add cortex -- node "${bundlePath}"`);
  }
}

function globalUnregisterCodex() {
  if (!canRun(codexCmd, ['--version'])) return;

  if (!codexHasCortex()) {
    console.log('Codex: cortex not registered, nothing to remove.');
    return;
  }

  console.log('Removing cortex from Codex...');
  const result = spawnPlatform(codexCmd, ['mcp', 'remove', 'cortex'], { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.log('Codex removal failed. Run manually: codex mcp remove cortex');
  }
}

function globalRegisterHooks() {
  const settingsPath = getClaudeSettingsPath();
  console.log(`Merging cortex hooks into ${settingsPath}...`);

  const settings = readJsonFile(settingsPath);
  mergeHooksIntoSettings(settings);
  writeJsonFile(settingsPath, settings);

  console.log('Hooks registered in Claude Code user settings.');
}

function globalUnregisterHooks() {
  const settingsPath = getClaudeSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    console.log('No settings.json found, nothing to clean up.');
    return;
  }

  console.log(`Removing cortex hooks from ${settingsPath}...`);
  const settings = readJsonFile(settingsPath);
  removeCortexHooksFromSettings(settings);
  writeJsonFile(settingsPath, settings);
  console.log('Hooks removed from Claude Code user settings.');
}

// --- Entrypoints ---

function ensureBuild() {
  if (!fs.existsSync(serverDir)) {
    throw new Error(`Missing server directory: ${serverDir}`);
  }

  if (!fs.existsSync(path.join(serverDir, 'node_modules'))) {
    console.log('Installing server dependencies...');
    runOrThrow(npmCmd, ['install'], serverDir);
  }

  ensureSqliteVecRuntime();

  console.log('Building MCP server...');
  runOrThrow(npmCmd, ['run', 'build'], serverDir);

  if (!fs.existsSync(bundlePath)) {
    throw new Error(`Build succeeded but bundle was not found: ${bundlePath}`);
  }

  const envVecPath = process.env.CORTEX_VEC_DLL_PATH || '';
  const hasEnvDll = envVecPath && fs.existsSync(envVecPath);
  const hasLocalDll = fs.existsSync(vecDllPath);
  const hasSqliteVecPackage = fs.existsSync(sqliteVecModuleDir);
  if (isWindows && !hasSqliteVecPackage && !hasLocalDll && !hasEnvDll) {
    console.log('');
    console.log('sqlite-vec runtime not found (auto-fallback to JS embeddings).');
    console.log('Expected one of:');
    console.log(`  - npm package sqlite-vec (auto-install failed)`);
    console.log(`  - ${vecDllPath}`);
    console.log('  - CORTEX_VEC_DLL_PATH=<absolute-path-to-vec0.dll>');
  }
}

function ensureSqliteVecRuntime() {
  if (!isWindows) return;
  if (fs.existsSync(sqliteVecModuleDir)) return;

  console.log(`Installing sqlite-vec runtime (sqlite-vec@${SQLITE_VEC_VERSION})...`);
  try {
    runOrThrow(npmCmd, ['install', '--no-save', `sqlite-vec@${SQLITE_VEC_VERSION}`], serverDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`sqlite-vec auto-install failed (${message}). Continuing with JS embedding fallback.`);
  }
}

function mainLocal() {
  ensureBuild();

  writeClaudeMcpConfig();
  console.log(`Wrote Claude project config: ${mcpConfigPath}`);

  tryRegisterCodex();

  console.log('');
  console.log('Done.');
  console.log('Claude Code: open this repo and MCP loads from .mcp.json');
  console.log(`Codex: server command is node "${bundlePath}"`);
}

function mainGlobalInstall() {
  ensureBuild();

  console.log('');
  console.log('=== Global Install ===');
  console.log(`Bundle: ${bundlePath}`);
  console.log('');

  globalRegisterClaudeMcp();
  console.log('');

  globalRegisterCodex();
  console.log('');

  globalRegisterHooks();

  console.log('');
  console.log('Done. Cortex is now available globally for all projects.');
  console.log('Restart Claude Code to activate.');
}

function mainGlobalUninstall() {
  console.log('=== Global Uninstall ===');
  console.log('');

  globalUnregisterClaudeMcp();
  console.log('');

  globalUnregisterCodex();
  console.log('');

  globalUnregisterHooks();

  console.log('');
  console.log('Done. Cortex global registration removed.');
}

function main() {
  if (isGlobal && isUninstall) {
    mainGlobalUninstall();
  } else if (isGlobal) {
    mainGlobalInstall();
  } else {
    mainLocal();
  }
}

main();
