/**
 * Claude Code ignores `mcpServers` inside --settings; default MCP servers must
 * ride in a separate file passed with --mcp-config (t-066).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};
const { HiveManager } = loadTs('src/main/hive.ts');

test('claude agent gets default MCP servers via --mcp-config, not via --settings', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mcpcfg-'));
  const hive = new HiveManager(() => home);
  const inj = await hive.ensureAgent(
    { id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home },
    { mcpDefaults: { time: { enabled: true } } }
  );
  const m = inj.args.indexOf('--mcp-config');
  assert.ok(m >= 0, 'claude spawn carries --mcp-config');
  const cfg = JSON.parse(fs.readFileSync(inj.args[m + 1], 'utf8'));
  assert.ok(cfg.mcpServers['munder-time'], 'enabled server is in the mcp config file');
  const s = inj.args.indexOf('--settings');
  const settings = JSON.parse(fs.readFileSync(inj.args[s + 1], 'utf8'));
  assert.equal(settings.mcpServers, undefined, 'settings no longer carries mcpServers');
});

test('magento stays fail-closed: no project config, no munder-magento', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mcpcfg-'));
  const hive = new HiveManager(() => home);
  const inj = await hive.ensureAgent(
    { id: 'jim-2', name: 'Jim', provider: 'claude', cwd: home },
    { mcpDefaults: { time: { enabled: true }, magento: { enabled: true, command: 'node', args: ['x.js'] } }, magento: { denyRead: [] } }
  );
  const cfg = JSON.parse(fs.readFileSync(inj.args[inj.args.indexOf('--mcp-config') + 1], 'utf8'));
  assert.equal(cfg.mcpServers['munder-magento'], undefined);
});
