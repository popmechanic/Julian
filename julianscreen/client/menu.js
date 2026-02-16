// JulianScreen — Menu system: tab navigation, file/folder browsing, scrollable icon grid
//
// TODO: The Skills tab will soon support a graphical interface for adding, removing,
// and updating skills at runtime — a visual skill manager that lets users modify
// Julian's capabilities without touching the terminal. The filesystem-mirrored display
// is the foundation for that.
//
// TODO: The Agents tab will soon support spawning new teams, adding/removing members,
// and monitoring task progress — a visual command center for Julian's agent ecosystem.

(function() {
  const S = window.JScreen;

  // ── Menu state ──────────────────────────────────────────────────────────

  const state = {
    active: false,
    tab: 'browser',        // 'browser' | 'skills' | 'agents'
    path: [],              // current directory path segments
    items: [],             // current visible items: [{ name, type: 'folder'|'file' }]
    scrollOffset: 0,       // rows scrolled (0-based)
    data: {
      browser: null,       // { files: [{ name, modified }] }
      skills: null,        // { entries: [{ name, type, children? }] }
      agents: null,        // { teams: [{ name, members: [{ name, agentType }] }] }
    }
  };

  // ── Layout constants ────────────────────────────────────────────────────

  const TAB_HEIGHT = 24;
  const SEP_Y = 24;
  const BREADCRUMB_Y = 26;
  const BREADCRUMB_H = 15;
  const CONTENT_Y = 42;
  const CONTENT_H = 438;    // y=42 to y=479
  const GRID_COLS = 4;
  const GRID_ROWS = 5;
  const COL_W = 158;         // floor(632 / 4) — leaves room for scrollbar
  const ROW_H = 80;          // 32px icon + 4px gap + 11px text + gap
  const ICON_SIZE = 32;
  const SCROLLBAR_X = 632;
  const SCROLLBAR_W = 8;

  const TABS = [
    { id: 'browser', label: 'BROWSER', x: 0, w: 214 },
    { id: 'skills',  label: 'SKILLS',  x: 214, w: 213 },
    { id: 'agents',  label: 'AGENTS',  x: 427, w: 213 },
  ];

  // ── Icon sprites (loaded from items.json) ───────────────────────────────

  let folderSprite = null;
  let fileSprite = null;

  fetch('sprites/items.json')
    .then(r => r.json())
    .then(data => {
      folderSprite = data.folder;
      fileSprite = data.file;
      // Re-render if menu is already active when sprites load
      if (state.active) render();
    })
    .catch(() => console.warn('[menu] Failed to load icon sprites'));

  // ── Rendering ──────────────────────────────────────────────────────────

  function render() {
    if (!state.active) return;

    const drawCtx = S.drawLayer.ctx;
    const uiCtx = S.uiLayer.ctx;

    // Fill draw layer with near-black to create solid background
    drawCtx.fillStyle = S.PALETTE[2];
    drawCtx.fillRect(0, 0, S.SCREEN_W, S.SCREEN_H);

    // Clear UI layer
    uiCtx.clearRect(0, 0, S.SCREEN_W, S.SCREEN_H);

    renderTabBar(uiCtx);
    renderSeparator(uiCtx);
    renderBreadcrumb(uiCtx);
    renderGrid(drawCtx);
    renderScrollbar(uiCtx);
  }

  function renderTabBar(ctx) {
    for (const tab of TABS) {
      const metrics = S._fontMetrics ? S._fontMetrics('large') : { charW: 12 };
      const labelW = tab.label.length * metrics.charW;
      const labelX = tab.x + Math.floor((tab.w - labelW) / 2);
      const labelY = Math.floor((TAB_HEIGHT - 14) / 2); // center 14px glyph in tab

      if (tab.id === state.tab) {
        // Active tab: filled pink/magenta background
        ctx.fillStyle = S.PALETTE[7]; // pink
        ctx.fillRect(tab.x, 0, tab.w, TAB_HEIGHT);
        // Near-black text on pink
        if (S.drawText) S.drawText(ctx, tab.label, labelX, labelY, 2, 'large');
      } else {
        // Inactive tab: yellow text on transparent
        if (S.drawText) S.drawText(ctx, tab.label, labelX, labelY, 1, 'large');
      }
    }
  }

  function renderSeparator(ctx) {
    ctx.fillStyle = S.PALETTE[7]; // pink
    for (let x = 0; x < S.SCREEN_W; x++) {
      ctx.fillRect(x, SEP_Y, 1, 1);
    }
  }

  function renderBreadcrumb(ctx) {
    let text;
    if (state.path.length === 0) {
      if (state.tab === 'browser') text = 'memory/';
      else if (state.tab === 'skills') text = 'skills/';
      else text = 'teams/';
    } else {
      text = '< ' + state.path[state.path.length - 1] + '/';
    }
    // Truncate to fit screen width (small font at 8px per char, ~79 chars)
    if (text.length > 75) text = text.substring(0, 74) + '/';
    if (S.drawText) S.drawText(ctx, text, 4, BREADCRUMB_Y + 3, 1, 'small');
  }

  function renderGrid(ctx) {
    const items = state.items;
    if (items.length === 0) {
      renderEmptyState(ctx);
      return;
    }

    const startIdx = state.scrollOffset * GRID_COLS;

    for (let row = 0; row < GRID_ROWS; row++) {
      for (let col = 0; col < GRID_COLS; col++) {
        const idx = startIdx + row * GRID_COLS + col;
        if (idx >= items.length) return;

        const item = items[idx];
        const cellX = col * COL_W;
        const cellY = CONTENT_Y + row * ROW_H;

        // Draw icon centered in column
        const iconX = cellX + Math.floor((COL_W - ICON_SIZE) / 2);
        const iconY = cellY;
        const sprite = item.type === 'folder' ? folderSprite : fileSprite;
        if (sprite) {
          renderSprite(ctx, sprite, iconX, iconY);
        }

        // Draw label centered below icon (small font)
        if (S.drawText) {
          const label = truncateLabel(item.name, 14);
          const metrics = S._fontMetrics ? S._fontMetrics('small') : { charW: 8 };
          const labelW = label.length * metrics.charW;
          const labelX = cellX + Math.floor((COL_W - labelW) / 2);
          const labelY = iconY + ICON_SIZE + 4;
          S.drawText(ctx, label, labelX, labelY, 1, 'small');
        }
      }
    }
  }

  function renderEmptyState(ctx) {
    if (!S.drawText) return;
    let msg;
    if (state.tab === 'agents') {
      msg = 'No active teams';
    } else if (state.tab === 'skills') {
      msg = 'No skills found';
    } else {
      msg = 'No files found';
    }
    const metrics = S._fontMetrics ? S._fontMetrics('large') : { charW: 12 };
    const msgW = msg.length * metrics.charW;
    const x = Math.floor((S.SCREEN_W - msgW) / 2);
    const y = CONTENT_Y + 150;
    S.drawText(ctx, msg, x, y, 11, 'large'); // gray text
  }

  function renderSprite(ctx, spriteData, x, y) {
    for (let py = 0; py < 32; py++) {
      for (let px = 0; px < 32; px++) {
        const colorIdx = spriteData[py * 32 + px];
        if (colorIdx !== 0) {
          ctx.fillStyle = S.PALETTE[colorIdx];
          ctx.fillRect(x + px, y + py, 1, 1);
        }
      }
    }
  }

  function renderScrollbar(ctx) {
    const totalRows = Math.ceil(state.items.length / GRID_COLS);
    if (totalRows <= GRID_ROWS) return; // No scrollbar needed

    const trackTop = CONTENT_Y;
    const trackH = CONTENT_H;

    // Track background
    ctx.fillStyle = S.PALETTE[12]; // dark gray
    ctx.fillRect(SCROLLBAR_X, trackTop, SCROLLBAR_W, trackH);

    // Up arrow (▲) — 8px wide triangle
    ctx.fillStyle = S.PALETTE[1]; // yellow
    for (let row = 0; row < 4; row++) {
      const half = row + 1;
      const cx = SCROLLBAR_X + Math.floor(SCROLLBAR_W / 2);
      ctx.fillRect(cx - half, trackTop + 4 - row, half * 2, 1);
    }

    // Down arrow (▼)
    for (let row = 0; row < 4; row++) {
      const half = row + 1;
      const cx = SCROLLBAR_X + Math.floor(SCROLLBAR_W / 2);
      ctx.fillRect(cx - half, trackTop + trackH - 5 + row, half * 2, 1);
    }

    // Thumb
    const maxScroll = totalRows - GRID_ROWS;
    const thumbAreaTop = trackTop + 12;
    const thumbAreaH = trackH - 24;
    const thumbH = Math.max(4, Math.floor(thumbAreaH * GRID_ROWS / totalRows));
    const thumbY = maxScroll > 0
      ? Math.floor(thumbAreaTop + (thumbAreaH - thumbH) * state.scrollOffset / maxScroll)
      : thumbAreaTop;
    ctx.fillStyle = S.PALETTE[1]; // yellow
    ctx.fillRect(SCROLLBAR_X, thumbY, SCROLLBAR_W, thumbH);
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  function truncateLabel(name, maxLen) {
    // Strip common extensions for display
    let label = name.replace(/\.html$/, '').replace(/\.md$/, '');
    if (label.length > maxLen) label = label.substring(0, maxLen);
    return label;
  }

  function getItemsForCurrentPath() {
    const tabData = state.data[state.tab];
    if (!tabData) return [];

    if (state.tab === 'browser') return getBrowserItems(tabData);
    if (state.tab === 'skills') return getSkillItems(tabData);
    return getAgentItems(tabData);
  }

  function getBrowserItems(data) {
    if (!data || !data.files) return [];
    // Sort alphabetically by name
    const sorted = [...data.files].sort((a, b) => a.name.localeCompare(b.name));
    return sorted.map(f => ({
      name: f.name,
      type: 'file',
    }));
  }

  function getSkillItems(data) {
    if (!data || !data.entries) return [];
    let entries = data.entries;
    // Navigate into nested path
    for (const segment of state.path) {
      const found = entries.find(e => e.name === segment && e.type === 'folder');
      if (found && found.children) {
        entries = found.children;
      } else {
        return [];
      }
    }
    // Sort: folders first, then alphabetical
    return [...entries]
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map(e => ({ name: e.name, type: e.type }));
  }

  function getAgentItems(data) {
    if (!data || !data.teams) return [];
    if (state.path.length === 0) {
      // Root: show teams as folders
      return data.teams.map(t => ({ name: t.name, type: 'folder' }));
    }
    // Inside a team: show members as files
    const team = data.teams.find(t => t.name === state.path[0]);
    if (!team) return [];
    return team.members.map(m => ({ name: m.name, type: 'file' }));
  }

  function updateItems() {
    state.items = getItemsForCurrentPath();
    state.scrollOffset = 0;
  }

  // ── Click handling ─────────────────────────────────────────────────────

  function handleMenuClick(cx, cy) {
    if (!state.active) return false;

    // Tab bar
    if (cy < TAB_HEIGHT) {
      for (const tab of TABS) {
        if (cx >= tab.x && cx < tab.x + tab.w) {
          if (tab.id !== state.tab) {
            state.tab = tab.id;
            state.path = [];
            updateItems();
            render();
            S.sendFeedback({ type: 'MENU_TAB', tab: tab.id });
          }
          return true;
        }
      }
      return true;
    }

    // Breadcrumb / back navigation
    if (cy >= BREADCRUMB_Y && cy < BREADCRUMB_Y + BREADCRUMB_H) {
      if (state.path.length > 0) {
        state.path.pop();
        updateItems();
        render();
      }
      return true;
    }

    // Scrollbar
    if (cx >= SCROLLBAR_X && cy >= CONTENT_Y) {
      const totalRows = Math.ceil(state.items.length / GRID_COLS);
      if (totalRows <= GRID_ROWS) return true;

      const maxScroll = totalRows - GRID_ROWS;
      // Up arrow zone (top 12px of track)
      if (cy < CONTENT_Y + 12) {
        state.scrollOffset = Math.max(0, state.scrollOffset - 1);
      }
      // Down arrow zone (bottom 12px of track)
      else if (cy > CONTENT_Y + CONTENT_H - 12) {
        state.scrollOffset = Math.min(maxScroll, state.scrollOffset + 1);
      }
      // Track: page up/down based on position
      else {
        const mid = CONTENT_Y + CONTENT_H / 2;
        if (cy < mid) {
          state.scrollOffset = Math.max(0, state.scrollOffset - GRID_ROWS);
        } else {
          state.scrollOffset = Math.min(maxScroll, state.scrollOffset + GRID_ROWS);
        }
      }
      render();
      return true;
    }

    // Content grid
    if (cy >= CONTENT_Y && cx < SCROLLBAR_X) {
      const col = Math.floor(cx / COL_W);
      const row = Math.floor((cy - CONTENT_Y) / ROW_H);
      if (col >= GRID_COLS || row >= GRID_ROWS) return true;

      const idx = (state.scrollOffset + row) * GRID_COLS + col;
      if (idx >= state.items.length) return true;

      const item = state.items[idx];
      if (item.type === 'folder') {
        state.path.push(item.name);
        updateItems();
        render();
      } else {
        // File selected — emit feedback
        S.sendFeedback({
          type: 'FILE_SELECT',
          tab: state.tab,
          file: item.name,
          path: state.path.join('/'),
        });
      }
      return true;
    }

    return true; // Consume all clicks when menu is active
  }

  // ── Tick chain integration ─────────────────────────────────────────────
  // menu.js loads last, so its tick runs after all other modules.
  // When active, it suppresses the avatar and keeps the menu rendered.

  const prevTick = S.tickAnimations;
  S.tickAnimations = function(ts) {
    prevTick(ts);
    if (state.active) {
      // Clear sprite layer to hide avatar
      S.spriteLayer.ctx.clearRect(0, 0, S.SCREEN_W, S.SCREEN_H);
    }
  };

  // ── Command handlers ───────────────────────────────────────────────────

  S.registerHandler('MENU', function(cmd) {
    state.active = true;
    state.tab = cmd.tab || 'browser';
    state.path = [];
    updateItems();
    render();
  });

  S.registerHandler('MENU_EXIT', function() {
    state.active = false;
    state.path = [];
    state.scrollOffset = 0;
    // Clear menu visuals so normal display resumes
    S.drawLayer.ctx.clearRect(0, 0, S.SCREEN_W, S.SCREEN_H);
    S.uiLayer.ctx.clearRect(0, 0, S.SCREEN_W, S.SCREEN_H);
  });

  S.registerHandler('MENU_NAV', function(cmd) {
    if (!state.active) return;
    state.path = cmd.path ? cmd.path.split('/').filter(Boolean) : [];
    updateItems();
    render();
  });

  // ── Public API ─────────────────────────────────────────────────────────

  // Called by the React component to provide data for each tab
  S.setMenuData = function(tab, data) {
    state.data[tab] = data;
    if (state.active && state.tab === tab) {
      updateItems();
      render();
    }
  };

  S.enterMenu = function(tab) {
    S.enqueueCommands([{ type: 'MENU', tab: tab || 'browser' }]);
  };

  S.exitMenu = function() {
    S.enqueueCommands([{ type: 'MENU_EXIT' }]);
  };

  S.menuNavigate = function(path) {
    S.enqueueCommands([{ type: 'MENU_NAV', path: path }]);
  };

  S.isMenuActive = function() {
    return state.active;
  };

  // ── Click interception ─────────────────────────────────────────────────
  // Wrap initInput so menu click handler runs BEFORE input.js handler.
  // stopImmediatePropagation prevents input.js from seeing menu clicks.

  const prevInitInput = S.initInput;
  S.initInput = function(canvas) {
    // Menu click handler — added first, runs first
    canvas.addEventListener('click', function(e) {
      if (!state.active) return;
      const rect = canvas.getBoundingClientRect();
      const scale = S._scale || 1;
      const cx = Math.floor((e.clientX - rect.left) / scale);
      const cy = Math.floor((e.clientY - rect.top) / scale);
      if (handleMenuClick(cx, cy)) {
        e.stopImmediatePropagation();
      }
    });
    // Scroll wheel handler for menu
    canvas.addEventListener('wheel', function(e) {
      if (!state.active) return;
      const totalRows = Math.ceil(state.items.length / GRID_COLS);
      if (totalRows <= GRID_ROWS) return;
      e.preventDefault();
      const maxScroll = totalRows - GRID_ROWS;
      if (e.deltaY > 0) {
        state.scrollOffset = Math.min(maxScroll, state.scrollOffset + 1);
      } else if (e.deltaY < 0) {
        state.scrollOffset = Math.max(0, state.scrollOffset - 1);
      }
      render();
    }, { passive: false });
    // Original input.js handler
    if (prevInitInput) prevInitInput(canvas);
  };

  // Expose state for debugging
  S._menuState = state;
})();
