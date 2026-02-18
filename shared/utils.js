/**
 * Pure utility functions extracted from chat.jsx and index.html.
 * These are the canonical implementations for testing.
 * The browser runtime uses identical copies in chat.jsx (loaded via Babel).
 * Keep these in sync with their chat.jsx/index.html counterparts.
 */

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function truncate(str, maxLen) {
  if (typeof str !== 'string') return '';
  return str.length <= maxLen ? str : str.slice(0, maxLen) + '\u2026';
}

function renderMarkdown(text) {
  if (!text) return '';
  let html = escapeHtml(text);
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
    `<pre style="background:#1a1a00;border:1px solid #333;border-radius:4px;padding:8px 12px;overflow-x:auto;font-size:14px;line-height:1.5;margin:6px 0;color:#FFD600;font-family:'VT323',monospace"><code>${code.trim()}</code></pre>`
  );
  html = html.replace(/`([^`]+)`/g,
    '<code style="background:#1a1a00;padding:1px 4px;border-radius:2px;font-size:0.95em;color:#FFD600">$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/\n/g, '<br>');
  return html;
}

function formatToolInput(toolName, input) {
  if (!input) return '';
  if (typeof input === 'string') return truncate(input, 300);
  if (toolName === 'Read' && input.file_path) return input.file_path;
  if (toolName === 'Write' && input.file_path) return input.file_path;
  if (toolName === 'Edit' && input.file_path) return input.file_path;
  if (toolName === 'Bash' && input.command) return '$ ' + truncate(input.command, 200);
  if (toolName === 'Glob' && input.pattern) return input.pattern;
  if (toolName === 'Grep' && input.pattern) return input.pattern;
  if (toolName === 'Task' && input.description) return input.description;
  if (toolName === 'TaskCreate' && input.subject) return input.subject;
  if (toolName === 'TaskUpdate' && input.taskId) return 'Task #' + input.taskId + (input.status ? ' \u2192 ' + input.status : '');
  if (toolName === 'SendMessage' && input.recipient) return '\u2192 ' + input.recipient;
  if (toolName === 'WebFetch' && input.url) return truncate(input.url, 200);
  if (toolName === 'WebSearch' && input.query) return truncate(input.query, 200);
  try { return truncate(JSON.stringify(input, null, 2), 300); } catch { return ''; }
}

const EYE_KEYS = ['standard', 'round', 'narrow', 'wide'];
const MOUTH_KEYS = ['gentle', 'straight', 'cheerful', 'asymmetric'];

function hashNameToFaceVariant(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  hash = Math.abs(hash);
  return {
    eyes: EYE_KEYS[hash % EYE_KEYS.length],
    mouth: MOUTH_KEYS[(hash >> 4) % MOUTH_KEYS.length],
  };
}

function getAgentStatus(doc) {
  if (doc.status) return doc.status;
  return doc.hatching ? 'hatching' : 'sleeping';
}

function bumpDbName(name) {
  const match = name.match(/^(.+?-v)(\d+)$/);
  if (match) return match[1] + (parseInt(match[2]) + 1);
  return name + '-v2';
}

/**
 * Retry database.put() on transient WriteQueueImpl errors.
 * Used as a safety net for runtime writes after boot sequence completes.
 * @param {object} database - Fireproof database instance
 * @param {object} doc - Document to write
 * @param {number} maxRetries - Max retry count (default 3)
 */
async function resilientPut(database, doc, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await database.put(doc);
    } catch (err) {
      const isStoreError = err?.message?.includes('WriteQueueImpl')
        || err?.message?.includes('stores');
      if (!isStoreError || attempt === maxRetries) throw err;
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

/**
 * Compute the current boot phase from step state.
 * Used by BootUI to select the expression animation pool.
 * @param {object} steps - Boot step state object
 * @returns {number} 0=local, 1=cloud, 2=data, 3=complete
 */
function getBootPhase(steps) {
  if (!steps.localStores) return 0;
  if (steps.cloud === null) return 1;
  if (!steps.catalog || !steps.agents) return 2;
  return 3;
}

/**
 * Check if boot sequence is ready to transition to App.
 * @param {object} steps - Boot step state object
 * @returns {boolean} true when all required steps are resolved
 */
function isBootReady(steps) {
  const cloudResolved = steps.cloud !== null;
  return steps.database && steps.localStores && cloudResolved
    && steps.ledgerMeta && steps.catalog && steps.agents;
}

export {
  escapeHtml,
  truncate,
  renderMarkdown,
  formatToolInput,
  EYE_KEYS,
  MOUTH_KEYS,
  hashNameToFaceVariant,
  getAgentStatus,
  bumpDbName,
  resilientPut,
  getBootPhase,
  isBootReady,
};

if (typeof window !== 'undefined') {
  window.escapeHtml = escapeHtml;
  window.truncate = truncate;
  window.renderMarkdown = renderMarkdown;
  window.formatToolInput = formatToolInput;
  window.hashNameToFaceVariant = hashNameToFaceVariant;
  window.getAgentStatus = getAgentStatus;
  window.bumpDbName = bumpDbName;
  window.resilientPut = resilientPut;
  window.getBootPhase = getBootPhase;
  window.isBootReady = isBootReady;
}
