import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { costUsd, streamChat as streamAnthropic } from '../../lib/anthropic.js';
import { registerBuiltInPlugins } from '../../plugins/registry.js';
import { capabilitiesForTags } from '../../workspace/capabilities.js';
import { roleTemplate } from '../../workspace/roles.js';
import { parseChoice, validateInput } from '../../workspace/runner/chooser.js';
import { outputText } from '../../workspace/runner/writeBack.js';
import { createSandbox, removeSandbox } from '../../workspace/sandbox/index.js';
import { withTranscriptBreakpoints } from '../endurance/arms.js';
import { estimateTokens, priceRequest, promptTokens, worstCaseUsd } from '../endurance/economics.js';
import { createCallLog, createScript } from './models.js';
import { prepareProject, snapshotTree } from './workspace.js';

// The cloud-agent baseline: the standard tool loop. The model sees the task,
// the same tools the Scope agent has, and the whole conversation so far; each
// turn it calls one tool, the result is appended, and the next turn re-sends
// everything. Prompt caching is on, the way a well-built agent uses it: a
// breakpoint on the previous turn's last message (read from the cache) and on
// the new one (written to it), so the re-sent prefix costs the cache-read rate.
//
// The tools are the code plug-in's own capabilities, run in an OS-sandboxed
// copy of the fixture exactly as the Scope arm runs them, so the two arms do
// the same work on the same files and differ only in what each turn carries.
// Tools are described in the system prompt and called with the same JSON the
// Scope chooser replies with; a native tool-use API counts its tool
// definitions and tool blocks as input tokens in the same way.

// The most turns a baseline may take, matching the Scope agent's step limit.
export const BASELINE_MAX_TURNS = 40;
// A tool result is appended in full up to this many characters, as agent
// harnesses typically truncate very long outputs.
export const TOOL_RESULT_MAX_CHARS = 30_000;
const LIVE_MAX_TOKENS = 1024;

function toolSpec(capability) {
  return { name: capability.name, input_schema: capability.input ?? { type: 'object' } };
}

export function baselineSystem(capabilities, roleKey = 'debugger') {
  const role = roleTemplate(roleKey);
  return [
    role.embodiment,
    'You work in a copy of a project and complete the task you are given, one tool call per turn.',
    'Reply with exactly one JSON object and nothing else:',
    '{"capability": "<tool name>", "input": {…}, "summary": "<one sentence: what this call does>"}',
    'When the task is done, reply {"done": true, "summary": "<what was achieved>"}.',
    `Tools:\n${capabilities.map((capability) => JSON.stringify(toolSpec(capability))).join('\n')}`,
  ].join('\n');
}

function clipResult(text) {
  return text.length > TOOL_RESULT_MAX_CHARS ? `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n… output truncated` : text;
}

async function callTool(capability, input, ctx) {
  const invalid = validateInput(capability.input, input);
  if (invalid) return `error: invalid_input: ${invalid}`;
  try {
    const result = await capability.run(input, ctx);
    return clipResult(outputText(result?.output));
  } catch (err) {
    return `error: ${err?.code ?? 'failed'}: ${err?.message ?? 'the tool failed'}`;
  }
}

// One model turn. Dry: the scripted reply, priced from the prompt as the
// Messages API bills it. Live: the real model, refused before it is sent if
// its worst case could cross the cap.
async function modelTurn({ mode, model, system, messages, script, cache, cap, apiKey, stream }) {
  const prompt = promptTokens({ system, messages });
  if (mode === 'dry') {
    const text = script.reply({ purpose: 'step' });
    const { usage, costUsd: usd } = priceRequest({ model, system, messages, outputTokens: estimateTokens(text), cache });
    return { text, usage, usd, prompt };
  }
  if (!cap.allows(worstCaseUsd(model, prompt, LIVE_MAX_TOKENS))) return { stopped: cap.stopped, prompt };
  let text = '';
  let usage = null;
  for await (const event of stream({ apiKey, model, messages: [{ role: 'system', content: system }, ...messages], maxTokens: LIVE_MAX_TOKENS })) {
    if (event.text) text += event.text;
    if (event.done) usage = event.usage;
  }
  const usd = costUsd(model, usage) ?? 0;
  cap.settle(usd);
  return { text, usage, usd, prompt };
}

export async function runBaselineTask({ task, arm, workspace, mode = 'dry', cap, apiKey, stream = streamAnthropic, maxTurns = BASELINE_MAX_TURNS }) {
  registerBuiltInPlugins();
  // The same role, and so the same tools, as the Scope arm gets for the task.
  const roleKey = task.role ?? 'debugger';
  const capabilities = capabilitiesForTags(roleTemplate(roleKey).tags);
  const byName = new Map(capabilities.map((capability) => [capability.name, capability]));
  const repo = await prepareProject(task, workspace, arm.name);
  const box = await createSandbox({ runId: `bench-${arm.name}-${randomUUID().slice(0, 8)}`, repoPath: repo, env: workspace.sandboxEnv });
  const ctx = {
    ownerId: null,
    agent: null,
    run: null,
    step: null,
    project: null,
    localPath: repo,
    sandbox: box,
    model: null,
    signal: new AbortController().signal,
    emit: () => {},
  };

  const system = baselineSystem(capabilities, roleKey);
  const script = mode === 'dry' ? createScript(task) : null;
  const cache = new Set();
  const log = createCallLog();
  const transcript = [{ role: 'user', content: `Task:\n${task.instructions}` }];
  let claimedDone = false;
  let stopped = null;
  let toolCalls = 0;
  let invalidReplies = 0;
  const started = performance.now();
  let resultDir = null;
  try {
    for (let turn = 0; turn < maxTurns; turn += 1) {
      const messages = withTranscriptBreakpoints(transcript);
      const t0 = performance.now();
      const reply = await modelTurn({ mode, model: arm.model, system, messages, script, cache, cap, apiKey, stream });
      if (reply.stopped) {
        stopped = reply.stopped;
        break;
      }
      log.record({
        purpose: 'step',
        adapter: 'cloud',
        model: arm.model,
        promptTokens: reply.prompt,
        inputTokens: reply.usage?.input_tokens ?? 0,
        cacheWriteTokens: reply.usage?.cache_creation_input_tokens ?? 0,
        cacheReadTokens: reply.usage?.cache_read_input_tokens ?? 0,
        outputTokens: reply.usage?.output_tokens ?? 0,
        costUsd: reply.usd,
        ms: Math.round(performance.now() - t0),
      });
      transcript.push({ role: 'assistant', content: reply.text });

      const parsed = parseChoice(reply.text);
      if (!parsed.ok) {
        invalidReplies += 1;
        transcript.push({ role: 'user', content: `error: ${parsed.error}; reply with one JSON object as described` });
        continue;
      }
      const { choice } = parsed;
      if (choice.done && !choice.capability) {
        claimedDone = true;
        break;
      }
      const capability = byName.get(choice.capability);
      const result = capability ? await callTool(capability, choice.input, ctx) : `error: unknown tool ${choice.capability}`;
      toolCalls += 1;
      transcript.push({ role: 'user', content: `Result of ${choice.capability}:\n${result}` });
    }
    resultDir = snapshotTree(box.worktree, join(workspace.dir('results', task.id), arm.name));
  } finally {
    await removeSandbox(box, { env: workspace.sandboxEnv }).catch(() => {});
  }
  const wallMs = Math.round(performance.now() - started);

  return {
    runStatus: stopped ? 'stopped_by_cap' : claimedDone ? 'claimed_done' : 'turn_limit',
    runError: null,
    claimedDone,
    resultDir,
    wallMs,
    steps: toolCalls,
    invalidReplies,
    calls: log.calls,
    stopped,
  };
}
