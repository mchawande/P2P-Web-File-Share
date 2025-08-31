// Robust logging module for the web UI
// Features:
// - Levelled logging (info, warn, error, success, debug)
// - Explicit param tagging for file/id/size highlighting (no regex detection)
// - Safe formatting of arbitrary values (errors, objects, circular refs)
// - Max line retention to avoid memory leaks, with history buffer
// - Optional console/global error capture
// - Works even if target element isn't ready yet (buffers and flushes)

const DEFAULTS = {
	maxLines: 500,
	autoScroll: true,
	captureConsole: true,
	captureGlobalErrors: true,
	historySize: 1000, // kept in memory regardless of DOM
};

function escapeHtml(s) {
	return String(s ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

// Tag helpers to explicitly style parts of the message without regex
function asFile(name) {
	return { __logTag: 'file', value: String(name ?? '') };
}
function asId(id) {
	return { __logTag: 'id', value: String(id ?? '') };
}
function asSize(bytes) {
	return { __logTag: 'size', value: Number(bytes ?? 0) };
}

function fmtSize(bytes) {
	const b = Number(bytes || 0);
	if (b < 1024) return `${b} B`;
	if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
	if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
	return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function serializeArg(arg, depth = 0, seen = new WeakSet()) {
	const type = typeof arg;
	if (arg == null) return String(arg);
	if (type === 'string') return arg;
	if (type === 'number' || type === 'boolean' || type === 'bigint' || type === 'symbol') return String(arg);
	if (arg instanceof Error) {
		return `${arg.name}: ${arg.message}\n${arg.stack || ''}`.trim();
	}
	if (arg instanceof ArrayBuffer) return `ArrayBuffer(${arg.byteLength})`;
	if (ArrayBuffer.isView(arg)) return `${arg.constructor?.name || 'TypedArray'}(${arg.byteLength})`;
	if (arg instanceof Blob) return `Blob(${arg.size}B, ${arg.type || 'application/octet-stream'})`;
	if (arg instanceof Date) return arg.toISOString();
	if (depth > 3) return '[Object]';
	try {
		if (seen.has(arg)) return '[Circular]';
		seen.add(arg);
		return JSON.stringify(arg, (k, v) => {
			if (typeof v === 'bigint') return `${v}n`;
			if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
			if (v instanceof ArrayBuffer) return { type: 'ArrayBuffer', bytes: v.byteLength };
			if (ArrayBuffer.isView(v)) return { type: v.constructor?.name || 'TypedArray', bytes: v.byteLength };
			return v;
		});
	} catch (e) {
		return String(arg);
	}
}
// Build a safe, escaped plain-text string
function formatToText(args) {
	return args
		.map((a) => {
			if (a && typeof a === 'object' && a.__logTag === 'file') return `"${a.value}"`;
			if (a && typeof a === 'object' && a.__logTag === 'id') return String(a.value);
			if (a && typeof a === 'object' && a.__logTag === 'size') return fmtSize(a.value);
			return serializeArg(a);
		})
		.join(' ');
}
// Build HTML from tagged args (no regex highlighting)
function formatToHtml(args) {
	return args
		.map((a) => {
			if (a && typeof a === 'object' && a.__logTag === 'file') {
				return `<span class="t-file">"${escapeHtml(a.value)}"</span>`;
			}
			if (a && typeof a === 'object' && a.__logTag === 'id') {
				return `<span class="t-id">${escapeHtml(a.value)}</span>`;
			}
			if (a && typeof a === 'object' && a.__logTag === 'size') {
				return `<span class="t-num">${escapeHtml(fmtSize(a.value))}</span>`;
			}
			// Everything else becomes escaped text
			return escapeHtml(serializeArg(a));
		})
		.join(' ');
}

function timeNow() {
	const now = new Date();
	const hh = String(now.getHours()).padStart(2, '0');
	const mm = String(now.getMinutes()).padStart(2, '0');
	const ss = String(now.getSeconds()).padStart(2, '0');
	return `[${hh}:${mm}:${ss}]`;
}

export function createLogger(targetEl, options = {}) {
	const opts = { ...DEFAULTS, ...options };
	let logEl = targetEl || null;
	let lineCount = 0;
	let buffer = []; // holds DOM-less entries until element exists
	let history = [];
	let restoreFns = [];

	async function copyToClipboard(text) {
		if (!text) return false;
		try {
			if (navigator.clipboard && window.isSecureContext) {
				await navigator.clipboard.writeText(text);
				return true;
			}
		} catch {}
		// Fallback: temporary textarea + execCommand
		const ta = document.createElement('textarea');
		ta.value = text;
		ta.setAttribute('readonly', '');
		ta.style.position = 'fixed';
		ta.style.left = '-9999px';
		document.body.appendChild(ta);
		ta.focus();
		ta.select();
		let ok = false;
		try {
			ok = document.execCommand('copy');
		} catch {
			ok = false;
		} finally {
			document.body.removeChild(ta);
		}
		return ok;
	}

	function append(level, html, text) {
		const entry = { ts: Date.now(), level, html, text };
		// Keep history (bounded)
		history.push(entry);
		if (history.length > opts.historySize) history.splice(0, history.length - opts.historySize);

		if (!logEl) {
			buffer.push(entry);
			return;
		}
		const line = document.createElement('div');
		line.className = `log-line level-${level}`;
		const timeEl = document.createElement('span');
		timeEl.className = 'time';
		timeEl.textContent = timeNow();
		const msgEl = document.createElement('span');
		msgEl.className = 'msg';
		msgEl.innerHTML = ' ' + html;
		const copyBtn = document.createElement('button');
		copyBtn.className = 'copy-btn';
		copyBtn.type = 'button';
		copyBtn.setAttribute('aria-label', 'Copy log line');
		copyBtn.title = 'Copy';
		copyBtn.textContent = 'Copy';
		copyBtn.addEventListener('click', async () => {
			const original = copyBtn.textContent;
			copyBtn.disabled = true;
			const ok = await copyToClipboard(text);
			copyBtn.textContent = ok ? 'Copied' : 'Failed';
			setTimeout(() => {
				copyBtn.textContent = original || 'Copy';
				copyBtn.disabled = false;
			}, 800);
		});
		line.append(timeEl, msgEl, copyBtn);
		logEl.appendChild(line);
		lineCount++;
		// Trim old lines
		if (lineCount > opts.maxLines) {
			const excess = lineCount - opts.maxLines;
			for (let i = 0; i < excess; i++) {
				if (logEl.firstChild) logEl.removeChild(logEl.firstChild);
			}
			lineCount = opts.maxLines;
		}
		if (opts.autoScroll) {
			logEl.scrollTop = logEl.scrollHeight;
		}
	}

	function flushBuffer() {
		if (!logEl || buffer.length === 0) return;
		const toFlush = buffer.slice();
		buffer.length = 0;
		for (const e of toFlush) append(e.level, e.html, e.text);
	}

	function logGeneric(...args) {
		// Default to info for generic logs
		const html = formatToHtml(args);
		const text = formatToText(args);
		append('info', html, text);
	}
	function info(...args) {
		const html = formatToHtml(args);
		const text = formatToText(args);
		append('info', html, text);
	}
	function warn(...args) {
		const html = formatToHtml(args);
		const text = formatToText(args);
		append('warn', html, text);
	}
	function error(...args) {
		const html = formatToHtml(args);
		const text = formatToText(args);
		append('error', html, text);
	}
	function success(...args) {
		const html = formatToHtml(args);
		const text = formatToText(args);
		append('success', html, text);
	}
	function debug(...args) {
		const html = formatToHtml(args);
		const text = formatToText(args);
		append('info', escapeHtml('[debug]') + ' ' + html, '[debug] ' + text);
	}

	function clear() {
		buffer.length = 0;
		history.length = 0;
		if (logEl) {
			logEl.innerHTML = '';
			lineCount = 0;
		}
	}

	function setTarget(el) {
		logEl = el || null;
		lineCount = logEl ? logEl.children.length : 0;
		flushBuffer();
	}

	function setAutoScroll(v) {
		opts.autoScroll = !!v;
	}
	function setMaxLines(n) {
		opts.maxLines = Math.max(1, Number(n) || DEFAULTS.maxLines);
	}

	function captureConsole() {
		if (!opts.captureConsole) return;
		const original = {
			log: console.log,
			info: console.info,
			warn: console.warn,
			error: console.error,
		};
		console.log = (...a) => {
			original.log.apply(console, a);
			info(...a);
		};
		console.info = (...a) => {
			original.info.apply(console, a);
			info(...a);
		};
		console.warn = (...a) => {
			original.warn.apply(console, a);
			warn(...a);
		};
		console.error = (...a) => {
			original.error.apply(console, a);
			error(...a);
		};
		restoreFns.push(() => {
			console.log = original.log;
			console.info = original.info;
			console.warn = original.warn;
			console.error = original.error;
		});
	}

	function captureGlobal() {
		if (!opts.captureGlobalErrors) return;
		const onErr = (event) => {
			try {
				const msg = event?.message || 'Uncaught error';
				const src = event?.filename ? ` @ ${event.filename}:${event.lineno || 0}:${event.colno || 0}` : '';
				const stack = event?.error?.stack ? `\n${event.error.stack}` : '';
				error(`${msg}${src}${stack}`);
			} catch {}
		};
		const onRej = (event) => {
			try {
				const reason =
					event?.reason instanceof Error
						? `${event.reason.name}: ${event.reason.message}\n${event.reason.stack || ''}`
						: serializeArg(event?.reason);
				error('Unhandled promise rejection:', reason);
			} catch {}
		};
		window.addEventListener('error', onErr);
		window.addEventListener('unhandledrejection', onRej);
		restoreFns.push(() => {
			window.removeEventListener('error', onErr);
			window.removeEventListener('unhandledrejection', onRej);
		});
	}

	function destroy() {
		for (const fn of restoreFns.splice(0)) {
			try {
				fn();
			} catch {}
		}
	}

	// Init
	if (logEl) flushBuffer();
	captureConsole();
	captureGlobal();

	return {
		// Primary API
		log: logGeneric,
		info,
		warn,
		error,
		success,
		debug,
		clear,
		// Controls
		setTarget,
		setAutoScroll,
		setMaxLines,
		destroy,
		// Observability
		getHistory: () => history.slice(),
	};
}

// Optional named exports for consumers
export { asFile, asId, asSize, escapeHtml };
