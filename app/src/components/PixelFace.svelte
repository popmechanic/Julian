<!-- app/src/components/PixelFace.svelte -->
<!--
  Port of the legacy canvas renderer (chat.jsx PixelFace, lines 361-458).
  32x32 canvas scaled to `size` with image-rendering: pixelated. Eyes hide
  while blinking (random 2-5s schedule, 150ms blink); mouth alternates
  talk1/talk2 every 150ms while talking, else idle. The animation loop
  only runs while talking or blinking.
-->
<script lang="ts">
  import { EYE_VARIANTS, MOUTH_VARIANTS, type EyeVariant, type MouthVariant, type Pixel } from '../lib/faces';

  let {
    talking = false,
    size = 120,
    color = '#FFD600',
    eyes = 'standard' as EyeVariant,
    mouth = 'gentle' as MouthVariant,
  }: {
    talking?: boolean;
    size?: number;
    color?: string;
    eyes?: EyeVariant;
    mouth?: MouthVariant;
  } = $props();

  let canvas: HTMLCanvasElement | undefined = $state();
  let blinking = false;
  let anim: number | null = null;

  function drawPixels(ctx: CanvasRenderingContext2D, pixels: Pixel[]) {
    ctx.fillStyle = color;
    for (const [x, y] of pixels) ctx.fillRect(x, y, 1, 1);
  }

  function draw() {
    const ctx = canvas?.getContext('2d');
    if (!ctx) { anim = null; return; }
    ctx.fillStyle = '#0F0F0F';
    ctx.fillRect(0, 0, 32, 32);
    const eye = EYE_VARIANTS[eyes];
    const mo = MOUTH_VARIANTS[mouth];
    if (!blinking) { drawPixels(ctx, eye.left); drawPixels(ctx, eye.right); }
    if (talking) drawPixels(ctx, Math.floor(Date.now() / 150) % 2 === 0 ? mo.talk1 : mo.talk2);
    else drawPixels(ctx, mo.idle);
    anim = talking || blinking ? requestAnimationFrame(draw) : null;
  }

  $effect(() => {
    void talking; void color; void eyes; void mouth; // redraw on prop change
    draw();
  });

  $effect(() => {
    let blinkTimeout: ReturnType<typeof setTimeout>;
    function scheduleBlink() {
      blinkTimeout = setTimeout(() => {
        blinking = true;
        if (!anim) anim = requestAnimationFrame(draw);
        blinkTimeout = setTimeout(() => {
          blinking = false;
          if (!anim) anim = requestAnimationFrame(draw);
          scheduleBlink();
        }, 150);
      }, Math.random() * 3000 + 2000);
    }
    scheduleBlink();
    return () => {
      clearTimeout(blinkTimeout);
      if (anim) cancelAnimationFrame(anim);
      anim = null;
    };
  });
</script>

<canvas bind:this={canvas} width={32} height={32} style:width="{size}px" style:height="{size}px"></canvas>

<style>
  canvas {
    image-rendering: pixelated;
  }
</style>
