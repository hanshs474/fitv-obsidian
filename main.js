'use strict';
const { Plugin, Modal, Notice, PluginSettingTab, Setting, TFile, requestUrl, normalizePath, MarkdownView } = require('obsidian');

const BASE = 'https://freeimagetovideo.ai';
const KEYS_URL = `${BASE}/settings/apikeys`;
const PRICING_URL = `${BASE}/pricing`;
const MODEL = 'minimax-h3';
const RATIOS = ['16:9', '9:16', '1:1'];
const DURATIONS = [4, 5, 6, 8, 10, 15];
const DEFAULTS = { apiKey: '', duration: 6, resolution: '480p', ratio: '16:9', folder: 'Free Image to Video' };

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'clip';
}

class FitvError extends Error {
  constructor(message, kind = 'other') { super(message); this.kind = kind; }
}

/**
 * The site answers most refusals as HTTP 200 with a non-zero code and a
 * data.reason, so the status code alone would read a refusal as success.
 */
function explain(status, body = {}) {
  const msg = body.message || body.error || `HTTP ${status}`;
  const reason = body.data && body.data.reason;
  if (status === 401 || /no auth|api key/i.test(msg)) return new FitvError('the API key was rejected. Check it in Settings → Free Image to Video.', 'auth');
  if (body.code === -2 || body.code === -3) return new FitvError(`${msg}. Rewrite the prompt and try again.`, 'rejected');
  if (reason === 'insufficient_credits') return new FitvError(`not enough credits for this run. See ${PRICING_URL}`, 'quota');
  if (reason === 'plan_required') return new FitvError(`API runs need a paid plan. See ${PRICING_URL}`, 'plan');
  if (reason === 'concurrency') return new FitvError('another run is still generating on this account. Try again when it finishes.', 'busy');
  return new FitvError(msg);
}

/** requestUrl, not fetch: it is not subject to CORS inside the app. */
async function call(path, json, apiKey, base = BASE) {
  const key = (apiKey || '').trim();
  if (!key) throw new FitvError('add your API key in Settings → Free Image to Video first.', 'auth');
  const res = await requestUrl({
    url: base + path, method: 'POST', throw: false, contentType: 'application/json',
    headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify(json || {}),
  });
  let body = {};
  try { body = res.json || {}; } catch { /* non-JSON error page */ }
  return { status: res.status, body };
}

const ok = (r) => r.status < 400 && r.body && r.body.code === 0;

/** Submit one run on MiniMax H3, poll it, and return the clip URL. */
async function runVideo(prompt, { image, duration, resolution, ratio, apiKey, onQueued, pollEveryMs = 10000, timeoutMs = 1800000, base = BASE } = {}) {
  const options = { sound: true };
  if (duration) options.duration = Number(duration);
  if (resolution) options.resolution = resolution;
  if (ratio) options.aspect_ratio = ratio;
  if (image) options.image_input = [image];
  const r = await call('/api/ai/generate', {
    provider: 'auto', mediaType: 'video', model: MODEL,
    scene: image ? 'image-to-video' : 'text-to-video', prompt, options,
  }, apiKey, base);
  const id = r.body && r.body.data && r.body.data.id;
  if (!ok(r) || !id) throw explain(r.status, r.body);
  onQueued && onQueued(id);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, pollEveryMs));
    let s;
    try { s = await call('/api/ai/query', { taskId: String(id) }, apiKey, base); } catch { continue; } // a dropped poll is not a failed run
    if (s.status >= 500) continue;
    if (!ok(s)) throw explain(s.status, s.body);
    const t = s.body.data || {};
    if (t.status === 'success' && t.videos && t.videos.length) return String(t.videos[0]);
    if (t.status === 'failed' || t.status === 'canceled') {
      throw new FitvError(`the run ${t.status}${t.errorMessage ? `: ${t.errorMessage}` : ''}. Try rewording the prompt.`, 'failed');
    }
  }
  throw new FitvError('not finished in time; the clip will still be in your library on freeimagetovideo.ai.', 'timeout');
}

async function credits(apiKey, base = BASE) {
  const r = await call('/api/user/get-user-credits', {}, apiKey, base);
  if (ok(r)) return Number((r.body.data && r.body.data.remainingCredits) || 0);
  throw explain(r.status, r.body);
}

async function uploadImage(bytes, filename, base = BASE) {
  const ext = (filename.match(/\.([a-z0-9]+)$/i) || [, 'png'])[1].toLowerCase();
  const type = { jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[ext] || 'image/png';
  const boundary = '----fitv' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const enc = new TextEncoder();
  const head = enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename.replace(/"/g, '')}"\r\nContent-Type: ${type}\r\n\r\n`);
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + bytes.byteLength + tail.length);
  body.set(head, 0); body.set(new Uint8Array(bytes), head.length); body.set(tail, head.length + bytes.byteLength);
  const res = await requestUrl({ url: `${base}/api/storage/upload-image`, method: 'POST', throw: false, body: body.buffer, contentType: `multipart/form-data; boundary=${boundary}` });
  let env = {};
  try { env = res.json || {}; } catch { /* fall through */ }
  const url = env && env.data && env.data.urls && env.data.urls[0];
  if (env.code !== 0 || !url) throw new FitvError(`upload failed: ${env.message || `HTTP ${res.status}`}`);
  return url;
}

class PromptModal extends Modal {
  constructor(app, { title, placeholder, ratio }, onSubmit) {
    super(app);
    Object.assign(this, { title, placeholder, onSubmit, ratio, prompt: '' });
  }
  onOpen() {
    this.titleEl.setText(this.title);
    new Setting(this.contentEl).setName('Prompt').addTextArea((t) => {
      t.setPlaceholder(this.placeholder).onChange((v) => (this.prompt = v));
      t.inputEl.rows = 4;
      t.inputEl.style.width = '100%';
    });
    new Setting(this.contentEl).setName('Aspect ratio').addDropdown((d) => {
      RATIOS.forEach((r) => d.addOption(r, r));
      d.setValue(this.ratio).onChange((v) => (this.ratio = v));
    });
    new Setting(this.contentEl).addButton((b) => b.setButtonText('Generate').setCta().onClick(() => {
      if (!this.prompt.trim()) return new Notice('Write a prompt first.');
      this.close();
      this.onSubmit(this.prompt.trim(), this.ratio);
    }));
  }
  onClose() { this.contentEl.empty(); }
}

module.exports = class FreeImageToVideoPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.addSettingTab(new FitvSettingTab(this.app, this));
    this.addCommand({
      id: 'animate-image', name: 'Animate the image under the cursor',
      editorCallback: (editor) => {
        const line = editor.getLine(editor.getCursor().line);
        const m = line.match(/!\[\[([^\]|]+)/);
        const file = m && this.app.metadataCache.getFirstLinkpathDest(m[1], (this.app.workspace.getActiveFile() || {}).path || '');
        if (!file) return new Notice('Put the cursor on a line with an embedded image (![[…]]).');
        this.animate(file);
      },
    });
    this.addCommand({ id: 'generate-video', name: 'Generate video from a prompt into this note', callback: () => this.generate() });
    this.addCommand({
      id: 'show-credits', name: 'Show remaining credits',
      callback: async () => {
        try { new Notice(`Free Image to Video: ${await credits(this.settings.apiKey)} credits left.`); } catch (e) { new Notice(`Free Image to Video: ${e.message}`); }
      },
    });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFile && /^(png|jpe?g|webp)$/i.test(file.extension)) {
        menu.addItem((item) => item.setTitle('Turn into a video clip').setIcon('film').onClick(() => this.animate(file)));
      }
    }));
  }

  async save(url, name) {
    const res = await requestUrl({ url });
    const ext = (url.match(/\.(mp4|webm|mov)(\?|$)/i) || [, 'mp4'])[1];
    const folder = normalizePath(this.settings.folder || DEFAULTS.folder);
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    return this.app.vault.createBinary(normalizePath(`${folder}/${name}-${Date.now().toString(36)}.${ext}`), res.arrayBuffer);
  }

  async run(prompt, { ratio, image, name }) {
    const s = this.settings;
    const notice = new Notice('Free Image to Video: submitting…', 0);
    try {
      const url = await runVideo(prompt, {
        apiKey: s.apiKey, image, ratio, duration: s.duration, resolution: s.resolution,
        onQueued: () => notice.setMessage('Free Image to Video: rendering, a clip takes a few minutes…'),
      });
      const file = await this.save(url, name);
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view) view.editor.replaceSelection(`![[${file.path}]]\n`);
      notice.setMessage(`Free Image to Video: saved ${file.path}`);
    } catch (e) {
      notice.setMessage(`Free Image to Video: ${e.message}`);
    } finally {
      setTimeout(() => notice.hide(), 8000);
    }
  }

  generate() {
    new PromptModal(this.app, {
      title: 'Free Image to Video: generate a clip',
      placeholder: 'a paper lantern drifting over a night river, low angle, slow push-in, soft water sounds',
      ratio: this.settings.ratio,
    }, (prompt, ratio) => this.run(prompt, { ratio, name: slug(prompt) })).open();
  }

  animate(file) {
    if (!(this.settings.apiKey || '').trim()) return new Notice('Free Image to Video: add your API key in Settings → Free Image to Video first.', 8000);
    new PromptModal(this.app, {
      title: `Free Image to Video: animate ${file.name}`,
      placeholder: 'the camera slowly orbits the subject while light sweeps across it',
      ratio: this.settings.ratio,
    }, async (prompt, ratio) => {
      let image;
      try {
        new Notice('Free Image to Video: uploading the first frame…', 3000);
        image = await uploadImage(await this.app.vault.readBinary(file), file.name);
      } catch (e) {
        return new Notice(`Free Image to Video: ${e.message}`, 8000);
      }
      await this.run(prompt, { ratio, image, name: `${file.basename}-clip` });
    }).open();
  }
};

class FitvSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    const p = this.plugin;
    const saveAs = (k, f = (v) => v) => async (v) => { p.settings[k] = f(v); await p.saveData(p.settings); };
    containerEl.empty();
    new Setting(containerEl)
      .setName('API key')
      .setDesc('From freeimagetovideo.ai/settings/apikeys. API runs need a paid plan: each run draws on the plan\'s full-speed allowance, then waits in the relaxed queue.')
      .addText((t) => { t.inputEl.type = 'password'; t.setValue(p.settings.apiKey).onChange(saveAs('apiKey', (v) => v.trim())); })
      .addExtraButton((b) => b.setIcon('external-link').setTooltip('Get a key').onClick(() => window.open(KEYS_URL)));
    new Setting(containerEl).setName('Clip length (seconds)').addDropdown((d) => {
      DURATIONS.forEach((n) => d.addOption(String(n), `${n} s`));
      d.setValue(String(p.settings.duration)).onChange(saveAs('duration', Number));
    });
    new Setting(containerEl).setName('Resolution').addDropdown((d) => {
      ['480p', '768p'].forEach((r) => d.addOption(r, r));
      d.setValue(p.settings.resolution).onChange(saveAs('resolution'));
    });
    new Setting(containerEl).setName('Default aspect ratio').addDropdown((d) => {
      RATIOS.forEach((r) => d.addOption(r, r));
      d.setValue(p.settings.ratio).onChange(saveAs('ratio'));
    });
    new Setting(containerEl).setName('Folder').setDesc('Vault folder for new clips.')
      .addText((t) => t.setValue(p.settings.folder).onChange(saveAs('folder', (v) => v.trim() || DEFAULTS.folder)));
  }
}

module.exports.runVideo = runVideo;
module.exports.credits = credits;
module.exports.explain = explain;
