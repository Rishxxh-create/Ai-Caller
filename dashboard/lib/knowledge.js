'use strict';

/* ==========================================================================
   RapidX Voice. Agent knowledge base helpers.

   An agent can carry two kinds of knowledge:

   - facts: short titled text entries the tenant pastes. They are injected
     straight into the LLM system prompt (web brain and live workflow), so
     the agent can answer from them with no extra provider or retrieval.

   - documents: references to documents uploaded to Dograh's native knowledge
     base. At call time Dograh retrieves relevant chunks through its
     retrieve_from_knowledge_base tool. This file only normalizes the
     attachment list; the upload and embedding stay on Dograh's side.

   No em dashes anywhere. Commas and periods only.
   ========================================================================== */

const MAX_FACTS = 20;
const MAX_FACT_TITLE = 120;
const MAX_FACT_CONTENT = 6000;
const MAX_FACTS_CHARS = 40000;
const MAX_DOCUMENTS = 50;

function factId() {
  return 'kf_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// Normalize a raw facts array into a bounded list of { id, title, content }.
function normalizeFacts(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  let total = 0;
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const title = String(raw.title || '').trim().slice(0, MAX_FACT_TITLE);
    const content = String(raw.content || '').trim().slice(0, MAX_FACT_CONTENT);
    if (!content) continue;
    if (out.length >= MAX_FACTS) break;
    total += title.length + content.length;
    if (total > MAX_FACTS_CHARS) break;
    out.push({
      id: String(raw.id || factId()).slice(0, 40),
      title,
      content,
    });
  }
  return out;
}

// Normalize the document attachment list into a bounded array of
// { uuid, filename, status, sizeBytes, createdAt }.
function normalizeDocuments(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const d of input) {
    if (!d || typeof d !== 'object') continue;
    const uuid = String(d.uuid || '').trim();
    if (!uuid || seen.has(uuid)) continue;
    seen.add(uuid);
    out.push({
      uuid,
      filename: String(d.filename || uuid).slice(0, 200),
      status: String(d.status || 'pending').slice(0, 20),
      sizeBytes: Number(d.sizeBytes) || 0,
      createdAt: String(d.createdAt || new Date().toISOString()),
    });
    if (out.length >= MAX_DOCUMENTS) break;
  }
  return out;
}

// Normalize the full agent.knowledge object, preserving existing documents
// when the caller only sends facts (and vice versa).
function normalizeKnowledge(input, existing) {
  const cur = (input && typeof input === 'object') ? input : {};
  const prev = (existing && typeof existing === 'object') ? existing : {};
  const out = {
    facts: normalizeFacts(cur.facts),
    documents: cur.documents != null
      ? normalizeDocuments(cur.documents)
      : normalizeDocuments(prev.documents),
  };
  const synced = String(cur.lastSyncedAt || prev.lastSyncedAt || '').trim();
  if (synced) out.lastSyncedAt = synced;
  return out;
}

// The prompt block appended to the persona for the web brain and to Dograh's
// global node prompt for the live voice agent. Idempotent, so the same block
// can be regenerated on every sync.
function knowledgeBlock(knowledge) {
  const parts = [];
  const facts = normalizeFacts(knowledge && knowledge.facts);
  if (facts.length) {
    parts.push('# KNOWLEDGE BASE (AUTHORITATIVE FACTS)');
    parts.push(
      'Use these facts to answer questions about the business. ' +
      'If the answer is not in them, say you are not sure rather than guessing.'
    );
    for (const f of facts) {
      parts.push((f.title ? '## ' + f.title + '\n' : '') + f.content);
    }
  }
  const docs = normalizeDocuments(knowledge && knowledge.documents);
  if (docs.length) {
    parts.push('# KNOWLEDGE BASE (UPLOADED DOCUMENTS)');
    parts.push(
      'You have uploaded documents attached to this workflow. When the caller asks ' +
      'about their content, call the retrieve_from_knowledge_base tool with a short ' +
      'query first, then answer from the retrieved chunks.'
    );
  }
  return parts.join('\n\n');
}

// The full system prompt for the web chat brain: persona plus knowledge.
function composeAgentPrompt(persona, knowledge) {
  const personaText = String(persona || '').trim();
  const block = knowledgeBlock(knowledge);
  return [personaText, block].filter(Boolean).join('\n\n');
}

// Strip any previously appended knowledge block from a node prompt so a sync
// can be re-run without stacking stale facts.
function stripKnowledgeBlock(prompt) {
  const text = String(prompt || '');
  const marker = text.indexOf('# KNOWLEDGE BASE (AUTHORITATIVE FACTS)');
  if (marker === -1) return text;
  return text.slice(0, marker).replace(/\s+$/, '');
}

module.exports = {
  MAX_FACTS,
  MAX_FACT_TITLE,
  MAX_FACT_CONTENT,
  MAX_FACTS_CHARS,
  MAX_DOCUMENTS,
  normalizeFacts,
  normalizeDocuments,
  normalizeKnowledge,
  knowledgeBlock,
  composeAgentPrompt,
  stripKnowledgeBlock,
};
