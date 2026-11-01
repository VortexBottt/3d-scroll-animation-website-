(() => {
  'use strict';

  // --- Scroll restoration fix ---
  // The browser remembers your previous scroll position on refresh, which skips
  // the animation ahead to Scene 3/4. Disable it and force the page back to the
  // top BEFORE any scroll progress is calculated, so we always start at frame 0.
  history.scrollRestoration = 'manual';
  window.scrollTo(0, 0);

  // --- Configuration ---
  const TOTAL_FRAMES = 238;
  const DAMPING = 0.1; // Smooth scrubbing lerp factor (~0.1)
  const DESKTOP_FOLDER = 'framespc';
  const MOBILE_FOLDER = 'framesmobile';
  const BREAKPOINT_PX = 768;
  const MAX_CONCURRENT_PRELOADS = 6;

  // --- DOM Elements ---
  const canvas = document.getElementById('sequenceCanvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  const container = document.getElementById('scrollContainer');
  const scenes = Array.from(document.querySelectorAll('#ui-layer .scene'));

  // --- Responsive & Reduced Motion State ---
  let isDesktop = window.matchMedia(`(min-width: ${BREAKPOINT_PX}px)`).matches;
  let currentFolder = isDesktop ? DESKTOP_FOLDER : MOBILE_FOLDER;

  const mqlReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let isReducedMotion = mqlReducedMotion.matches;

  // --- Image Cache & Decode Tracking ---
  let imageCache = new Array(TOTAL_FRAMES).fill(null);
  let isFrameLoaded = new Array(TOTAL_FRAMES).fill(false);
  let preloadGeneration = 0; // Generation token for clean cancellation on asset switch

  // --- Scrubbing & Animation State ---
  let currentScrubFrame = 0;
  let targetScrubFrame = 0;
  let lastDrawnFrameIndex = -1;

  // Frame URL builder: ezgif-frame-001.jpg ... ezgif-frame-238.jpg
  function getFrameUrl(folder, index) {
    const frameNum = String(index + 1).padStart(3, '0');
    return `${folder}/ezgif-frame-${frameNum}.jpg`;
  }

  // --- High-DPI Canvas Resizing & Cover Scaling ---
  let viewportWidth = 0;
  let viewportHeight = 0;
  let dpr = 1;

  function resizeCanvas() {
    viewportWidth = window.innerWidth;
    viewportHeight = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = Math.round(viewportWidth * dpr);
    canvas.height = Math.round(viewportHeight * dpr);

    canvas.style.width = `${viewportWidth}px`;
    canvas.style.height = `${viewportHeight}px`;

    // Redraw immediately after buffer resize
    renderFrame(Math.round(currentScrubFrame), true);
  }

  // Object-fit: cover drawing into high-DPI canvas buffer
  function drawCover(img) {
    if (!img) return;
    const cw = canvas.width;
    const ch = canvas.height;
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;

    const scale = Math.max(cw / iw, ch / ih);
    const drawWidth = iw * scale;
    const drawHeight = ih * scale;
    const drawX = (cw - drawWidth) * 0.5;
    const drawY = (ch - drawHeight) * 0.5;

    ctx.drawImage(img, 0, 0, iw, ih, drawX, drawY, drawWidth, drawHeight);
  }

  // Get requested frame or fallback to closest decoded frame to prevent blank frames
  function getBestAvailableFrame(index) {
    if (imageCache[index] && isFrameLoaded[index]) {
      return imageCache[index];
    }
    // Search outward for closest loaded neighbor
    let offset = 1;
    while (index - offset >= 0 || index + offset < TOTAL_FRAMES) {
      const prev = index - offset;
      if (prev >= 0 && imageCache[prev] && isFrameLoaded[prev]) {
        return imageCache[prev];
      }
      const next = index + offset;
      if (next < TOTAL_FRAMES && imageCache[next] && isFrameLoaded[next]) {
        return imageCache[next];
      }
      offset++;
    }
    return imageCache[0] && isFrameLoaded[0] ? imageCache[0] : null;
  }

  function renderFrame(index, force = false) {
    const clampedIndex = Math.max(0, Math.min(TOTAL_FRAMES - 1, index));
    if (!force && clampedIndex === lastDrawnFrameIndex) {
      return;
    }

    const imgToDraw = getBestAvailableFrame(clampedIndex);
    if (imgToDraw) {
      drawCover(imgToDraw);
      lastDrawnFrameIndex = clampedIndex;
    }
  }

  // --- Scroll Mapping (0 -> 1 mapped through the container) ---
  function getScrollProgress() {
    const rect = container.getBoundingClientRect();
    const maxScroll = container.offsetHeight - window.innerHeight;
    if (maxScroll <= 0) return 0;
    const scrollPos = -rect.top;
    return Math.max(0, Math.min(1, scrollPos / maxScroll));
  }

  // --- UI Scene Overlay (fade scenes in/out by scroll progress) ---
  // Progress 0-0.25 -> scene 1, 0.25-0.5 -> scene 2, 0.5-0.75 -> scene 3, 0.75-1 -> scene 4
  function updateUI(progress) {
    if (scenes.length === 0) return;
    const activeIndex = Math.min(scenes.length - 1, Math.floor(progress * scenes.length));
    scenes.forEach((scene, i) => {
      scene.style.opacity = i === activeIndex ? '1' : '0';
    });
  }

  // --- Animation Loop with Damped Scrubbing ---
  function onFrame() {
    if (isReducedMotion) {
      updateUI(getScrollProgress());
      renderFrame(0);
      requestAnimationFrame(onFrame);
      return;
    }

    const progress = getScrollProgress();
    updateUI(progress);
    targetScrubFrame = progress * (TOTAL_FRAMES - 1);

    const delta = targetScrubFrame - currentScrubFrame;
    if (Math.abs(delta) < 0.001) {
      currentScrubFrame = targetScrubFrame;
    } else {
      currentScrubFrame += delta * DAMPING;
    }

    renderFrame(Math.round(currentScrubFrame));
    requestAnimationFrame(onFrame);
  }

  // --- Shimmer Wave Loader (tracks first batch: frames 0..15) ---
  const LOADER_BATCH_END = 15; // frames 0..15 inclusive
  const LOADER_BATCH_TOTAL = LOADER_BATCH_END + 1; // 16 images
  const LOADER_MIN_MS = 800; // minimum visible time (avoids a flash on cache hits)
  const LOADER_WIPE_MS = 800; // matches the clip-path transition duration
  const LOADER_MAX_MS = 6000; // watchdog: force-hide the loader even if frames never settle
  const FRAME_LOAD_TIMEOUT_MS = 5000; // per-frame cap so one hung request can't stall the batch

  const preloaderEl = document.getElementById('preloader');
  const shimmerEl = document.getElementById('shimmer-text');

  let loaderLoaded = 0;
  let loaderStart = 0;
  let loaderDone = false;
  let loaderDismissed = false;
  let loaderWatchdog = null;

  function beginLoader() {
    if (loaderDismissed) return; // already revealed once; never restart
    loaderLoaded = 0;
    loaderDone = false;
    loaderStart = Date.now();

    // Split the sentence into per-letter spans so the wave ripples left → right.
    // Built only once; a mid-load breakpoint re-init keeps the existing spans.
    if (shimmerEl && shimmerEl.childElementCount === 0) {
      const text = 'Wait while we load the website!';
      for (let i = 0; i < text.length; i++) {
        const span = document.createElement('span');
        span.className = 'shimmer-char';
        // Use &nbsp; for spaces so flexbox doesn't collapse them
        span.innerHTML = text[i] === ' ' ? '&nbsp;' : text[i];
        span.style.animationDelay = `${i * 0.05}s`;
        shimmerEl.appendChild(span);
      }
    }

    // Watchdog: guarantee the loader hides even if frames never settle (slow/dead network)
    clearTimeout(loaderWatchdog);
    loaderWatchdog = setTimeout(() => {
      if (!loaderDone && !loaderDismissed) {
        loaderDone = true;
        finishLoader();
      }
    }, LOADER_MAX_MS);
  }

  function finishLoader() {
    clearTimeout(loaderWatchdog); // hide sequence has begun; stop the watchdog
    const elapsedTime = Date.now() - loaderStart;
    const wait = Math.max(0, LOADER_MIN_MS - elapsedTime);
    setTimeout(() => {
      if (!preloaderEl || loaderDismissed) return;
      preloaderEl.classList.add('hidden'); // wipe up reveal
      setTimeout(() => {
        preloaderEl.style.display = 'none'; // stop blocking clicks
        loaderDismissed = true;
      }, LOADER_WIPE_MS);
    }, wait);
  }

  function onLoaderFrameLoaded(index) {
    if (loaderDismissed || loaderDone) return;
    if (index > LOADER_BATCH_END) return; // only the first batch counts
    loaderLoaded = Math.min(LOADER_BATCH_TOTAL, loaderLoaded + 1);
    if (loaderLoaded >= LOADER_BATCH_TOTAL) {
      loaderDone = true;
      finishLoader();
    }
  }

  // --- Progressive Preload ---
  // Loads one image with a hard timeout. ALWAYS resolves (never rejects) so a
  // corrupt, truncated, or slow frame can never stall the preload / loader.
  // Failures are logged as a warning and resolve as "not ok" (frame is skipped).
  function loadFrameImage(img, url, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok, reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ok) {
          resolve(true);
        } else {
          console.warn(`[preloader] Frame skipped (${reason}): ${url}`);
          resolve(false);
        }
      };

      // Per-frame watchdog: if the request hangs, give up after timeoutMs
      const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);

      // onload fires as soon as the image data is available — ~1ms for cache
      // hits and after download for network requests. We deliberately do NOT
      // await img.decode(): on cache-hit images (complete + naturalWidth set)
      // decode() can hang forever, which is what stalled the whole preloader.
      img.onload = () => finish(true, 'load');
      // onerror covers 404s, truncated downloads, and network failures — the
      // "Image corrupt or truncated" case. Log a warning, resolve anyway, skip.
      img.onerror = () => finish(false, 'error');
      img.src = url;
    });
  }

  async function preloadFrame(folder, index, gen) {
    if (gen !== preloadGeneration) return;
    const url = getFrameUrl(folder, index);
    const img = new Image();

    // Never throws: corrupt / missing / timed-out frames resolve as ok = false
    const ok = await loadFrameImage(img, url, FRAME_LOAD_TIMEOUT_MS);

    if (ok && gen === preloadGeneration) {
      try {
        imageCache[index] = img;
        isFrameLoaded[index] = true;

        const wanted = Math.round(currentScrubFrame);
        if (wanted === index || lastDrawnFrameIndex === -1) {
          renderFrame(wanted, true);
        }
      } catch {
        // Defensive: a render hiccup shouldn't break the preload chain
      }
    }

    // Always count toward the loader — even failed/timed-out frames settle here,
    // so the loader reaches 16 and hides. Failed frames simply aren't cached and
    // the nearest-good-frame fallback covers them at render time.
    if (gen === preloadGeneration) {
      onLoaderFrameLoaded(index);
    }
  }

  async function startProgressivePreload(folder, gen) {
    beginLoader(); // start/refresh loader timing and batch count

    // Phase 1: Render frame 0 immediately without blocking first paint
    await preloadFrame(folder, 0, gen);
    if (gen !== preloadGeneration) return;

    // Phase 2: Preload remaining frames in background with worker pool
    const queue = [];
    for (let i = 1; i < TOTAL_FRAMES; i++) {
      queue.push(i);
    }

    let activeWorkers = 0;
    return new Promise((resolve) => {
      function next() {
        if (gen !== preloadGeneration) return resolve();
        if (queue.length === 0 && activeWorkers === 0) return resolve();

        while (activeWorkers < MAX_CONCURRENT_PRELOADS && queue.length > 0) {
          const idx = queue.shift();
          activeWorkers++;
          preloadFrame(folder, idx, gen).finally(() => {
            activeWorkers--;
            next();
          });
        }
      }
      next();
    });
  }

  // --- Clean Sequence Initialization ---
  function initSequence() {
    preloadGeneration++; // Invalidate pending loads
    const currentGen = preloadGeneration;

    isDesktop = window.matchMedia(`(min-width: ${BREAKPOINT_PX}px)`).matches;
    currentFolder = isDesktop ? DESKTOP_FOLDER : MOBILE_FOLDER;

    imageCache = new Array(TOTAL_FRAMES).fill(null);
    isFrameLoaded = new Array(TOTAL_FRAMES).fill(false);
    lastDrawnFrameIndex = -1;

    resizeCanvas();
    startProgressivePreload(currentFolder, currentGen);
  }

  // --- Debounced Resize & Orientation Handling ---
  let resizeTimer = null;
  function handleResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const nowDesktop = window.matchMedia(`(min-width: ${BREAKPOINT_PX}px)`).matches;
      if (nowDesktop !== isDesktop) {
        // Breakpoint crossed: switch image sequences cleanly
        initSequence();
      } else {
        // Dimensions changed: adapt canvas buffer
        resizeCanvas();
      }
    }, 120);
  }

  // Listeners
  window.addEventListener('resize', handleResize, { passive: true });
  window.addEventListener('orientationchange', handleResize, { passive: true });

  const mqlBreakpoint = window.matchMedia(`(min-width: ${BREAKPOINT_PX}px)`);
  mqlBreakpoint.addEventListener('change', () => {
    initSequence();
  });

  mqlReducedMotion.addEventListener('change', (e) => {
    isReducedMotion = e.matches;
    if (isReducedMotion) {
      currentScrubFrame = 0;
      targetScrubFrame = 0;
      renderFrame(0, true);
    }
  });

  // Start sequence & RAF loop
  initSequence();
  requestAnimationFrame(onFrame);
})();
