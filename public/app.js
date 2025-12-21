/**
 * SpriteForge — Interactive Spooled Cloud Demo
 * 
 * This application demonstrates:
 * - Job creation and workflows
 * - Real-time event streaming (WebSocket → SSE)
 * - Automatic retries on failure
 * - Parallel job processing
 * - DAG workflow dependencies
 */

const $ = (id) => document.getElementById(id);

// ═══════════════════════════════════════════════════════════════════════════
// Element References
// ═══════════════════════════════════════════════════════════════════════════

const els = {
  // Header
  pill: $('conn-pill'),
  statJobs: $('stat-jobs'),
  statCompleted: $('stat-completed'),
  statRetries: $('stat-retries'),
  
  // Form
  seed: $('seed'),
  palette: $('palette'),
  animation: $('animation'),
  frames: $('frames'),
  framesLabel: $('frames-label'),
  chaos: $('chaos'),
  chaosLabel: $('chaos-label'),
  forge: $('forge'),
  download: $('download'),
  
  // Preview
  preview: $('preview'),
  previewOverlay: $('preview-overlay'),
  previewStatus: $('preview-status'),
  previewMeta: $('preview-meta'),
  previewProgress: $('preview-progress'),
  progressText: $('progress-text'),
  
  // Jobs
  jobs: $('jobs'),
  jobsEmpty: $('jobs-empty'),
  jobCounter: $('job-counter'),
  wfFrames: $('wf-frames'),
  wfAssemble: $('wf-assemble'),
  
  // Events
  log: $('log'),
  eventIndicator: $('event-indicator'),
  
  // Public
  public: $('public'),
  
  // Steps
  steps: [1, 2, 3, 4, 5].map(n => $(`step-${n}`)),
};

// ═══════════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════════

let sessionId = crypto.randomUUID();
let palettes = [];
let sprite = null;
let lastWorkflowId = null;
let animFrame = 0;
let animT0 = 0;
let publicSpriteMsg = null;

/** @type {Map<string, { key: string; status: string; retryCount: number; queueName?: string }>} */
const jobs = new Map();

/** @type {Map<number, string[]>} */
const framePixels = new Map();

// Stats
let currentStep = 0;
let reconcileJobIds = [];
let reconcileTimer = null;

// ═══════════════════════════════════════════════════════════════════════════
// Logging & UI Updates
// ═══════════════════════════════════════════════════════════════════════════

function flashEventIndicator() {
  els.eventIndicator.classList.add('flash');
  setTimeout(() => els.eventIndicator.classList.remove('flash'), 150);
}

function logLine(line, type = 'info') {
  flashEventIndicator();
  
  const ts = new Date().toISOString().slice(11, 19);
  const div = document.createElement('div');
  div.className = `event-line event-${type}`;
  div.innerHTML = `<span class="time">[${ts}]</span> ${line}`;
  
  if (els.log.firstChild) {
    els.log.insertBefore(div, els.log.firstChild);
  } else {
    els.log.appendChild(div);
  }
  
  // Keep only last 100 entries
  while (els.log.children.length > 100) {
    els.log.removeChild(els.log.lastChild);
  }
}

function setPill(text, state = 'neutral') {
  els.pill.querySelector('.pill-text').textContent = text;
  els.pill.className = `pill ${state}`;
}

function updateStats() {
  const vals = [...jobs.values()];
  const created = vals.length;
  const completed = vals.filter((j) => j.status === 'completed').length;
  const retries = vals.reduce((acc, j) => acc + (Number(j.retryCount) || 0), 0);
  els.statJobs.textContent = created;
  els.statCompleted.textContent = completed;
  els.statRetries.textContent = retries;
}

function setStep(step) {
  currentStep = step;
  els.steps.forEach((el, i) => {
    if (!el) return;
    el.classList.remove('active', 'completed');
    if (i + 1 < step) el.classList.add('completed');
    if (i + 1 === step) el.classList.add('active');
  });
}

function normalizeEventType(type) {
  if (!type) return '';
  const t = String(type);
  if (t.includes('.')) return t.toLowerCase();
  return t.replace(/([a-z])([A-Z])/g, '$1.$2').toLowerCase();
}

function normalizeStatus(status) {
  const s = String(status || '').toLowerCase();
  if (!s) return null;
  if (s === 'processing' || s === 'running' || s === 'active' || s === 'started') return 'processing';
  if (s === 'pending' || s === 'queued' || s === 'created') return 'pending';
  if (s === 'completed' || s === 'succeeded' || s === 'success') return 'completed';
  if (s === 'failed' || s === 'error' || s === 'deadlettered' || s === 'dead_letter') return 'failed';
  return s;
}

async function reconcileOnce({ includeResult }) {
  if (!reconcileJobIds || reconcileJobIds.length === 0) return;
  try {
    const res = await fetch('/api/jobs/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, jobIds: reconcileJobIds, includeResult }),
    });
    if (!res.ok) return;
    const body = await res.json();
    const list = Array.isArray(body.jobs) ? body.jobs : [];

    for (const item of list) {
      if (!item || !item.jobId) continue;
      if (!jobs.has(item.jobId)) continue;
      const job = jobs.get(item.jobId);

      const st = normalizeStatus(item.status);
      if (st) job.status = st;
      if (typeof item.retryCount === 'number') job.retryCount = item.retryCount;

      // If we missed realtime results, recover them via polling
      if (includeResult && item.result && typeof item.result === 'object') {
        if (item.result.kind === 'frame') {
          framePixels.set(item.result.frameIndex, item.result.pixels);
        }
        if (item.result.kind === 'sprite') {
          // Prevent duplicate sprite setting from reconcile (should only happen once)
          if (sprite && sprite.frames?.length) {
            console.log('[sprite] Ignoring reconcile sprite (already have sprite):', {
              existingSeed: sprite.seed,
              incomingSeed: item.result.seed,
            });
            continue;
          }
          console.log('[sprite] Setting sprite from reconcile:', {
            jobId: item.jobId,
            seed: item.result.seed,
            paletteName: item.result.paletteName,
            palettePreview: item.result.palette?.slice(0, 3),
            frameCount: item.result.frameCount,
          });
          sprite = {
            seed: item.result.seed,
            animation: item.result.animation,
            frameCount: item.result.frameCount,
            width: item.result.width,
            height: item.result.height,
            palette: item.result.palette,
            frames: item.result.frames,
          };
        }
      }
    }

    // Stop polling if everything is completed (or we already have the final sprite)
    const vals = [...jobs.values()];
    const allDone = vals.length > 0 && vals.every((j) => j.status === 'completed');
    if (sprite && sprite.frames?.length) {
      els.previewStatus.textContent = 'Complete!';
      enableDownloadIfReady();
      setStep(5);
      // Mark step 5 (assemble) as completed
      if (els.steps[4]) els.steps[4].classList.add('completed');
      // ensure UI shows green everywhere
      for (const [, j] of jobs) j.status = 'completed';
      stopReconcile();
    } else if (allDone) {
      stopReconcile();
    }

    updateStats();
    renderJobs();
  } catch {
    // ignore - poller is best-effort
  }
}

function startReconcile(jobIds) {
  stopReconcile();
  reconcileJobIds = jobIds.slice();
  // Poll fast for the first ~20s to converge quickly, then continue slower
  let ticks = 0;
  reconcileTimer = setInterval(() => {
    ticks++;
    const includeResult = ticks <= 25; // ~25s include results to recover missed frames/sprite
    reconcileOnce({ includeResult }).catch(() => {});
  }, 1000);
}

function stopReconcile() {
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Canvas Rendering
// ═══════════════════════════════════════════════════════════════════════════

function drawPixels(ctx, pixels, palette, scale, ox, oy) {
  for (let y = 0; y < pixels.length; y++) {
    const row = pixels[y];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '.') continue;
      const idx = parseInt(ch, 16);
      const color = palette[idx] || '#ffffff';
      ctx.fillStyle = color;
      ctx.fillRect(ox + x * scale, oy + y * scale, scale, scale);
    }
  }
}

function renderPreview() {
  const ctx = els.preview.getContext('2d');
  ctx.clearRect(0, 0, els.preview.width, els.preview.height);

  // Dark backdrop
  ctx.fillStyle = '#050508';
  ctx.fillRect(0, 0, els.preview.width, els.preview.height);

  const scale = 10;
  const w = sprite?.width ?? 24;
  const h = sprite?.height ?? 24;
  const ox = Math.floor((els.preview.width - w * scale) / 2);
  const oy = Math.floor((els.preview.height - h * scale) / 2);

  const palette = sprite?.palette ?? (palettes[0]?.colors || []);

  // Get the best available frame
  let pixels = null;
  if (sprite?.frames?.length) {
    pixels = sprite.frames[animFrame % sprite.frames.length];
  } else if (framePixels.size > 0) {
    const keys = [...framePixels.keys()].sort((a, b) => a - b);
    const idx = animFrame % keys.length;
    pixels = framePixels.get(keys[idx]);
  }

  if (pixels) {
    // Subtle grid background
    ctx.fillStyle = 'rgba(255,255,255,0.02)';
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if ((x + y) % 2 === 0) {
          ctx.fillRect(ox + x * scale, oy + y * scale, scale, scale);
        }
      }
    }
    
    drawPixels(ctx, pixels, palette, scale, ox, oy);
    
    // Hide overlay when we have content
    els.previewOverlay.classList.add('hidden');
  }
}

function tick(t) {
  if (!animT0) animT0 = t;
  const dt = t - animT0;
  const fps = 8;
  animFrame = Math.floor((dt / 1000) * fps);
  renderPreview();
  requestAnimationFrame(tick);
}

// ═══════════════════════════════════════════════════════════════════════════
// Jobs UI
// ═══════════════════════════════════════════════════════════════════════════

function renderWorkflowDiagram() {
  // Clear existing frame nodes
  els.wfFrames.innerHTML = '<div class="wf-label">parallel frames</div>';
  
  const frameJobs = [...jobs.entries()]
    .filter(([, j]) => j.key.startsWith('frame-'))
    .sort(([, a], [, b]) => {
      // Sort numerically (frame-2 before frame-10)
      const aNum = parseInt(a.key.replace('frame-', ''), 10);
      const bNum = parseInt(b.key.replace('frame-', ''), 10);
      return aNum - bNum;
    });
  
  for (const [, job] of frameJobs) {
    const node = document.createElement('div');
    node.className = `wf-node ${job.status}`;
    node.textContent = job.key.replace('frame-', 'f');
    els.wfFrames.appendChild(node);
  }
  
  // Update assemble node
  const assembleJob = [...jobs.values()].find(j => j.key === 'assemble');
  els.wfAssemble.className = `wf-node wf-assemble ${assembleJob?.status || ''}`;
}

function renderJobs() {
  // Count completed
  const completed = [...jobs.values()].filter(j => j.status === 'completed').length;
  const total = jobs.size;
  
  els.jobCounter.textContent = `${completed}/${total}`;
  els.jobsEmpty.style.display = jobs.size === 0 ? 'block' : 'none';
  
  // Update workflow diagram
  renderWorkflowDiagram();
  
  // Render job list
  els.jobs.innerHTML = '';
  const items = [...jobs.entries()]
    .map(([jobId, j]) => ({ jobId, ...j }))
    .sort((a, b) => {
      // Assemble last
      if (a.key === 'assemble') return 1;
      if (b.key === 'assemble') return -1;
      // Sort frames numerically (frame-2 before frame-10)
      const aNum = parseInt(a.key.replace('frame-', ''), 10);
      const bNum = parseInt(b.key.replace('frame-', ''), 10);
      if (!isNaN(aNum) && !isNaN(bNum)) return aNum - bNum;
      return a.key.localeCompare(b.key);
    });

  for (const item of items) {
    const div = document.createElement('div');
    div.className = `job ${item.status}`;

    const left = document.createElement('div');
    left.className = 'left';

    const dot = document.createElement('div');
    dot.className = `dot ${item.status}`;

    const key = document.createElement('div');
    key.textContent = item.key;

    left.appendChild(dot);
    left.appendChild(key);

    const right = document.createElement('div');
    right.className = 'right';
    
    const status = document.createElement('span');
    status.className = 'status';
    status.textContent = item.status;
    right.appendChild(status);
    
    if (item.retryCount > 0) {
      const badge = document.createElement('span');
      badge.className = 'retry-badge';
      badge.textContent = `🔄 ${item.retryCount}`;
      badge.title = `Retried ${item.retryCount} time(s)`;
      right.appendChild(badge);
    }

    div.appendChild(left);
    div.appendChild(right);
    els.jobs.appendChild(div);
  }
}

function enableDownloadIfReady() {
  els.download.disabled = !(sprite && sprite.frames && sprite.frames.length > 0);
}

function updateProgress(done, total, phase = 'frames') {
  if (!els.previewProgress || !els.progressText) return;
  
  if (phase === 'complete') {
    els.previewProgress.classList.remove('hidden');
    els.previewProgress.classList.add('complete');
    els.progressText.textContent = `✅ Complete! ${total} frames`;
  } else if (phase === 'assembling') {
    els.previewProgress.classList.remove('hidden', 'complete');
    els.progressText.textContent = `🔧 Assembling ${total} frames…`;
  } else if (phase === 'frames') {
    els.previewProgress.classList.remove('hidden', 'complete');
    if (done < total) {
      els.progressText.textContent = `⏳ ${done}/${total} frames ready`;
    } else {
      els.progressText.textContent = `✓ ${done}/${total} frames ready`;
    }
  } else {
    els.previewProgress.classList.add('hidden');
  }
}

function hideProgress() {
  if (els.previewProgress) {
    els.previewProgress.classList.add('hidden');
    els.previewProgress.classList.remove('complete');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Download
// ═══════════════════════════════════════════════════════════════════════════

function downloadSpriteSheetPng() {
  if (!sprite) return;
  const w = sprite.width;
  const h = sprite.height;
  const frames = sprite.frames;
  const palette = sprite.palette;

  const sheet = document.createElement('canvas');
  const scale = 4;
  sheet.width = w * frames.length * scale;
  sheet.height = h * scale;
  const ctx = sheet.getContext('2d');
  ctx.clearRect(0, 0, sheet.width, sheet.height);

  for (let i = 0; i < frames.length; i++) {
    drawPixels(ctx, frames[i], palette, scale, i * w * scale, 0);
  }

  const a = document.createElement('a');
  a.download = `spriteforge-${sprite.seed}-${sprite.animation}.png`.replace(/[^a-z0-9._-]/gi, '_');
  a.href = sheet.toDataURL('image/png');
  a.click();
  
  logLine(`Downloaded sprite sheet: ${frames.length} frames`, 'completed');
}

// ═══════════════════════════════════════════════════════════════════════════
// Forge Sprite
// ═══════════════════════════════════════════════════════════════════════════

async function forgeSprite() {
  // Reset state
  sprite = null;
  framePixels.clear();
  lastWorkflowId = null;
  jobs.clear();
  renderJobs();
  enableDownloadIfReady();
  els.previewOverlay.classList.remove('hidden');
  hideProgress();
  
  setStep(1);

  const seed = (els.seed.value || '').trim() || `sprite-${Math.random().toString(16).slice(2, 6)}`;
  const paletteName = els.palette.value || 'neon';
  const animation = els.animation.value || 'walk';
  const frameCount = Number(els.frames.value || 8);
  const failChance = Number(els.chaos.value || 0) / 100;

  els.previewMeta.textContent = 'Creating workflow…';
  els.previewStatus.textContent = 'Creating…';
  
  logLine(`🎨 <strong>FORGE</strong> seed="${seed}" palette="${paletteName}" frames=${frameCount} chaos=${Math.round(failChance * 100)}%`, 'created');

  try {
    const res = await fetch('/api/forge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        seed,
        paletteName,
        animation,
        frameCount,
        width: 24,
        height: 24,
        failChance,
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      els.previewMeta.textContent = `Error: ${body.error || res.status}`;
      els.previewStatus.textContent = 'Error';
      logLine(`❌ Forge failed: ${body.message || body.error || res.status}`, 'failed');
      setStep(0);
      return;
    }

    const body = await res.json();
    lastWorkflowId = body.workflowId;
    els.previewMeta.textContent = `Workflow: ${lastWorkflowId.slice(0, 8)}…`;
    els.previewStatus.textContent = 'Queued';
    
    setStep(2);
    
    logLine(`📋 Workflow created: <code>${lastWorkflowId.slice(0, 8)}…</code> with ${body.jobIds?.length || 0} jobs`, 'created');

    for (const j of body.jobIds || []) {
      jobs.set(j.jobId, { key: j.key, status: 'pending', retryCount: 0 });
    }
    
    updateStats();
    renderJobs();

    // Start reconciliation poller to make UI authoritative even if events are missed
    const ids = (body.jobIds || []).map((j) => j.jobId).filter(Boolean);
    startReconcile(ids);
  } catch (err) {
    els.previewMeta.textContent = `Error: ${err.message}`;
    logLine(`❌ Network error: ${err.message}`, 'failed');
    setStep(0);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Event Handling
// ═══════════════════════════════════════════════════════════════════════════

function handleSpooledEvent(evt) {
  const type = evt.type;
  const data = evt.data || {};
  const meta = evt.meta || {};
  
  // Normalize event type to lowercase dotted format
  const normalizedType = normalizeEventType(type);
  const statusFromPayload = normalizeStatus(data.status);
  const retryFromPayload = data.retryCount ?? data.retry_count ?? null;

  // Spooled WebSocket uses enum variant names (e.g. JobStatusChange) which we normalize to `job.status.change`.
  // This event is the primary way we see "processing → pending" (retry scheduled) and other transitions.
  if (normalizedType === 'job.status.change' || normalizedType === 'job.status') {
    const newStatusRaw = data.new_status ?? data.newStatus ?? data.new ?? null;
    const oldStatusRaw = data.old_status ?? data.oldStatus ?? data.old ?? null;
    const newStatus = normalizeStatus(newStatusRaw);
    const oldStatus = normalizeStatus(oldStatusRaw);

    if (jobs.has(data.jobId) && newStatus) {
      const job = jobs.get(data.jobId);
      // Don't regress a completed job
      if (job.status !== 'completed') {
        job.status = newStatus;
      }
      if (typeof retryFromPayload === 'number') job.retryCount = retryFromPayload;
      updateStats();
      renderJobs();

      // Keep the log compact; only log meaningful transitions
      if (oldStatus && oldStatus !== newStatus) {
        const label = meta.key || job.key || data.jobId?.slice(0, 8) || '?';
        logLine(`🔁 Status: <code>${label}</code> ${oldStatus} → <strong>${newStatus}</strong>`, 'info');
      }

      if (newStatus === 'processing') {
        setStep(3);
        els.previewStatus.textContent = 'Processing…';
      }
      if (newStatus === 'completed') {
        setStep(4);
      }

      // Make the "assemble" phase obvious (non-technical users look at the preview first)
      if (job.key === 'assemble') {
        // Get expected frame count from tracked jobs
        const frameCount = [...jobs.values()].filter(j => j.key.startsWith('frame-')).length || 8;
        
        if (newStatus === 'processing') {
          els.previewStatus.textContent = 'Assembling…';
          els.previewMeta.textContent = 'Combining all frames into the final sprite…';
          setStep(5); // Step 5 = Assemble is now active
          updateProgress(frameCount, frameCount, 'assembling');
        }
        if (newStatus === 'pending' && oldStatus === 'processing') {
          els.previewStatus.textContent = 'Assemble retry scheduled…';
        }
        if (newStatus === 'completed') {
          setStep(5);
          // Mark step 5 as completed
          if (els.steps[4]) els.steps[4].classList.add('completed');
        }
      }
    }
    return;
  }

  if (normalizedType === 'job.created') {
    if (jobs.has(data.jobId)) {
      const job = jobs.get(data.jobId);
      job.status = statusFromPayload || 'pending';
      job.queueName = data.queueName;
      if (typeof retryFromPayload === 'number') job.retryCount = retryFromPayload;
      renderJobs();
      updateStats();
    }
  }

  if (normalizedType === 'job.started') {
    if (jobs.has(data.jobId)) {
      const job = jobs.get(data.jobId);
      // Only update if not already completed (events can arrive out of order)
      if (job.status !== 'completed') {
        job.status = statusFromPayload || 'processing';
        if (typeof retryFromPayload === 'number') job.retryCount = retryFromPayload;
        renderJobs();
        setStep(3);
        els.previewStatus.textContent = 'Processing…';
      }
      updateStats();
    }
    logLine(`⚙️ Processing: <code>${meta.key || data.jobId?.slice(0, 8)}</code>`, 'info');
  }

  if (normalizedType === 'job.failed') {
    // Get the retry count from the server (snake_case or camelCase)
    const serverRetryCount = data.retry_count ?? data.retryCount ?? 0;
    
    if (jobs.has(data.jobId)) {
      const job = jobs.get(data.jobId);
      // Only update if not already completed
      if (job.status !== 'completed') {
        job.status = statusFromPayload || 'failed';
        job.retryCount = Number(serverRetryCount) || 0;
        renderJobs();
        updateStats();
      }
    }
    
    const willRetry = data.willRetry !== false && data.will_retry !== false;
    logLine(
      `${willRetry ? '🔄' : '❌'} <span class="event-${willRetry ? 'retry' : 'failed'}">FAILED</span> ` +
      `<code>${meta.key || '?'}</code> — ${data.error || data.reason || 'unknown error'}` +
      (willRetry ? ` (retry #${serverRetryCount + 1})` : ' (no more retries)'),
      willRetry ? 'retry' : 'failed'
    );
  }

  if (normalizedType === 'job.completed') {
    // CRITICAL: Only process events for jobs that belong to the CURRENT forge.
    // Without this check, stale events from a previous (retrying) forge could
    // overwrite the current sprite with old data (different palette, etc.).
    if (!jobs.has(data.jobId)) {
      // This event is from a previous forge or unknown job - ignore it
      console.log('[sprite] Ignoring stale job.completed event:', {
        jobId: data.jobId,
        kind: data.result?.kind,
        seed: data.result?.seed,
        paletteName: data.result?.paletteName,
      });
      return;
    }
    
    const job = jobs.get(data.jobId);
    job.status = 'completed';
    if (typeof retryFromPayload === 'number') job.retryCount = retryFromPayload;
    renderJobs();
    updateStats();
    
    setStep(4);

    if (data.result && data.result.kind === 'frame') {
      framePixels.set(data.result.frameIndex, data.result.pixels);
      
      // Mark the corresponding frame job as completed by matching frame index
      const frameKey = `frame-${data.result.frameIndex}`;
      for (const [, j] of jobs) {
        if (j.key === frameKey && j.status !== 'completed') {
          j.status = 'completed';
        }
      }
      
      const done = framePixels.size;
      const total = data.result.frameCount;
      
      // If we have ALL frames, mark any remaining frame jobs as completed
      // This handles cases where events were missed but frames were actually processed
      if (done === total) {
        for (const [, j] of jobs) {
          if (j.key.startsWith('frame-') && j.status !== 'completed') {
            j.status = 'completed';
          }
        }
      }
      
      updateStats();
      renderJobs();
      
      els.previewMeta.textContent = `Frame ${done}/${total} ready`;
      if (done < total) {
        els.previewStatus.textContent = `⏳ ${done}/${total} frames`;
      } else {
        els.previewStatus.textContent = `✓ ${done}/${total} frames`;
      }
      updateProgress(done, total, 'frames');
      logLine(`✅ Frame ${data.result.frameIndex + 1}/${total} completed`, 'completed');
    }

    if (data.result && data.result.kind === 'sprite') {
      // Prevent duplicate sprite events from overwriting (should only happen once)
      if (sprite && sprite.frames?.length) {
        console.log('[sprite] Ignoring duplicate sprite event (already have sprite):', {
          existingSeed: sprite.seed,
          incomingSeed: data.result.seed,
        });
        return;
      }
      console.log('[sprite] Setting sprite from event:', {
        jobId: data.jobId,
        seed: data.result.seed,
        paletteName: data.result.paletteName,
        palettePreview: data.result.palette?.slice(0, 3),
        frameCount: data.result.frameCount,
      });
      sprite = {
        seed: data.result.seed,
        animation: data.result.animation,
        frameCount: data.result.frameCount,
        width: data.result.width,
        height: data.result.height,
        palette: data.result.palette,
        frames: data.result.frames,
      };
      
      // Mark ALL jobs as completed since the sprite is done
      // This handles cases where some events were missed
      for (const [, j] of jobs) {
        j.status = 'completed';
      }
      
      // Explicitly mark assemble job by key (in case jobId didn't match)
      for (const [, j] of jobs) {
        if (j.key === 'assemble') {
          j.status = 'completed';
        }
      }
      
      updateStats();
      renderJobs();
      
      els.previewMeta.textContent = `Done! ${sprite.frameCount} frames • ${sprite.palette.length} colors`;
      els.previewStatus.textContent = '✅ Complete!';
      enableDownloadIfReady();
      
      // Mark step 5 as completed (all steps done)
      setStep(5);
      if (els.steps[4]) els.steps[4].classList.add('completed');
      
      // Show complete progress
      updateProgress(sprite.frameCount, sprite.frameCount, 'complete');
      
      logLine(`🎉 <span class="event-completed"><strong>SPRITE COMPLETE!</strong></span> ${sprite.frameCount} frames assembled`, 'completed');

      // Once complete, stop reconciliation polling
      stopReconcile();
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Public Sprite
// ═══════════════════════════════════════════════════════════════════════════

function renderPublicSprite(msg) {
  const canvas = els.public;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#050508';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!msg || !msg.data || !msg.data.result) return;
  const r = msg.data.result;
  if (!r.frames || !r.frames.length) return;

  const palette = r.palette || palettes[0]?.colors || [];
  const pixels = r.frames[(Date.now() >> 7) % r.frames.length];
  const scale = 5;
  const ox = Math.floor((canvas.width - r.width * scale) / 2);
  const oy = Math.floor((canvas.height - r.height * scale) / 2);
  drawPixels(ctx, pixels, palette, scale, ox, oy);
}

// ═══════════════════════════════════════════════════════════════════════════
// SSE Connection
// ═══════════════════════════════════════════════════════════════════════════

function connectSse() {
  const es = new EventSource(`/api/events?sessionId=${encodeURIComponent(sessionId)}`);

  es.addEventListener('hello', (e) => {
    const msg = JSON.parse(e.data);
    sessionId = msg.sessionId;
    palettes = msg.palettes || [];

    // Populate palette dropdown
    els.palette.innerHTML = '';
    for (const p of palettes) {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = `${getPaletteEmoji(p.name)} ${p.name}`;
      els.palette.appendChild(opt);
    }

    setPill('Connected', 'connected');
    logLine(`🟢 Connected! Session: <code>${sessionId.slice(0, 8)}…</code>`, 'completed');

    if (msg.lastPublicSprite) {
      publicSpriteMsg = msg.lastPublicSprite;
      renderPublicSprite(msg.lastPublicSprite);
    }
  });

  es.addEventListener('server.realtime', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.state === 'connected') {
      setPill('Realtime Active', 'connected');
    } else if (msg.state === 'reconnecting') {
      setPill('Reconnecting…', 'neutral');
    } else {
      setPill(`Realtime: ${msg.state}`, msg.state === 'disconnected' ? 'disconnected' : 'neutral');
    }
  });

  es.addEventListener('public.sprite', (e) => {
    const msg = JSON.parse(e.data);
    publicSpriteMsg = msg;
    renderPublicSprite(msg);
    logLine('⏰ Public sprite updated (scheduled job)', 'info');
  });

  es.addEventListener('spooled', (e) => {
    const evt = JSON.parse(e.data);
    handleSpooledEvent(evt);
  });

  es.addEventListener('ping', () => {
    // Keepalive - flash indicator subtly
    flashEventIndicator();
  });

  es.onerror = () => {
    setPill('Disconnected — retrying…', 'disconnected');
  };
}

function getPaletteEmoji(name) {
  const emojis = {
    neon: '🌈',
    forest: '🌲',
    retro: '🕹️',
    midnight: '🌙',
    sunset: '🌅',
    ocean: '🌊',
  };
  return emojis[name] || '🎨';
}

// ═══════════════════════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════════════════════

function initUi() {
  // Range sliders
  els.framesLabel.textContent = els.frames.value;
  els.chaosLabel.textContent = els.chaos.value;

  els.frames.addEventListener('input', () => {
    els.framesLabel.textContent = els.frames.value;
  });
  
  els.chaos.addEventListener('input', () => {
    els.chaosLabel.textContent = els.chaos.value;
  });

  // Buttons
  els.forge.addEventListener('click', () => {
    forgeSprite().catch((e) => logLine(`❌ Error: ${e.message}`, 'failed'));
  });
  
  els.download.addEventListener('click', downloadSpriteSheetPng);

  // Keyboard shortcut
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      forgeSprite().catch((e) => logLine(`❌ Error: ${e.message}`, 'failed'));
    }
  });

  // Start animation loop
  requestAnimationFrame(tick);
  
  // Public sprite animation
  setInterval(() => {
    if (publicSpriteMsg) renderPublicSprite(publicSpriteMsg);
  }, 120);
  
  // Log welcome message
  setTimeout(() => {
    logLine('✨ Welcome to SpriteForge! Click "Forge Sprite" to begin.', 'info');
  }, 500);
}

// Start the app
initUi();
connectSse();
