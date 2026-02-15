// JulianScreen — Screen effects (sparkle, shake, flash, hearts, rain, snow, glitch)

(function() {
  const S = window.JScreen;
  function getCanvas() { return window.JScreen._canvas; }

  // Active effects
  const activeEffects = [];

  function addEffect(type, duration) {
    activeEffects.push({
      type,
      startTime: performance.now(),
      duration,
    });
  }

  // Sparkle: random yellow pixels flash
  function renderSparkle(ctx, progress) {
    const intensity = 1 - progress; // fade out
    const count = Math.floor(30 * intensity);
    ctx.fillStyle = S.PALETTE[1]; // yellow
    for (let i = 0; i < count; i++) {
      const x = Math.floor(Math.random() * S.SCREEN_W);
      const y = Math.floor(Math.random() * S.SCREEN_H);
      ctx.fillRect(x, y, 1, 1);
    }
  }

  // Hearts: small hearts float up
  function renderHearts(ctx, progress) {
    const heartPixels = [
      [0,1,0,1,0],
      [1,1,1,1,1],
      [1,1,1,1,1],
      [0,1,1,1,0],
      [0,0,1,0,0],
    ];
    const numHearts = 5;
    ctx.fillStyle = S.PALETTE[4]; // red
    for (let h = 0; h < numHearts; h++) {
      const baseX = 15 + h * 25;
      const baseY = S.SCREEN_H - progress * (S.SCREEN_H + 20) + h * 8;
      for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 5; col++) {
          if (heartPixels[row][col]) {
            ctx.fillRect(Math.round(baseX + col), Math.round(baseY + row), 1, 1);
          }
        }
      }
    }
  }

  // Flash: white overlay
  function renderFlash(ctx, progress) {
    if (progress < 0.5) {
      const alpha = 1 - progress * 2;
      // Draw white pixels over everything
      ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
      ctx.fillRect(0, 0, S.SCREEN_W, S.SCREEN_H);
    }
  }

  // Shake: canvas translate oscillation
  function applyShake(progress) {
    const canvas = getCanvas();
    if (!canvas) return;
    const intensity = (1 - progress) * 4;
    const x = Math.round(Math.sin(progress * Math.PI * 8) * intensity);
    const y = Math.round(Math.cos(progress * Math.PI * 6) * intensity * 0.5);
    canvas.style.transform = `translate(${x}px, ${y}px)`;
    if (progress >= 1) {
      canvas.style.transform = '';
    }
  }

  // Rain: vertical lines falling
  function renderRain(ctx, progress) {
    ctx.fillStyle = S.PALETTE[6]; // blue
    const offset = Math.floor(progress * 20);
    for (let i = 0; i < 40; i++) {
      const x = (i * 7 + 3) % S.SCREEN_W;
      const y = ((i * 13 + offset * 5) % (S.SCREEN_H + 8)) - 4;
      ctx.fillRect(x, y, 1, 3);
    }
  }

  // Snow: slow falling dots
  function renderSnow(ctx, progress) {
    ctx.fillStyle = S.PALETTE[3]; // white
    const offset = progress * 50;
    for (let i = 0; i < 25; i++) {
      const x = (i * 11 + Math.sin(i + offset) * 3 + S.SCREEN_W) % S.SCREEN_W;
      const y = ((i * 7 + offset * 2) % (S.SCREEN_H + 4)) - 2;
      ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
    }
  }

  // Glitch: horizontal line displacement
  function renderGlitch(ctx, progress) {
    if (progress > 0.8) return; // only active first 80%
    // Displace a few horizontal bands
    const mainCanvas = getCanvas();
    const mainCtx = mainCanvas?.getContext('2d');
    if (!mainCtx) return;

    for (let band = 0; band < 3; band++) {
      const y = Math.floor(Math.random() * S.SCREEN_H);
      const h = 2 + Math.floor(Math.random() * 4);
      const shift = Math.floor((Math.random() - 0.5) * 12);
      try {
        const imageData = mainCtx.getImageData(0, y, S.SCREEN_W, h);
        mainCtx.putImageData(imageData, shift, y);
      } catch(e) {
        // ignore if canvas is tainted
      }
    }
  }

  // Effect handler
  function handleEffect(cmd) {
    const durations = {
      sparkle: 800,
      hearts: 1200,
      flash: 200,
      shake: 300,
      rain: 2000,
      snow: 3000,
      glitch: 200,
    };
    const dur = durations[cmd.effect] || 500;
    addEffect(cmd.effect, dur);
  }

  // Tick effects (called from animation loop)
  function tickEffects(timestamp) {
    const ctx = S.uiLayer.ctx;

    // Process active effects
    for (let i = activeEffects.length - 1; i >= 0; i--) {
      const fx = activeEffects[i];
      const elapsed = timestamp - fx.startTime;
      const progress = Math.min(elapsed / fx.duration, 1);

      switch (fx.type) {
        case 'sparkle': renderSparkle(ctx, progress); break;
        case 'hearts': renderHearts(ctx, progress); break;
        case 'flash': renderFlash(ctx, progress); break;
        case 'shake': applyShake(progress); break;
        case 'rain': renderRain(ctx, progress); break;
        case 'snow': renderSnow(ctx, progress); break;
        case 'glitch': renderGlitch(ctx, progress); break;
      }

      if (progress >= 1) {
        activeEffects.splice(i, 1);
        // Reset shake transform
        if (fx.type === 'shake' && getCanvas()) {
          getCanvas().style.transform = '';
        }
      }
    }
  }

  // Chain into tick animation
  const prevTick = S.tickAnimations;
  S.tickAnimations = function(timestamp) {
    if (prevTick) prevTick(timestamp);
    tickEffects(timestamp);
  };

  // Register handler
  S.registerHandler('EFFECT', handleEffect);
})();
