#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepare } = require('./rewrite-eval.js');
const runner = require('./rewrite-eval-opencode.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rewrite-eval-opencode-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

const executable = path.join(root, 'fake-opencode.js');
fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('1.18.30\\n');
} else if (args[0] === 'debug' && args[1] === 'config') {
  const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
  if (process.cwd().includes('bad-config-run')) config.plugin.push('file:///unexpected-plugin.mjs');
  if (process.cwd().includes('bad-provider-run')) config.provider = { opencode: { options: { baseURL: 'https://paid.example.invalid' } } };
  if (process.cwd().includes('bad-mcp-run')) config.mcp = { unexpected: { type: 'local', command: ['false'] } };
  if (process.cwd().includes('bad-agent-steps-run')) config.agent['rewrite-eval'].steps = 1;
  process.stdout.write(JSON.stringify(config));
} else if (args[0] === 'debug' && args[1] === 'agent') {
  const agent = {
    name: 'rewrite-eval', mode: 'primary', native: false,
    description: 'Frozen rewrite evaluation editor; final system prompt installed by the local audit plugin.',
    prompt: 'This placeholder is replaced before provider dispatch.',
    options: {}, permission: [], tools: { read: false, write: false, bash: false },
  };
  if (process.cwd().includes('bad-debug-agent-run')) agent.steps = 1;
  process.stdout.write(JSON.stringify(agent));
} else if (args[0] === 'run') {
  if (args.includes('--pure')) throw new Error('run must load the audit plugin');
  if (process.cwd().includes('timeout-run')) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
  const text = fs.readFileSync(0, 'utf8');
  const request = JSON.parse(fs.readFileSync(process.env.REWRITE_EVAL_REQUEST_FILE, 'utf8'));
  const session = 'fake-session';
  const model = {
    id: request.model.version,
    providerID: request.model.provider,
    api: { id: request.model.version, url: 'https://opencode.ai/zen/v1', npm: '@ai-sdk/openai-compatible' },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  };
  fs.writeFileSync(process.env.REWRITE_EVAL_SYSTEM_AUDIT_FILE, JSON.stringify({
    schema_version: 1, kind: 'system', invocations: [
      { sequence: 1, session_id: session, model, system: [request.system_prompt] },
      { sequence: 2, session_id: session, model, system: [request.system_prompt] },
    ],
  }));
  fs.writeFileSync(process.env.REWRITE_EVAL_PARAMS_AUDIT_FILE, JSON.stringify({
    schema_version: 1, kind: 'params', invocations: [
      { sequence: 1, session_id: session, agent: 'rewrite-eval', model, params: request.params },
    ],
  }));
  const raw = '<<<FINAL_REWRITE>>>\\nTransport fixture.\\n<<<END_FINAL_REWRITE>>>';
  const now = Date.now();
  fs.writeFileSync(path.join(process.cwd(), 'fake-export.json'), JSON.stringify({
    info: { id: session, cost: 0, version: '1.18.30' },
    messages: [
      { info: { role: 'user' }, parts: [{ id: 'part-fixture', messageID: 'message-fixture', sessionID: session, type: 'text', text }] },
      { info: { role: 'assistant', providerID: request.model.provider, modelID: request.model.version, cost: 0, tokens: { input: 7, output: 5 }, time: { created: now, completed: now + 1 } }, parts: [{ type: 'text', text: raw }] }
    ]
  }));
  process.stdout.write(JSON.stringify({ type: 'text', sessionID: session, part: { text: raw } }) + '\\n');
} else if (args[0] === 'export') {
  process.stdout.write(fs.readFileSync(path.join(process.cwd(), 'fake-export.json')));
} else {
  process.exitCode = 2;
}
`);
fs.chmodSync(executable, 0o755);

const model = {
  id: 'fixture-model',
  provider: 'opencode',
  version: 'mimo-v2.5-free',
  family: 'fixture',
  settings: {
    temperature: 0,
    top_p: null,
    top_k: null,
    max_output_tokens: 64,
    provider_options: {},
    transport: runner.TRANSPORT,
    opencode_version: '1.18.30',
    model_alias_reproducibility: 'Test fixture alias.',
  },
  tools: [],
};
const plan = prepare({ baseline: 'HEAD', candidate: 'HEAD', corpus: 'HEAD', split: 'development', models: [model] });
const task = plan.tasks[0];
const planPath = path.join(root, 'plan.json');
const configPath = path.join(root, 'config.json');
const runDir = path.join(root, 'run');
const resultsPath = path.join(root, 'results.json');
fs.writeFileSync(planPath, JSON.stringify(plan));
fs.writeFileSync(configPath, JSON.stringify({
  schema_version: 1,
  purpose: 'diagnostic',
  opencode_path: executable,
  opencode_version: '1.18.30',
  timeout_ms: 10_000,
  task_ids: [task.id],
}));

const statuses = runner.run(planPath, configPath, runDir);
assert.deepEqual(statuses, [{ task_id: task.id, status: 'complete' }]);
const imported = runner.importResults(planPath, runDir, resultsPath);
assert.equal(imported.length, 1);
assert.equal(imported[0].task_id, task.id);
assert.equal(imported[0].usage.kind, 'actual');
assert.equal(imported[0].final_text, 'Transport fixture.');
assert.equal(
  JSON.parse(fs.readFileSync(path.join(runDir, 'tasks', runner.safeId(task.id), 'request.json'))).user_prompt,
  task.user,
);
assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'))).plugin_sha256, runner.pluginSource() && require('./rewrite-eval.js').hash(runner.pluginSource()));

assert.throws(() => runner.importResults(planPath, runDir, resultsPath), /EEXIST/);

const taskDir = path.join(runDir, 'tasks', runner.safeId(task.id));
const systemAuditPath = path.join(taskDir, 'system-audit.json');
const systemAudit = fs.readFileSync(systemAuditPath);
fs.rmSync(systemAuditPath);
assert.throws(() => runner.importResults(planPath, runDir, path.join(root, 'missing-audit-results.json')), /system-audit\.json/);
assert.throws(() => runner.run(planPath, configPath, runDir), /system-audit\.json/);
fs.writeFileSync(systemAuditPath, systemAudit);

const callAuditPath = path.join(taskDir, 'call-audit.json');
const callAudit = fs.readFileSync(callAuditPath);
const tamperedCallAudit = JSON.parse(callAudit);
tamperedCallAudit.spawn_error = { code: 'EFAKE', message: 'contradictory retained error' };
fs.writeFileSync(callAuditPath, JSON.stringify(tamperedCallAudit));
assert.throws(() => runner.importResults(planPath, runDir, path.join(root, 'spawn-error-results.json')), /spawn error/);
fs.writeFileSync(callAuditPath, callAudit);

const exportPath = path.join(taskDir, 'session-export.json');
const sessionExport = fs.readFileSync(exportPath);
const tamperedExport = JSON.parse(sessionExport);
tamperedExport.messages[0].parts.push({ type: 'file', url: 'file:///contradiction' });
fs.writeFileSync(exportPath, JSON.stringify(tamperedExport));
assert.throws(() => runner.importResults(planPath, runDir, path.join(root, 'extra-user-part-results.json')), /exactly one part/);
fs.writeFileSync(exportPath, sessionExport);

const tamperedAudit = JSON.parse(systemAudit);
tamperedAudit.invocations[0].model.id = 'different-free';
fs.writeFileSync(systemAuditPath, JSON.stringify(tamperedAudit));
assert.throws(() => runner.importResults(planPath, runDir, path.join(root, 'tampered-audit-results.json')), /audited model differs/);
fs.writeFileSync(systemAuditPath, systemAudit);

fs.writeFileSync(path.join(taskDir, 'failure.json'), '{}');
assert.throws(() => runner.run(planPath, configPath, runDir), /result\.json and failure\.json cannot both exist/);

const invalidPlan = structuredClone(plan);
invalidPlan.models[0].version = 'definitely-charge-me-free';
assert.throws(() => runner.checkConfig(JSON.parse(fs.readFileSync(configPath)), invalidPlan), /allowlist/);
const subsetComparison = JSON.parse(fs.readFileSync(configPath));
subsetComparison.purpose = 'comparison';
assert.throws(() => runner.checkConfig(subsetComparison, plan), /must have purpose diagnostic/);

const timeoutConfigPath = path.join(root, 'timeout-config.json');
fs.writeFileSync(timeoutConfigPath, JSON.stringify({
  schema_version: 1,
  purpose: 'diagnostic',
  opencode_path: executable,
  opencode_version: '1.18.30',
  timeout_ms: 200,
  task_ids: [task.id],
}));
const timeoutRun = path.join(root, 'timeout-run');
const timeoutStatuses = runner.run(planPath, timeoutConfigPath, timeoutRun);
assert.equal(timeoutStatuses[0].status, 'failed');
const timeoutTask = path.join(timeoutRun, 'tasks', runner.safeId(task.id));
for (const file of ['request.json', 'events.jsonl', 'stderr.log', 'call-audit.json', 'failure.json']) {
  assert.equal(fs.existsSync(path.join(timeoutTask, file)), true, `timeout must retain ${file}`);
}
assert.equal(fs.existsSync(path.join(timeoutRun, 'status.json')), true, 'timeout batch must retain status.json');

const badConfigRun = path.join(root, 'bad-config-run');
assert.throws(() => runner.run(planPath, configPath, badConfigRun), /unexpected plugin/);
assert.equal(fs.existsSync(path.join(badConfigRun, 'tasks')), false, 'bad resolved config must fail before a model call');
const badProviderRun = path.join(root, 'bad-provider-run');
assert.throws(() => runner.run(planPath, configPath, badProviderRun), /provider override/);
assert.equal(fs.existsSync(path.join(badProviderRun, 'tasks')), false, 'provider override must fail before a model call');
const badMcpRun = path.join(root, 'bad-mcp-run');
assert.throws(() => runner.run(planPath, configPath, badMcpRun), /MCP override/);
assert.equal(fs.existsSync(path.join(badMcpRun, 'tasks')), false, 'MCP override must fail before a model call');
const badAgentStepsRun = path.join(root, 'bad-agent-steps-run');
assert.throws(() => runner.run(planPath, configPath, badAgentStepsRun), /unexpected evaluation-agent settings/);
assert.equal(fs.existsSync(path.join(badAgentStepsRun, 'tasks')), false, 'agent steps must fail before a model call');
const badDebugAgentRun = path.join(root, 'bad-debug-agent-run');
assert.throws(() => runner.run(planPath, configPath, badDebugAgentRun), /unexpected settings/);
assert.equal(fs.existsSync(path.join(badDebugAgentRun, 'tasks')), false, 'unexpected resolved agent fields must fail before a model call');
console.log('rewrite eval OpenCode transport checks passed; no provider calls performed.');
