// JulianScreen — Click detection, button hit-testing, feedback

(function() {
  const S = window.JScreen;

  // Button registry
  const buttons = [];

  // Active listen types
  const listenTypes = new Set();

  // Register a button: { id, tx, ty, label }
  function addButton(cmd) {
    // Remove existing button with same id
    const idx = buttons.findIndex(b => b.id === cmd.id);
    if (idx !== -1) buttons.splice(idx, 1);

    buttons.push({
      id: cmd.id,
      tx: cmd.tx,
      ty: cmd.ty,
      label: cmd.label || cmd.id,
    });
    renderButtons();
  }

  function clearButtons() {
    buttons.length = 0;
    renderButtons();
  }

  function renderButtons() {
    const ctx = S.uiLayer.ctx;
    // Don't clear entire UI layer — text.js uses it too
    // Only clear button regions. For simplicity, re-render all buttons.
    // Buttons render at bottom of their tile cell
    for (const btn of buttons) {
      const px = btn.tx * S.TILE_SIZE;
      const py = btn.ty * S.TILE_SIZE;

      // Measure label width
      const labelW = btn.label.length * 8 + 6; // 8px per char (small font) + padding
      const btnW = Math.max(labelW, S.TILE_SIZE);
      const btnH = 22; // 9px font + padding
      const bx = px;
      const by = py + S.TILE_SIZE - btnH;

      // Background
      ctx.fillStyle = '#0F0F0F';
      ctx.fillRect(bx, by, btnW, btnH);

      // Border
      ctx.fillStyle = S.PALETTE[1]; // yellow
      // Top
      for (let x = bx; x < bx + btnW; x++) ctx.fillRect(x, by, 1, 1);
      // Bottom
      for (let x = bx; x < bx + btnW; x++) ctx.fillRect(x, by + btnH - 1, 1, 1);
      // Left
      for (let y = by; y < by + btnH; y++) ctx.fillRect(bx, y, 1, 1);
      // Right
      for (let y = by; y < by + btnH; y++) ctx.fillRect(bx + btnW - 1, y, 1, 1);

      // Label text (use JScreen.drawText if available)
      if (S.drawText) {
        S.drawText(ctx, btn.label, bx + 3, by + 6, 1, 'small');
      }

      // Store hit rect for click detection
      btn._hitX = bx;
      btn._hitY = by;
      btn._hitW = btnW;
      btn._hitH = btnH;
    }
  }

  // Click handler on the main canvas
  function handleClick(e) {
    const canvas = e.target;
    const rect = canvas.getBoundingClientRect();
    const scale = S._scale || 1;

    // Convert to canvas pixel coords
    const cx = Math.floor((e.clientX - rect.left) / scale);
    const cy = Math.floor((e.clientY - rect.top) / scale);

    // Button hit-test
    if (listenTypes.has('btn')) {
      for (const btn of buttons) {
        if (btn._hitX !== undefined &&
            cx >= btn._hitX && cx < btn._hitX + btn._hitW &&
            cy >= btn._hitY && cy < btn._hitY + btn._hitH) {
          S.sendFeedback({ type: 'BTN', id: btn.id });
          // Flash effect on click
          flashButton(btn);
          return;
        }
      }
    }

    // Tap event (tile coords)
    if (listenTypes.has('tap')) {
      const tx = Math.floor(cx / S.TILE_SIZE);
      const ty = Math.floor(cy / S.TILE_SIZE);
      S.sendFeedback({ type: 'TAP', tx, ty });
    }
  }

  function flashButton(btn) {
    const ctx = S.uiLayer.ctx;
    if (btn._hitX === undefined) return;
    // Brief white flash
    ctx.fillStyle = S.PALETTE[1];
    ctx.fillRect(btn._hitX + 1, btn._hitY + 1, btn._hitW - 2, btn._hitH - 2);
    setTimeout(() => renderButtons(), 100);
  }

  // LISTEN command handler
  function handleListen(cmd) {
    listenTypes.clear();
    for (const t of cmd.types) {
      listenTypes.add(t);
    }
  }

  // Progress bar
  function handleProgress(cmd) {
    const ctx = S.uiLayer.ctx;
    const barH = 8;
    // Background
    ctx.fillStyle = S.PALETTE[12]; // dark gray
    ctx.fillRect(cmd.x, cmd.y, cmd.w, barH);
    // Fill
    const fillW = Math.round(cmd.w * cmd.pct / 100);
    ctx.fillStyle = S.PALETTE[1]; // yellow
    ctx.fillRect(cmd.x, cmd.y, fillW, barH);
  }

  // Register handlers
  S.registerHandler('BTN', addButton);
  S.registerHandler('CLRBTN', clearButtons);
  S.registerHandler('LISTEN', handleListen);
  S.registerHandler('PROG', handleProgress);

  // Expose initInput so the React component can attach click listener after mount
  S.initInput = function(canvas) {
    canvas.addEventListener('click', handleClick);
    canvas.style.cursor = 'pointer';
  };

  // Expose for re-rendering after font loads
  S._renderButtons = renderButtons;
})();
