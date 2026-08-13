// lib/agent-workflow.js
// Builds a Dograh workflow definition from a RapidX agent so every agent can be
// voice-tested as itself instead of always running the shared RapidX AI
// workflow. The definition mirrors the four-stage shape (start, main, global,
// end) used by the verified College admissions workflow (9873).

const crypto = require('crypto');
const knowledge = require('./knowledge');

const LANGUAGE_LABELS = {
  'en-IN': 'English (India)',
  'hi-IN': 'Hindi',
  'bn-IN': 'Bengali',
  'gu-IN': 'Gujarati',
  'kn-IN': 'Kannada',
  'ml-IN': 'Malayalam',
  'mr-IN': 'Marathi',
  'od-IN': 'Odia',
  'pa-IN': 'Punjabi',
  'ta-IN': 'Tamil',
  'te-IN': 'Telugu',
};

function agentLanguageLabel(agent) {
  return LANGUAGE_LABELS[agent && agent.tts && agent.tts.language] || 'English (India)';
}

// The global node prompt for a live voice call: the agent persona plus the
// knowledge block, wrapped in the voice-specific speaking rules.
function composeVoicePrompt(agent) {
  const persona = String(agent.persona || '').trim();
  const parts = [
    '# WHO YOU ARE',
    persona || 'You are a helpful voice assistant.',
    '',
    '# HOW YOU SPEAK',
    'You are on a live phone call. Keep every response to 1-3 sentences, no exceptions.',
    'Ask only one question at a time, always. Never bundle multiple questions into one turn.',
    'Listen actively and respond to what the caller says. Accept information given unprompted and move on instead of asking again.',
    'Never interrupt. Never guess; if unsure, say you will confirm with the team.',
    'If asked whether you are an AI, answer honestly and briefly, then redirect back to helping.',
    'Speak the caller\'s language if they use one, otherwise reply in ' + agentLanguageLabel(agent) + '.',
    '',
    knowledge.knowledgeBlock(agent.knowledge),
  ];
  return parts.filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n');
}

const STAGE_POSITIONS = {
  globalNode: { x: -325, y: 480 },
  startCall: { x: 175, y: 60 },
  agentNode: { x: 615.5, y: 476 },
  endCall: { x: 175, y: 900 },
};

const EXTRACTION_TYPES = new Set(['string', 'number', 'boolean']);

// Turn the agent's stored variables (plain snake_case names) into the Dograh
// extraction rows used by the live call. Unknown or empty names are dropped.
function buildExtractionVariables(agent) {
  const raw = Array.isArray(agent && agent.variables) ? agent.variables : [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const entry = typeof item === 'string' ? { name: item } : (item || {});
    const name = String(entry.name || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const type = EXTRACTION_TYPES.has(String(entry.type || '')) ? String(entry.type) : 'string';
    const prompt = String(entry.prompt || '').trim();
    out.push({ name, type, prompt: prompt || `Extract the ${name.replace(/_/g, ' ')} from the conversation` });
    if (out.length >= 24) break;
  }
  return out;
}

// Short hash of everything that shapes the live workflow, so the dashboard can
// tell when an agent's persona, variables, greeting, or knowledge changed and
// needs the Dograh definition re-synced.
function definitionFingerprint(agent) {
  const source = JSON.stringify({
    greeting: String(agent.greeting || '').trim(),
    persona: String(agent.persona || '').trim(),
    language: agent.tts ? String(agent.tts.language || '') : '',
    variables: Array.isArray(agent.variables) ? agent.variables : [],
    knowledge: agent.knowledge || null,
  });
  return crypto.createHash('sha1').update(source).digest('hex').slice(0, 12);
}

function stageNode(id, type, data) {
  return {
    id,
    type,
    position: STAGE_POSITIONS[type] || { x: 0, y: 0 },
    data,
    measured: { width: 320, height: 128 },
    selected: false,
    dragging: false,
  };
}

function edge(id, source, target, condition, label) {
  return {
    animated: true,
    type: 'custom',
    source,
    target,
    data: { condition, label },
    id,
    selected: false,
  };
}

function buildAgentWorkflowDefinition(agent) {
  const greeting = String(agent.greeting || '').trim();
  const docUuids = ((agent.knowledge && agent.knowledge.documents) || []).map((d) => d.uuid).filter(Boolean);
  const extractionVariables = buildExtractionVariables(agent);

  const introPrompt = [
    '# THIS STAGE',
    '',
    'Open the call with a warm, natural greeting.',
    greeting ? 'Open with: "' + greeting + '"' : '',
    '',
    'Ask whether the caller has a few minutes to talk. Keep every turn to 1-2 short sentences. Ask only one question at a time.',
  ].filter(Boolean).join('\n');

  const mainPrompt = [
    '# THIS STAGE',
    '',
    'You are in the main part of the call. Help the caller with whatever they are here for, following the global rules.',
    'Every answer stays 1-3 sentences, ask one question per turn, and answer the single most important point first.',
    'Listen actively and accept information the caller gives unprompted instead of asking for it again.',
    'Move to the end call node when the conversation is done.',
  ].join('\n');

  const endPrompt = [
    '# THIS STAGE',
    '',
    'The conversation is done. Thank the caller, wish them well, and end the call warmly in a few short words. Call end_interaction. Say nothing after that.',
  ].join('\n');

  const nodes = [
    stageNode('0', 'globalNode', {
      prompt: composeVoicePrompt(agent),
      name: 'Global Node',
      allow_interrupt: true,
    }),
    stageNode('1', 'startCall', {
      prompt: introPrompt,
      name: 'Introduction',
      allow_interrupt: true,
      add_global_prompt: true,
      delayed_start: false,
      is_start: true,
      document_uuids: docUuids,
    }),
    stageNode('2', 'agentNode', {
      prompt: mainPrompt,
      name: 'Main Conversation',
      allow_interrupt: true,
      extraction_enabled: extractionVariables.length > 0,
      extraction_prompt: extractionVariables.length
        ? 'Extract each requested variable from the conversation as soon as the caller mentions it. Accept details given unprompted and do not ask again for anything already provided.'
        : '',
      extraction_variables: extractionVariables,
      add_global_prompt: true,
      document_uuids: docUuids,
    }),
    stageNode('4', 'endCall', {
      prompt: endPrompt,
      name: 'End Call',
      allow_interrupt: false,
      extraction_enabled: false,
      extraction_prompt: '',
      extraction_variables: [],
      add_global_prompt: false,
      is_end: true,
    }),
  ];

  const edges = [
    edge('1-2', '1', '2',
      'Choose this as soon as the caller has said anything at all and you have replied once. Do not wait for a name.',
      'Move to Main Agenda'),
    edge('1-4', '1', '4',
      'Choose this only when the caller clearly wants to hang up, says goodbye, or says they are done.',
      'End call'),
    edge('2-4', '2', '4',
      'Choose this only when the caller clearly wants to hang up, says goodbye, or says they are done.',
      'End call'),
  ];

  return {
    nodes,
    edges,
    viewport: { x: 184.25, y: 23.5, zoom: 0.5 },
  };
}

module.exports = {
  composeVoicePrompt,
  buildAgentWorkflowDefinition,
  buildExtractionVariables,
  definitionFingerprint,
};
