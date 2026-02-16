// JulianScreen command protocol parser + validation

const VALID_STATES = [
  'idle', 'happy', 'sad', 'excited', 'confused', 'thinking',
  'talking', 'working', 'sleeping', 'alert', 'busy', 'listening', 'reading'
];

const VALID_EVENTS = [
  'nod', 'shake', 'wave', 'celebrate', 'flinch', 'shrug'
];

const VALID_EFFECTS = [
  'sparkle', 'hearts', 'flash', 'shake', 'rain', 'snow', 'glitch'
];

const VALID_SCENES = [
  'home', 'outside', 'night', 'rain', 'empty', 'terminal', 'space'
];

const VALID_TILES = [
  'empty', 'floor', 'wall', 'brick', 'grass', 'sky', 'water', 'grid', 'dots', 'stars', 'circuit'
];

const VALID_LISTEN_TYPES = ['btn', 'tap', 'tick'];

const VALID_MENU_TABS = ['browser', 'skills', 'agents'];

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function parseInt10(s) {
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

function parseFloat10(s) {
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

export function parseCommand(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Strip optional @agent prefix
  const stripped = trimmed.replace(/^@\w+\s+/, '');
  const spaceIdx = stripped.indexOf(' ');
  const prefix = spaceIdx === -1 ? stripped : stripped.substring(0, spaceIdx);
  const rest = spaceIdx === -1 ? '' : stripped.substring(spaceIdx + 1);
  const args = rest ? rest.split(/\s+/) : [];

  switch (prefix) {
    // S <state> — Set avatar state
    case 'S': {
      const state = args[0]?.toLowerCase();
      if (!state || !VALID_STATES.includes(state)) {
        console.error(`[protocol] Invalid state: ${args[0]}`);
        return null;
      }
      return { type: 'STATE', state };
    }

    // E <event> — Trigger one-shot event
    case 'E': {
      const event = args[0]?.toLowerCase();
      if (!event || !VALID_EVENTS.includes(event)) {
        console.error(`[protocol] Invalid event: ${args[0]}`);
        return null;
      }
      return { type: 'EVENT', event };
    }

    // P <tx> <ty> — Position avatar at tile coords
    case 'P': {
      const tx = parseInt10(args[0]);
      const ty = parseInt10(args[1]);
      if (tx === null || ty === null) {
        console.error(`[protocol] Invalid position: ${rest}`);
        return null;
      }
      return { type: 'POS', tx: clamp(tx, 0, 7), ty: clamp(ty, 0, 5) };
    }

    // T <text> — Show speech bubble (empty = clear)
    case 'T': {
      return { type: 'TEXT', text: rest };
    }

    // BG <scene> — Set background scene
    case 'BG': {
      const scene = args[0]?.toLowerCase();
      if (!scene || !VALID_SCENES.includes(scene)) {
        console.error(`[protocol] Invalid scene: ${args[0]}`);
        return null;
      }
      return { type: 'SCENE', scene };
    }

    // B <row> <t0> <t1> ... — Set tile row
    case 'B': {
      const row = parseInt10(args[0]);
      if (row === null || row < 0 || row > 5) {
        console.error(`[protocol] Invalid tile row: ${args[0]}`);
        return null;
      }
      const tiles = args.slice(1).map(t => {
        const tl = t.toLowerCase();
        return VALID_TILES.includes(tl) ? tl : 'empty';
      });
      return { type: 'TILEROW', row, tiles };
    }

    // I <sprite> <tx> <ty> — Place item sprite
    case 'I': {
      const sprite = args[0];
      const tx = parseInt10(args[1]);
      const ty = parseInt10(args[2]);
      if (!sprite || tx === null || ty === null) {
        console.error(`[protocol] Invalid item: ${rest}`);
        return null;
      }
      return { type: 'ITEM', sprite, tx: clamp(tx, 0, 7), ty: clamp(ty, 0, 5) };
    }

    // F <effect> — Trigger screen effect
    case 'F': {
      const effect = args[0]?.toLowerCase();
      if (!effect || !VALID_EFFECTS.includes(effect)) {
        console.error(`[protocol] Invalid effect: ${args[0]}`);
        return null;
      }
      return { type: 'EFFECT', effect };
    }

    // BTN <id> <tx> <ty> <label> — Create button
    case 'BTN': {
      const id = args[0];
      const tx = parseInt10(args[1]);
      const ty = parseInt10(args[2]);
      const label = args.slice(3).join(' ');
      if (!id || tx === null || ty === null) {
        console.error(`[protocol] Invalid button: ${rest}`);
        return null;
      }
      return { type: 'BTN', id, tx: clamp(tx, 0, 7), ty: clamp(ty, 0, 5), label: label || id };
    }

    // PROG <x> <y> <w> <pct> — Progress bar
    case 'PROG': {
      const x = parseInt10(args[0]);
      const y = parseInt10(args[1]);
      const w = parseInt10(args[2]);
      const pct = parseFloat10(args[3]);
      if (x === null || y === null || w === null || pct === null) {
        console.error(`[protocol] Invalid progress bar: ${rest}`);
        return null;
      }
      return { type: 'PROG', x, y, w, pct: clamp(pct, 0, 100) };
    }

    // W <ms> — Wait
    case 'W': {
      const ms = parseInt10(args[0]);
      if (ms === null || ms < 0) {
        console.error(`[protocol] Invalid wait: ${args[0]}`);
        return null;
      }
      return { type: 'WAIT', ms: clamp(ms, 0, 10000) };
    }

    // RECT <x> <y> <w> <h> — Fill rectangle
    case 'RECT': {
      const x = parseInt10(args[0]);
      const y = parseInt10(args[1]);
      const w = parseInt10(args[2]);
      const h = parseInt10(args[3]);
      if (x === null || y === null || w === null || h === null) return null;
      return { type: 'RECT', x, y, w, h };
    }

    // CIRC <x> <y> <r> — Circle
    case 'CIRC': {
      const x = parseInt10(args[0]);
      const y = parseInt10(args[1]);
      const r = parseInt10(args[2]);
      if (x === null || y === null || r === null) return null;
      return { type: 'CIRC', x, y, r };
    }

    // LINE <x1> <y1> <x2> <y2> — Line
    case 'LINE': {
      const x1 = parseInt10(args[0]);
      const y1 = parseInt10(args[1]);
      const x2 = parseInt10(args[2]);
      const y2 = parseInt10(args[3]);
      if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
      return { type: 'LINE', x1, y1, x2, y2 };
    }

    // DOT <x> <y> — Single pixel
    case 'DOT': {
      const x = parseInt10(args[0]);
      const y = parseInt10(args[1]);
      if (x === null || y === null) return null;
      return { type: 'DOT', x, y };
    }

    // CLR — Clear draw layer
    case 'CLR': {
      return { type: 'CLR' };
    }

    // COL <index> — Set draw color
    case 'COL': {
      const idx = parseInt10(args[0]);
      if (idx === null) return null;
      return { type: 'COL', index: clamp(idx, 0, 15) };
    }

    // LISTEN <types...> — Configure feedback
    case 'LISTEN': {
      const types = args.map(a => a.toLowerCase()).filter(t => VALID_LISTEN_TYPES.includes(t));
      return { type: 'LISTEN', types };
    }

    // CLRBTN — Clear all buttons
    case 'CLRBTN': {
      return { type: 'CLRBTN' };
    }

    // CLRITM — Clear all items
    case 'CLRITM': {
      return { type: 'CLRITM' };
    }

    // MENU <tab> — Enter menu mode
    case 'MENU': {
      const tab = args[0]?.toLowerCase();
      if (!tab || !VALID_MENU_TABS.includes(tab)) {
        console.error(`[protocol] Invalid menu tab: ${args[0]}`);
        return null;
      }
      return { type: 'MENU', tab };
    }

    // MENU_EXIT — Exit menu mode
    case 'MENU_EXIT': {
      return { type: 'MENU_EXIT' };
    }

    // MENU_NAV <path> — Navigate to path within current tab
    case 'MENU_NAV': {
      return { type: 'MENU_NAV', path: rest };
    }

    default:
      console.error(`[protocol] Unknown command: ${prefix}`);
      return null;
  }
}

export {
  VALID_STATES, VALID_EVENTS, VALID_EFFECTS,
  VALID_SCENES, VALID_TILES, VALID_LISTEN_TYPES,
  VALID_MENU_TABS
};
