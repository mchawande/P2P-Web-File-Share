import { createLogger, asFile, asId, asSize } from './logger.js';
const logEl = document.getElementById('log');
const { info, warn, error, success, debug } = createLogger(logEl);
// peer listing removed for privacy
const selfIdEl = document.getElementById('selfId');
const btnCopyId = document.getElementById('btnCopyId');
const btnShare = document.getElementById('btnShare');
const btnQR = document.getElementById('btnQR');
const statusEl = document.getElementById('status');
const statusWrap = document.getElementById('statusWrap');
const peerIdInput = document.getElementById('peerId');
const msgTextInput = document.getElementById('msgText');
const btnConnect = document.getElementById('btnConnect');
let btnDisconnect = null; // will be created dynamically
const fileInput = document.getElementById('fileInput');
const btnSend = document.getElementById('btnSend');
const btnClearFile = document.getElementById('btnClearFile');
const sentList = document.getElementById('sentList');
const recvList = document.getElementById('recvList');

// highlightImportant is imported for any external usage; logger internally uses it as well

// Fetch runtime config from server
let CONFIG = { wsPath: '/ws', iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] };
try {
	const res = await fetch('/config', { cache: 'no-store' });
	if (res.ok) CONFIG = await res.json();
} catch {}
const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + CONFIG.wsPath;
const ws = new WebSocket(wsUrl);
let selfId = null;

ws.addEventListener('message', (ev) => {
	const msg = JSON.parse(ev.data);
	if (msg.type === 'welcome') {
		selfId = formatCode(msg.id);
		selfIdEl.textContent = prettyCode(selfId);
		if (btnCopyId) btnCopyId.disabled = false;
		success('Your code', asId(selfId));
		return;
	}
	if (msg.type === 'signal' && msg.from) {
		onSignal(msg.from, msg.payload);
		return;
	}
});

function sendSignal(to, payload) {
	ws.send(JSON.stringify({ to, payload }));
}

let pc = null;
let dc = null;
let remoteId = null;
let connected = false;

// Format/normalize 6-char peer codes
function normalizeCode(input) {
	if (!input) return '';
	return String(input)
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, '');
}
function formatCode(input) {
	return normalizeCode(input); // stored form (no hyphens)
}
function prettyCode(input) {
	const s = normalizeCode(input);
	if (s.length <= 3) return s;
	return s.slice(0, 3) + '-' + s.slice(3);
}
// Centralized UI update for file-related controls
function updateFileUi() {
	const hasFile = !!(fileInput && fileInput.files && fileInput.files.length);
	const hasMsg = !!(msgTextInput && msgTextInput.value.trim().length);
	// Clear button: visible only when a file is selected
	if (btnClearFile) {
		const hasSomething = hasFile || hasMsg;
		btnClearFile.style.display = hasSomething ? '' : 'none';
		btnClearFile.disabled = !hasSomething;
	}
	// Send button depends on file or message presence and connection state
	if (btnSend) {
		const canSend = (hasFile || hasMsg) && connected && dc && dc.readyState === 'open';
		btnSend.disabled = !canSend;
	}
}

// Simple store for transfers
const transfers = {
	sent: [], // { id, name, size, mime, message?, sent, status, createdAt }
	recv: [], // { id, name, size, mime, message?, received, status, url?, createdAt }
};

function fmtSize(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtTime(ts) {
	const d = new Date(Number(ts || Date.now()));
	let h = d.getHours();
	const mm = String(d.getMinutes()).padStart(2, '0');
	const ampm = h >= 12 ? 'PM' : 'AM';
	h = h % 12;
	if (h === 0) h = 12; // midnight/noon edge
	return `${h}:${mm} ${ampm}`;
}

function renderList(listEl, items, type) {
	listEl.innerHTML = '';
	items
		.slice()
		.reverse()
		.forEach((t) => {
			const li = document.createElement('li');
			li.className = 'item';
			const isMessageOnly = (!t.size || t.size === 0) && t.message && String(t.message).trim();
			const timeText = fmtTime(t.createdAt || Date.now());

			// Thumbnail/icon column (omit for message-only)
			let thumb = null;
			if (!isMessageOnly) {
				thumb = document.createElement('div');
				thumb.className = 'thumb';
				thumb.innerHTML = `
					<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
						<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm0 0v6h6"/>
					</svg>
				`;
			}

			// Right content column wrapper
			const content = document.createElement('div');

			// Close button
			const closeBtn = document.createElement('button');
			closeBtn.className = 'close-btn';
			closeBtn.type = 'button';
			closeBtn.title = 'Remove';
			closeBtn.setAttribute('aria-label', 'Remove');
			closeBtn.textContent = '\u00d7';
			closeBtn.addEventListener('click', () => {
				const arr = type === 'sent' ? transfers.sent : transfers.recv;
				const idx = arr.findIndex((x) => x.id === t.id);
				if (idx !== -1) {
					// Revoke any object URL to free memory
					try {
						if (arr[idx] && arr[idx].url) URL.revokeObjectURL(arr[idx].url);
					} catch {}
					arr.splice(idx, 1);
					renderList(listEl, arr, type);
				}
			});

			if (isMessageOnly) {
				li.classList.add('message-only');
				const content = document.createElement('div');
				// Inline: "<time> <message>"
				const line = document.createElement('div');
				line.className = 'message-inline';
				const timeEl = document.createElement('span');
				timeEl.className = 'meta time';
				timeEl.textContent = timeText;
				timeEl.title = new Date(t.createdAt || Date.now()).toLocaleString();
				line.appendChild(timeEl);
				const msgSpan = document.createElement('span');
				msgSpan.className = 'message';
				msgSpan.textContent = String(t.message || '');
				line.appendChild(msgSpan);
				content.appendChild(line);
				li.append(content, closeBtn);
				listEl.appendChild(li);
				// No refs for message-only
				return;
			}

			// File card build
			const titleRow = document.createElement('div');
			titleRow.className = 'title-row';
			const name = document.createElement('div');
			name.className = 'name';
			name.textContent = t.name || '(unknown)';
			// status badge (placed in second row)
			const status = document.createElement('span');
			status.className = 'badge ' + (t.status === 'done' ? 'ok' : 'warn');
			status.textContent = t.status || 'pending';
			titleRow.append(name, closeBtn);

			// Second row: size (current/total) + status
			const subRow = document.createElement('div');
			subRow.className = 'row';
			const sizeEl = document.createElement('div');
			sizeEl.className = 'meta';
			subRow.append(sizeEl, status);
			const timeEl = document.createElement('div');
			timeEl.className = 'meta time';
			timeEl.textContent = timeText;
			timeEl.title = new Date(t.createdAt || Date.now()).toLocaleString();
			subRow.append(timeEl);

			// Optional message row under file details
			let messageRow = null;
			if (t.message && String(t.message).trim()) {
				messageRow = document.createElement('div');
				messageRow.className = 'message-row';
				const msgSpan = document.createElement('div');
				msgSpan.className = 'message';
				msgSpan.textContent = String(t.message);
				messageRow.appendChild(msgSpan);
			}

			// Current transferred bytes for progress bar and percent
			const cur = type === 'sent' ? t.sent || 0 : t.received || 0;
			if (t.size && t.size > 0) {
				sizeEl.textContent = `${fmtSize(cur)} / ${fmtSize(t.size || 0)}`;
			} else {
				sizeEl.textContent = 'message';
			}

			// Progress row with percentage label overlay
			const progressRow = document.createElement('div');
			progressRow.className = 'progress-row';
			const progress = document.createElement('progress');
			progress.max = t.size || 100;
			progress.value = cur;
			const pctLabel = document.createElement('div');
			pctLabel.className = 'progress-label';
			const pct = t.size ? Math.floor((cur / t.size) * 100) : 0;
			pctLabel.textContent = `${pct}%`;
			progressRow.append(progress, pctLabel);

			// Actions row (download link for received)
			const actions = document.createElement('div');
			actions.className = 'row actions';
			if (type === 'recv' && t.url && t.status === 'done') {
				const a = document.createElement('a');
				a.href = t.url;
				a.download = t.name || 'file';
				a.textContent = 'Download';
				actions.appendChild(a);
			}

			if (t.size && t.size > 0) {
				if (messageRow) content.append(titleRow, subRow, messageRow, progressRow, actions);
				else content.append(titleRow, subRow, progressRow, actions);
			}
			if (thumb) li.append(thumb, content);
			else li.append(content);
			listEl.appendChild(li);

			// Save refs for live updates
			t._progressEl = t.size && t.size > 0 ? progress : null;
			t._metaEl = sizeEl; // static size info (no progress text here)
			t._statusEl = status;
			t._pctEl = t.size && t.size > 0 ? pctLabel : null;
		});
}

async function ensurePc() {
	if (pc) return pc;
	pc = new RTCPeerConnection({
		iceServers:
			Array.isArray(CONFIG.iceServers) && CONFIG.iceServers.length
				? CONFIG.iceServers
				: [{ urls: ['stun:stun.l.google.com:19302'] }],
	});
	pc.onicecandidate = (ev) => {
		if (ev.candidate && remoteId) sendSignal(remoteId, { type: 'candidate', candidate: ev.candidate });
	};
	pc.onconnectionstatechange = () => {
		statusEl.textContent = pc.connectionState;
		if (statusWrap) {
			statusWrap.classList.remove('connected', 'connecting', 'disconnected');
			const st = pc.connectionState;
			if (st === 'connected') statusWrap.classList.add('connected');
			else if (st === 'connecting') statusWrap.classList.add('connecting');
			else statusWrap.classList.add('disconnected');
		}
		if (pc.connectionState === 'connected') {
			connected = true;
			setUiConnected(true);
		} else if (
			pc.connectionState === 'disconnected' ||
			pc.connectionState === 'failed' ||
			pc.connectionState === 'closed'
		) {
			connected = false;
			setUiConnected(false);
		}
	};
	pc.ondatachannel = (ev) => {
		dc = ev.channel;
		wireDc();
	};
	return pc;
}

function wireDc() {
	if (!dc) return;
	dc.binaryType = 'arraybuffer';
	// Better backpressure signaling for sender
	dc.bufferedAmountLowThreshold = 1 * 1024 * 1024; // 1MB
	dc.onopen = () => {
		success('DataChannel open');
		if (remoteId) success('Connected to', asId(remoteId));
		connected = true;
		setUiConnected(true);
		updateFileUi();
	};
	dc.onclose = () => {
		warn('DataChannel closed');
		connected = false;
		setUiConnected(false);
		updateFileUi();
	};
	// Receiving protocol: header JSON, then chunks, then end JSON
	let expectingHeader = true;
	let meta = null;
	let received = 0;
	const chunks = [];
	dc.onmessage = (ev) => {
		if (typeof ev.data === 'string') {
			const msg = JSON.parse(ev.data);
			if (msg.type === 'file-header') {
				meta = msg;
				expectingHeader = false;
				received = 0;
				// Track a new incoming transfer
				const rec = {
					id: crypto.randomUUID(),
					name: meta.name || (meta.size ? '(unknown)' : '(message)'),
					size: meta.size,
					mime: meta.mime,
					message: meta.message || '',
					received: 0,
					status: 'receiving',
					createdAt: Date.now(),
				};
				transfers.recv.push(rec);
				renderList(recvList, transfers.recv, 'recv');
				// keep reference to last item for progress updates
				dc._currentRecv = rec;
			} else if (msg.type === 'file-end') {
				const rec = dc._currentRecv;
				// If it's a message-only transfer (no bytes expected)
				const isMessageOnly = (meta?.size || 0) === 0;
				if (!isMessageOnly) {
					const blob = new Blob(chunks, { type: meta?.mime || 'application/octet-stream' });
					const url = URL.createObjectURL(blob);
					if (rec) {
						rec.url = url; // show manual Download link in actions
					}
				}
				if (rec) {
					rec.status = 'done';
					rec.received = rec.size;
					renderList(recvList, transfers.recv, 'recv');
				}
				if (isMessageOnly) {
					success('Received message');
				} else {
					success(
						'Received file',
						asFile(rec?.name || meta?.name || 'file'),
						'complete',
						asSize(rec?.size || meta?.size || 0)
					);
				}
				// reset
				meta = null;
				expectingHeader = true;
				received = 0;
				chunks.length = 0;
			}
			return;
		}
		// Binary chunk
		chunks.push(ev.data);
		received += ev.data.byteLength || ev.data.size || 0;
		if (dc._currentRecv) {
			dc._currentRecv.received = received;
			if (dc._currentRecv._progressEl) dc._currentRecv._progressEl.value = received;
			if (dc._currentRecv._metaEl)
				dc._currentRecv._metaEl.textContent = `${fmtSize(received)} / ${fmtSize(dc._currentRecv.size || 0)}`;
			if (dc._currentRecv._pctEl) {
				const total = dc._currentRecv.size || 0;
				const pct = total ? Math.floor((received / total) * 100) : 0;
				dc._currentRecv._pctEl.textContent = `${pct}%`;
			}
		}
	};
}

async function onSignal(from, payload) {
	from = formatCode(from);
	if (payload?.type === 'busy') {
		warn('Peer is busy', asId(from));
		statusEl.textContent = 'peer busy';
		if (statusWrap) {
			statusWrap.classList.remove('connected', 'connecting');
			statusWrap.classList.add('disconnected');
		}
		setUiConnected(false);
		return;
	}

	if (payload?.type === 'bye') {
		info('Peer ended session');
		await doDisconnect();
		return;
	}

	// If we're already connecting/connected to a different peer, ignore new inbound attempts
	if (
		pc &&
		(pc.connectionState === 'connecting' || pc.connectionState === 'connected') &&
		remoteId &&
		from !== remoteId
	) {
		warn('Ignoring incoming signal from', asId(from), '- already busy with', asId(remoteId));
		return;
	}
	remoteId = from;
	// Reflect the inbound peer in the input for clarity
	if (peerIdInput) peerIdInput.value = prettyCode(remoteId);
	await ensurePc();
	// If already connected, ignore new offers to avoid duplicate sessions
	if (connected && payload.type === 'offer') {
		warn('Ignoring new offer from', asId(from), '- already connected');
		return;
	}
	if (payload.type === 'offer') {
		await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
		const answer = await pc.createAnswer();
		await pc.setLocalDescription(answer);
		sendSignal(remoteId, { type: 'answer', sdp: pc.localDescription });
	} else if (payload.type === 'answer') {
		await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
	} else if (payload.type === 'candidate' && payload.candidate) {
		try {
			await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
		} catch (e) {
			error('ICE add err', e);
		}
	}
}

btnConnect.onclick = async () => {
	if (connected || (pc && ['connecting', 'connected'].includes(pc.connectionState))) {
		return alert('Already connected or connecting. Disconnect first.');
	}
	remoteId = formatCode(peerIdInput.value.trim());
	if (!remoteId) return alert('Enter peer code');
	// reflect normalized formatting back to input
	peerIdInput.value = prettyCode(remoteId);
	await ensurePc();
	dc = pc.createDataChannel('file');
	wireDc();
	const offer = await pc.createOffer();
	await pc.setLocalDescription(offer);
	sendSignal(remoteId, { type: 'offer', sdp: pc.localDescription });
	statusEl.textContent = 'connecting';
	if (statusWrap) {
		statusWrap.classList.remove('connected', 'disconnected');
		statusWrap.classList.add('connecting');
	}
	setUiConnected(true); // reflect connecting state in UI
	updateFileUi();
};

btnSend.onclick = async () => {
	if (!dc || dc.readyState !== 'open') return;
	const messageText = (msgTextInput && msgTextInput.value.trim()) || '';
	const file = fileInput.files && fileInput.files[0];

	// Support message-only send (no file selected)
	if (!file && messageText) {
		const meta = { type: 'file-header', name: '', size: 0, mime: '', message: messageText };
		dc.send(JSON.stringify(meta));
		dc.send(JSON.stringify({ type: 'file-end' }));
		const out = {
			id: crypto.randomUUID(),
			name: '(message)',
			size: 0,
			mime: 'text/plain',
			message: messageText,
			sent: 0,
			status: 'done',
			createdAt: Date.now(),
		};
		transfers.sent.push(out);
		renderList(sentList, transfers.sent, 'sent');
		success('Sent message');
		// Clear the message field after sending (mirrors file input clearing)
		if (msgTextInput) msgTextInput.value = '';
		updateFileUi();
		return;
	}

	if (!file) return; // neither file nor message

	const chunkSize = 16 * 1024; // 16KB chunks to play nice with buffers
	const meta = { type: 'file-header', name: file.name, size: file.size, mime: file.type, message: messageText };
	dc.send(JSON.stringify(meta));
	let offset = 0;
	// Track outgoing transfer
	const out = {
		id: crypto.randomUUID(),
		name: file.name,
		size: file.size,
		mime: file.type,
		message: messageText,
		sent: 0,
		status: 'sending',
		createdAt: Date.now(),
	};
	transfers.sent.push(out);
	renderList(sentList, transfers.sent, 'sent');
	while (offset < file.size) {
		const slice = file.slice(offset, offset + chunkSize);
		const buf = await slice.arrayBuffer();
		// backpressure handling
		while (dc.bufferedAmount > 4 * 1024 * 1024) {
			await new Promise((r) => setTimeout(r, 10));
		}
		dc.send(buf);
		offset += slice.size;
		out.sent = offset;
		if (out._progressEl) out._progressEl.value = offset;
		if (out._metaEl) out._metaEl.textContent = `${fmtSize(out.sent)} / ${fmtSize(out.size)}`;
		if (out._pctEl) {
			const pct = out.size ? Math.floor((out.sent / out.size) * 100) : 0;
			out._pctEl.textContent = `${pct}%`;
		}
	}
	dc.send(JSON.stringify({ type: 'file-end' }));
	out.status = 'done';
	out.sent = out.size;
	renderList(sentList, transfers.sent, 'sent');
	success('Sent file', asFile(file.name), asSize(file.size));
	// Clear both file selection and message field after sending
	if (fileInput) fileInput.value = '';
	if (msgTextInput) msgTextInput.value = '';
	updateFileUi();
};

// Clear file input and update UI
if (btnClearFile) {
	btnClearFile.addEventListener('click', () => {
		if (fileInput) fileInput.value = '';
		if (msgTextInput) msgTextInput.value = '';
		updateFileUi();
	});
}

// Enable/disable Send based on file selection state
if (fileInput) {
	fileInput.addEventListener('change', () => {
		updateFileUi();
	});
}
if (msgTextInput) {
	msgTextInput.addEventListener('input', () => {
		updateFileUi();
	});
}

// UI helpers
function setUiConnected(isConnected) {
	btnConnect.disabled = isConnected;
	peerIdInput.disabled = isConnected;
	ensureDisconnectButton();
	if (btnDisconnect) btnDisconnect.disabled = !isConnected && !(pc && pc.connectionState === 'connecting');
	updateFileUi();
}

function ensureDisconnectButton() {
	if (btnDisconnect) return;
	// Create and insert a Disconnect button next to Connect
	btnDisconnect = document.createElement('button');
	btnDisconnect.id = 'btnDisconnect';
	btnDisconnect.textContent = 'Disconnect';
	btnDisconnect.disabled = true;
	btnConnect.parentElement.insertBefore(btnDisconnect, btnConnect.nextSibling);
	btnDisconnect.addEventListener('click', doDisconnect);
}

async function doDisconnect() {
	// Gracefully close data channel and peer connection
	try {
		if (remoteId && ws && ws.readyState === WebSocket.OPEN) sendSignal(remoteId, { type: 'bye' });
	} catch {}
	try {
		if (dc && dc.readyState === 'open') dc.close();
	} catch {}
	try {
		if (pc) pc.close();
	} catch {}
	dc = null;
	pc = null;
	remoteId = null;
	connected = false;
	statusEl.textContent = 'disconnected';
	if (statusWrap) {
		statusWrap.classList.remove('connected', 'connecting');
		statusWrap.classList.add('disconnected');
	}
	setUiConnected(false);
	updateFileUi();
}

// Clipboard support with fallback for non-secure contexts
async function copyText(text) {
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
	} catch (e) {
		error('Fallback copy failed', e);
		ok = false;
	} finally {
		document.body.removeChild(ta);
	}
	return ok;
}

// Wire Copy button once
if (btnCopyId) {
	btnCopyId.addEventListener('click', async () => {
		if (!selfId) {
			alert('Your ID is not ready yet.');
			return;
		}
		const original = btnCopyId.textContent;
		const ok = await copyText(formatCode(selfId));
		if (ok) {
			btnCopyId.textContent = 'Copied!';
		} else {
			btnCopyId.textContent = 'Copy failed';
		}
		btnCopyId.disabled = true;
		setTimeout(() => {
			btnCopyId.textContent = original || 'Copy';
			btnCopyId.disabled = !selfId; // disabled until ID exists
		}, 1000);
	});
}

// Initialize file UI state on load
updateFileUi();

// Prefill peer code from URL (?to=CODE) for easy sharing
try {
	const u = new URL(location.href);
	const to = u.searchParams.get('to');
	if (to && peerIdInput) {
		const normalized = formatCode(to);
		if (normalized) peerIdInput.value = prettyCode(normalized);
	}
} catch {}

function buildShareLink() {
	// Use absolute URL with ?to=selfId so peer can paste and connect easily
	if (!selfId) return location.href;
	const base = location.origin + location.pathname;
	const url = new URL(base);
	url.searchParams.set('to', formatCode(selfId));
	return url.toString();
}

// Share URL with Web Share API fallback to clipboard
if (btnShare) {
	btnShare.addEventListener('click', async () => {
		if (!selfId) {
			alert('Your code is not ready yet.');
			return;
		}
		const url = buildShareLink();
		const text = `My code: ${prettyCode(selfId)}`;
		if (navigator.share) {
			try {
				await navigator.share({ title: document.title || 'P2P Web File Share', text, url });
				return;
			} catch (e) {
				// fall through to clipboard
			}
		}
		const ok = await copyText(url);
		if (ok) success('Link copied to clipboard');
		else warn('Copy failed. Manually copy:', url);
	});
}

// Show QR code overlay for the share URL (uses remote QR image service)
if (btnQR) {
	btnQR.addEventListener('click', () => {
		if (!selfId) {
			alert('Your code is not ready yet.');
			return;
		}
		const url = buildShareLink();
		const overlay = document.createElement('div');
		overlay.style.position = 'fixed';
		overlay.style.inset = '0';
		overlay.style.background = 'rgba(0,0,0,0.6)';
		overlay.style.display = 'flex';
		overlay.style.alignItems = 'center';
		overlay.style.justifyContent = 'center';
		overlay.style.zIndex = '9999';
		overlay.setAttribute('role', 'dialog');
		overlay.setAttribute('aria-modal', 'true');

		const box = document.createElement('div');
		box.style.background = '#fff';
		box.style.borderRadius = '8px';
		box.style.padding = '16px';
		box.style.boxShadow = '0 6px 24px rgba(0,0,0,0.25)';
		box.style.minWidth = '280px';
		box.style.maxWidth = '90vw';
		box.style.textAlign = 'center';

		const title = document.createElement('div');
		title.textContent = 'Scan to open';
		title.style.fontWeight = '600';
		title.style.marginBottom = '8px';

		const code = document.createElement('div');
		code.textContent = prettyCode(selfId);
		code.style.fontFamily = 'monospace';
		code.style.letterSpacing = '1px';
		code.style.marginBottom = '8px';

		const img = document.createElement('img');
		img.alt = 'QR code';
		img.width = 240;
		img.height = 240;
		img.style.imageRendering = 'pixelated';
		img.style.border = '1px solid #eee';
		img.style.background = '#fff';
		img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=' + encodeURIComponent(url);

		const link = document.createElement('div');
		link.textContent = url;
		link.style.fontSize = '12px';
		link.style.wordBreak = 'break-all';
		link.style.marginTop = '8px';

		const actions = document.createElement('div');
		actions.style.marginTop = '12px';
		actions.style.display = 'flex';
		actions.style.gap = '8px';
		actions.style.justifyContent = 'center';
		const btnCopy = document.createElement('button');
		btnCopy.textContent = 'Copy link';
		btnCopy.addEventListener('click', async (e) => {
			e.stopPropagation();
			const ok = await copyText(url);
			if (ok) btnCopy.textContent = 'Copied!';
			else btnCopy.textContent = 'Copy failed';
			setTimeout(() => (btnCopy.textContent = 'Copy link'), 1000);
		});
		const btnClose = document.createElement('button');
		btnClose.textContent = 'Close';
		btnClose.addEventListener('click', (e) => {
			e.stopPropagation();
			try {
				document.body.removeChild(overlay);
			} catch {}
		});
		actions.append(btnCopy, btnClose);

		box.append(title, code, img, link, actions);
		overlay.appendChild(box);
		overlay.addEventListener('click', () => {
			try {
				document.body.removeChild(overlay);
			} catch {}
		});
		box.addEventListener('click', (e) => e.stopPropagation());
		document.body.appendChild(overlay);
	});
}
