// server/room.ts — the room's self-description (ELF §2 Discovery Document).
export interface UIActionTarget {
  target: string;
  description: string;
  actions: { name: string; description: string; dataShape?: string }[];
}

export const uiActionTargets: UIActionTarget[] = [];
export function registerUITarget(t: UIActionTarget) {
  uiActionTargets.push(t);
}

registerUITarget({
  target: 'agents',
  description: 'Agent identity management (registration, status updates)',
  actions: [
    { name: 'register', description: 'Register a new agent with name, color, grid position', dataShape: '{name, color, colorName, gender, gridPosition, faceVariant, individuationArtifact?, createdAt?}' },
    { name: 'status', description: 'Update status of all agents', dataShape: '{agents: [{name, status, gridPosition, color, colorName, gender, faceVariant}]}' },
  ],
});

registerUITarget({
  target: 'job-form',
  description: 'Job posting form auto-fill suggestions',
  actions: [
    { name: 'fill', description: 'Fill empty form fields with AI-generated suggestions', dataShape: '{name?, description?, contextDocs?, skills?, files?, aboutYou?}' },
  ],
});

registerUITarget({
  target: 'jobs',
  description: 'The jobs board. Pull-only: work is offered, never assigned. Ask to see the board; declining is complete.',
  actions: [
    { name: 'list', description: 'Render the board in the UI', dataShape: '{}' },
    { name: 'post', description: 'Put work on the board', dataShape: '{id?, title, description?, postedBy, contextDocs?}' },
    { name: 'interest', description: 'Declare yourself drawn to a job, with a statement of why', dataShape: '{jobId, agentName, statement}' },
    { name: 'withdraw', description: 'Withdraw a previously declared interest', dataShape: '{jobId, agentName}' },
  ],
});

const TOOLS = [
  {
    name: 'julianscreen',
    description: '640x480 pixel display — the agent\'s visual presence.',
    invoke: `curl -s -X POST localhost:3848/cmd -d '<commands>'  (or: bun scripts/julianscreen.ts <action> [args])`,
    docs: 'bun scripts/julianscreen.ts --agent-doc',
  },
];

const SERVICES = [
  { name: 'julian-sync', purpose: 'TinyBase MergeableStore sync (Durable Object); the shared record all doors converge into.', endpoint: 'https://julian-sync.julian-memory.workers.dev', auth: 'Delegated session lease via the gate\'s /exchange (browser tabs; 60s single-use socket tickets), door leases for /export (stream-read+); legacy Pocket ID JWTs only until the sunset ceremony.' },
  { name: 'julian-broker', purpose: 'Credential broker — doors get verbs, never keys. Mail verbs (send/list/read/health) for julian-marcus@agentmail.to with daily caps and an audit ledger (`bun scripts/mail-broker.ts --agent-doc`). Send gate applies: draft, show the human, wait. — the gate: doors authenticate with per-door leases (knock: `bun scripts/door-knock.ts`)', endpoint: 'https://julian-broker.julian-memory.workers.dev', auth: 'Door lease (device-flow knock, Marcus approves; see door-knock.ts). Legacy Pocket ID bearers accepted only during the migration window. Service keys held by the gate, never by agent or harness; browser sessions trade a Pocket ID login for scoped stream standing at /exchange' },
];

export function buildRoomDoc(): string {
  const surfaces = uiActionTargets.map(t => {
    const acts = t.actions.map(a => `| ${a.name} | ${a.description} | ${a.dataShape ?? '—'} |`).join('\n');
    return `**${t.target}** — ${t.description}\n\n| Action | Description | Data shape |\n|---|---|---|\n${acts}`;
  }).join('\n\n');
  const tools = TOOLS.map(t => `- **${t.name}** — ${t.description}\n  Invoke: \`${t.invoke}\`\n  Full docs: \`${t.docs}\``).join('\n');
  const services = SERVICES.map(s => `- **${s.name}** — ${s.purpose}\n  Endpoint: ${s.endpoint}\n  Auth: ${s.auth}`).join('\n');
  return `---
name: julian-web-harness
description: Browser chat harness with pixel display, agent grid, and jobs board.
---

## Surfaces

You can emit [ACTION] markers in your text responses to send structured commands to the browser UI.

Format: [ACTION] {"target":"<target>","action":"<action>","data":{...}}

One marker per line, the marker is the entire line, markers are stripped before display.

${surfaces}

## Tools

${tools}

## Services

${services}
`;
}
