const DEFAULT_FINDINGS_CAP = 10;

const ICONS = {
	triangleAlert:
		'<path d="M12 3 L22 20 L2 20 Z"/><line x1="12" y1="9" x2="12" y2="14"/><circle cx="12" cy="17" r="0.5" fill="currentColor" stroke="none"/>',
	alertCircle:
		'<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="13"/><circle cx="12" cy="16" r="0.5" fill="currentColor" stroke="none"/>',
	repeat: '<path d="M4 12a8 8 0 0 1 14-5.3L21 9"/><path d="M21 4v5h-5"/><path d="M20 12a8 8 0 0 1-14 5.3L3 15"/><path d="M3 20v-5h5"/>',
	checkCircle: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
	minusCircle: '<circle cx="12" cy="12" r="9"/><line x1="8" y1="12" x2="16" y2="12"/>',
	shieldAlert:
		'<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/><line x1="12" y1="8" x2="12" y2="13"/><circle cx="12" cy="16" r="0.5" fill="currentColor" stroke="none"/>',
	shieldCheck:
		'<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/>',
	gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
	chatBubble: '<path d="M4 5h16v11H8l-4 4V5z"/>',
	arrowUp: '<line x1="12" y1="19" x2="12" y2="5"/><path d="M6 11l6-6 6 6"/>',
	chevronLeft: '<path d="M15 6l-6 6 6 6"/>',
	clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
};

const PROPOSAL_STATUS_META = {
	proposed: { color: 'var(--status-warning)', icon: ICONS.triangleAlert, label: 'Proposed' },
	needsConfirm: {
		color: 'var(--status-serious)',
		icon: ICONS.alertCircle,
		label: 'Needs confirm',
	},
	recurring: { color: 'var(--status-critical)', icon: ICONS.repeat, label: 'Recurring' },
	resolved: { color: 'var(--status-good)', icon: ICONS.checkCircle, label: 'Resolved' },
	dismissed: { color: 'var(--ink-muted)', icon: ICONS.minusCircle, label: 'Dismissed' },
};

const NOTE_KIND_META = {
	compliance: { color: 'var(--status-serious)', icon: ICONS.shieldAlert, label: 'Compliance' },
	environmentalInstruction: {
		color: 'var(--status-warning)',
		icon: ICONS.gear,
		label: 'Environmental instruction',
	},
	promptCoaching: { color: 'var(--ink-muted)', icon: ICONS.chatBubble, label: 'Prompt coaching' },
};

const SESSION_STATUS_META = {
	completed: { color: 'var(--status-good)', icon: ICONS.checkCircle, label: 'Audited' },
	wavedThrough: { color: 'var(--status-good)', icon: ICONS.shieldCheck, label: 'Clean' },
	errored: { color: 'var(--status-critical)', icon: ICONS.alertCircle, label: 'Errored' },
	skippedCeiling: {
		color: 'var(--status-warning)',
		icon: ICONS.minusCircle,
		label: 'Skipped at ceiling',
	},
};

// One entry per src/analysis/gate.ts's GateTriggerKind union — kept in sync by hand, since the
// confirm dialog is the only place these need a plain-English explanation.
const TRIGGER_KIND_META = {
	'lint-finding': {
		label: 'Lint finding',
		description:
			'A deterministic rule check (e.g. commit approval, shell command labeling) found a mechanical rule violation.',
	},
	'rate-limit-hit': {
		label: 'Rate limit hit',
		description: "The session hit Anthropic's API rate limit at least once.",
	},
	'unexplained-cache-drop': {
		label: 'Unexplained cache drop',
		description:
			'The prompt-cache hit ratio dropped sharply between turns with no /compact to explain why.',
	},
	'repeat-subagent-invocation': {
		label: 'Repeat subagent invocation',
		description:
			'The same subagent type was invoked more than once in a way that looks like an unnecessary re-spawn.',
	},
	'user-pushback': {
		label: 'User pushback',
		description: 'The user pushed back on or corrected the assistant mid-session.',
	},
	'user-clarifying-question': {
		label: 'User clarifying question',
		description:
			'The user had to ask a clarifying question — often a sign the original request was under-specified.',
	},
};

const state = {
	stats: null,
	settings: null,
	proposals: [],
	projects: [],
	currentSlug: null,
	sessions: [],
};

function escapeHtml(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// Evidence is free-text prose the judgment model writes — there's no structured "this part is a
// rule, this part is the user" data to color per category. What IS reliable: quoted spans ('...')
// mark referenced material (rule wording, a user message, an agent/skill name) regardless of which
// — setting those apart from the surrounding analysis, plus splitting the wall of prose into
// sentence-per-line, is a real readability win without pretending to categorize what can't be.
// A fresh RegExp per call avoids g-flag lastIndex state leaking between exec()/replace() uses.
// Outer lookaround excludes a contraction apostrophe (user's, doesn't) from being read as the
// quote's own open/close mark. The inner alternation additionally lets a contraction *inside* an
// already-open quote (e.g. "...when it's actually time...") be consumed as ordinary content
// instead of wrongly ending the match early — without it, "[^']*?" can never skip past that
// apostrophe (it's excluded from the class either way) and the real closing quote is never found.
function quoteRegex() {
	return /(?<![a-zA-Z])'((?:[^']|(?<=[a-zA-Z])'(?=[a-zA-Z]))*?)'(?![a-zA-Z])/g;
}

function highlightQuotes(escapedText) {
	return escapedText.replace(
		quoteRegex(),
		(_match, inner) => `<span class="evidence-quote">'${inner}'</span>`,
	);
}

function findQuoteRanges(text) {
	const ranges = [];
	const re = quoteRegex();
	let match;
	while ((match = re.exec(text)) !== null) {
		ranges.push([match.index, match.index + match[0].length]);
	}
	return ranges;
}

function isInsideAnyRange(pos, ranges) {
	return ranges.some(([start, end]) => pos > start && pos < end);
}

// Splits on sentence boundaries, but never inside a quoted span — a quote that itself contains
// more than one sentence (e.g. "'Plan approved. Let me set up tasks...'") must stay whole, or
// its closing mark ends up in a different paragraph than its opening one and highlightQuotes
// (which only looks within one paragraph at a time) can't find the matching pair.
function splitIntoSentences(text) {
	const quoteRanges = findQuoteRanges(text);
	const splitRe = /(?<=[^.][.!?])\s+(?=[A-Z(])/g;
	const sentences = [];
	let lastIndex = 0;
	let match;
	while ((match = splitRe.exec(text)) !== null) {
		if (isInsideAnyRange(match.index, quoteRanges)) {
			continue;
		}
		sentences.push(text.slice(lastIndex, match.index));
		lastIndex = match.index + match[0].length;
	}
	sentences.push(text.slice(lastIndex));
	return sentences;
}

function formatEvidence(text) {
	return splitIntoSentences(text)
		.map((sentence) => `<p>${highlightQuotes(escapeHtml(sentence))}</p>`)
		.join('');
}

// A short "what's this actually about" line for the top of a note card — the first quoted span
// in the evidence, since that's almost always the rule/skill/message being referenced.
function extractLede(text) {
	const match = quoteRegex().exec(text);
	if (!match) {
		return null;
	}
	const quote = match[1];
	return quote.length > 70 ? `${quote.slice(0, 70)}…` : quote;
}

// Judgment calls cost fractions of a cent to a few dollars — two decimals would round a $0.0092
// activation call to $0.01, so sub-dollar amounts get four.
function formatUsd(amount) {
	return new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: 'USD',
		minimumFractionDigits: 2,
		maximumFractionDigits: amount > 0 && amount < 1 ? 4 : 2,
	}).format(amount);
}

function formatCount(count) {
	return new Intl.NumberFormat('en-US').format(count);
}

function formatDate(iso) {
	return new Intl.DateTimeFormat('en-GB', {
		day: 'numeric',
		month: 'short',
		year: 'numeric',
	}).format(new Date(iso));
}

function formatDateTime(iso) {
	return new Intl.DateTimeFormat('en-GB', {
		day: 'numeric',
		month: 'short',
		hour: '2-digit',
		minute: '2-digit',
	}).format(new Date(iso));
}

function formatBytes(bytes) {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${Math.round(bytes / 1024)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Sentence-cases a raw kind string ("lint-finding" -> "Lint finding") so every dialog row label —
// whether it comes from a fixed string in this file or a dynamic trigger kind from the server —
// reads with the same capitalization convention.
function prettyKind(kind) {
	const words = kind
		.replace(/[-_]/g, ' ')
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.toLowerCase();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

function triggerKindMeta(kind) {
	return TRIGGER_KIND_META[kind] ?? { label: prettyKind(kind), description: '' };
}

// The slug Claude Code assigns a project directory is a lossy encoding of its real path (every
// path separator AND every literal hyphen in a folder name both collapse to "-"), so it can never
// be decoded back reliably. `cwd`, when available (peeked server-side from a real transcript
// record), is the actual unambiguous path — these helpers turn it into a friendly display.
function splitPath(rawPath) {
	return rawPath.split(/[/\\]+/).filter(Boolean);
}

function projectName(project) {
	if (project.cwd) {
		const segments = splitPath(project.cwd);
		if (segments.length > 0) {
			return segments[segments.length - 1];
		}
	}
	return project.slug;
}

function projectPath(project) {
	if (project.cwd) {
		const segments = splitPath(project.cwd);
		const docIndex = segments.findIndex((segment) => segment.toLowerCase() === 'documents');
		const shown = docIndex >= 0 ? segments.slice(docIndex + 1) : segments;
		if (shown.length > 0) {
			return shown.join(' / ');
		}
	}
	return project.slug;
}

function iconSvg(pathData, color) {
	return `<svg viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${pathData}</svg>`;
}

function badgeHtml(meta) {
	return `<span class="badge" style="color:${meta.color}">${iconSvg(meta.icon, meta.color)}${escapeHtml(meta.label)}</span>`;
}

async function api(path, options) {
	const response = await fetch(path, options);
	const body = await response.json().catch(() => null);
	if (!response.ok) {
		const message =
			body && typeof body.error === 'string'
				? body.error
				: `Request failed (${response.status})`;
		const error = new Error(message);
		error.status = response.status;
		throw error;
	}
	return body;
}

/* ---- Tabs ---- */

const TAB_IDS = ['sessions', 'findings', 'proposals'];

function selectTab(name) {
	for (const id of TAB_IDS) {
		const selected = id === name;
		document.getElementById(`tab-${id}`).setAttribute('aria-selected', String(selected));
		document.getElementById(`panel-${id}`).hidden = !selected;
	}
}

function wireTabs() {
	for (const id of TAB_IDS) {
		document.getElementById(`tab-${id}`).addEventListener('click', () => selectTab(id));
	}
}

/* ---- Header: stats + settings ---- */

function renderStats(stats) {
	document.getElementById('stat-strip').innerHTML = `
		<div class="stat-tile">
			<p class="label">Second Flow's own spend</p>
			<p class="value">${formatUsd(stats.totalSpendUsd)}</p>
		</div>
		<div class="stat-tile">
			<p class="label">Sessions audited</p>
			<p class="value">${formatCount(stats.sessionsAudited)}</p>
		</div>
		<div class="stat-tile">
			<p class="label">Open proposals</p>
			<p class="value">${formatCount(stats.openProposalCount)}</p>
		</div>
	`;
}

function renderSettings(settings) {
	const container = document.getElementById('model-options');
	container.innerHTML = settings.models
		.map((model) => {
			const rates = model.pricing
				? `in ${formatUsd(model.pricing.input)} / out ${formatUsd(model.pricing.output)} per MTok`
				: 'no pricing data';
			const checked = model.id === settings.judgmentModel ? 'checked' : '';
			return `
				<label class="model-option">
					<input type="radio" name="judgment-model" value="${escapeHtml(model.id)}" ${checked} />
					<span>
						<span class="model-id mono">${escapeHtml(model.id)}</span>
						<span class="model-rates">${escapeHtml(rates)}</span>
					</span>
				</label>`;
		})
		.join('');

	const inputs = [...container.querySelectorAll('input[name="judgment-model"]')];
	for (const input of inputs) {
		input.addEventListener('change', () => saveJudgmentModelFromPopover(input.value, inputs));
	}
}

// The one place the judgmentModel setting actually gets written — both the popover's radio group
// and the confirm dialog's model select call this, so there is never a second, disconnected copy
// of "which model is selected" to fall out of sync.
async function persistJudgmentModel(modelId) {
	await api('/api/dashboard/settings', {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ judgmentModel: modelId }),
	});
	state.settings.judgmentModel = modelId;
}

async function saveJudgmentModelFromPopover(modelId, inputs) {
	const status = document.getElementById('settings-status');
	status.textContent = '';
	try {
		await persistJudgmentModel(modelId);
	} catch (error) {
		status.textContent = `Failed to save — reverted. ${error.message}`;
		for (const input of inputs) {
			input.checked = input.value === state.settings.judgmentModel;
		}
	}
}

function closeSettingsPopover() {
	document.getElementById('settings-popover').hidden = true;
	document.getElementById('settings-button').setAttribute('aria-expanded', 'false');
}

function wireSettingsPopover() {
	const button = document.getElementById('settings-button');
	const popover = document.getElementById('settings-popover');
	button.innerHTML = iconSvg(ICONS.gear, 'currentColor');
	button.addEventListener('click', () => {
		const opening = popover.hidden;
		popover.hidden = !opening;
		button.setAttribute('aria-expanded', String(opening));
	});
	document.addEventListener('click', (event) => {
		if (!popover.hidden && !popover.contains(event.target) && !button.contains(event.target)) {
			closeSettingsPopover();
		}
	});
	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape' && !popover.hidden) {
			closeSettingsPopover();
		}
	});
}

/* ---- Sessions tab ---- */

async function loadProjects() {
	const view = document.getElementById('projects-view');
	view.innerHTML = '<p class="loading">Loading projects…</p>';
	try {
		const data = await api('/api/projects');
		state.projects = data.projects;
		if (data.projects.length === 0) {
			view.innerHTML = `<p class="empty-state">No projects with sessions found under ${escapeHtml(data.projectsRoot)}.</p>`;
			return;
		}
		view.innerHTML = `
			<p class="list-heading">Projects (${data.projects.length})</p>
			<ul class="row-list">${data.projects.map(projectRowHtml).join('')}</ul>`;
		for (const el of view.querySelectorAll('[data-slug]')) {
			el.addEventListener('click', () => openProject(el.dataset.slug));
		}
	} catch (error) {
		view.innerHTML = `<p class="error-state">${escapeHtml(error.message)}</p>`;
	}
}

function projectRowHtml(project) {
	const plural = project.sessionCount === 1 ? '' : 's';
	return `
		<li class="row-card">
			<button type="button" class="row-main" data-slug="${escapeHtml(project.slug)}">
				<span class="project-identity">
					<span class="row-title">${escapeHtml(projectName(project))}</span>
					<span class="project-path mono">${escapeHtml(projectPath(project))}</span>
				</span>
				<span class="row-meta-group">
					<span class="row-meta">${project.sessionCount} session${plural}</span>
					<span class="row-meta">latest ${escapeHtml(formatDateTime(project.latestSessionMtime))}</span>
				</span>
			</button>
		</li>`;
}

async function openProject(slug) {
	state.currentSlug = slug;
	document.getElementById('projects-view').hidden = true;
	document.getElementById('sessions-view').hidden = false;
	await loadSessions();
}

function showProjects() {
	state.currentSlug = null;
	document.getElementById('sessions-view').hidden = true;
	document.getElementById('projects-view').hidden = false;
}

async function loadSessions() {
	const view = document.getElementById('sessions-view');
	view.innerHTML = '<p class="loading">Loading sessions…</p>';
	try {
		const data = await api(`/api/projects/${encodeURIComponent(state.currentSlug)}/sessions`);
		state.sessions = data.sessions;
		renderSessions();
	} catch (error) {
		view.innerHTML = `<p class="error-state">${escapeHtml(error.message)}</p>`;
	}
}

function sessionBadgesHtml(session) {
	if (!session.audit) {
		return badgeHtml({
			color: 'var(--ink-muted)',
			icon: ICONS.minusCircle,
			label: 'Never audited',
		});
	}
	const meta = SESSION_STATUS_META[session.audit.status] ?? {
		color: 'var(--ink-muted)',
		icon: ICONS.minusCircle,
		label: session.audit.status,
	};
	const badges = [
		badgeHtml({ ...meta, label: `${meta.label} · ${formatDate(session.audit.auditedAt)}` }),
	];
	if (session.audit.changedSinceAudit === true) {
		badges.push(
			badgeHtml({
				color: 'var(--status-warning)',
				icon: ICONS.triangleAlert,
				label: 'Changed since audit',
			}),
		);
	}
	return badges.join('');
}

function sessionRowHtml(session) {
	// The re-audit button is deliberately quiet unless the transcript changed — an unchanged
	// session's re-audit would double-spend for the same evidence.
	const reauditHtml = session.audit
		? `<button type="button" class="reaudit-button${session.audit.changedSinceAudit === true ? ' prominent' : ''}" data-reaudit="${escapeHtml(session.sessionId)}">Re-audit</button>`
		: '';
	return `
		<li class="row-card">
			<button type="button" class="row-main" data-session="${escapeHtml(session.sessionId)}">
				<span class="row-title mono">${escapeHtml(session.sessionId)}</span>
				<span class="row-meta">${escapeHtml(formatDateTime(session.fileMtime))}</span>
				<span class="row-meta">${escapeHtml(formatBytes(session.fileSize))}</span>
			</button>
			<span class="row-badges">${sessionBadgesHtml(session)}</span>
			${reauditHtml}
		</li>`;
}

function renderSessions() {
	const view = document.getElementById('sessions-view');
	const project = state.projects.find((entry) => entry.slug === state.currentSlug);
	const name = project ? projectName(project) : state.currentSlug;
	const path = project ? projectPath(project) : state.currentSlug;
	view.innerHTML = `
		<button type="button" class="back-link" id="back-to-projects">
			${iconSvg(ICONS.chevronLeft, 'currentColor')}All projects
		</button>
		<div class="session-list-heading">
			<h2>${escapeHtml(name)}</h2>
			<p class="project-path mono">${escapeHtml(path)}</p>
		</div>
		<ul class="row-list">${state.sessions.map(sessionRowHtml).join('')}</ul>`;

	document.getElementById('back-to-projects').addEventListener('click', showProjects);
	for (const el of view.querySelectorAll('[data-session]')) {
		el.addEventListener('click', () => {
			const session = state.sessions.find((s) => s.sessionId === el.dataset.session);
			if (session.audit) {
				viewFindings(session.audit.auditedSessionId);
			} else {
				startAuditFlow(session.sessionId, false);
			}
		});
	}
	for (const el of view.querySelectorAll('[data-reaudit]')) {
		el.addEventListener('click', () => startAuditFlow(el.dataset.reaudit, true));
	}
}

/* ---- Audit flow (preview → confirm → run) ---- */

function showDialog(html) {
	document.getElementById('audit-dialog-body').innerHTML = html;
	const dialog = document.getElementById('audit-dialog');
	if (!dialog.open) {
		dialog.showModal();
	}
}

function closeDialog() {
	document.getElementById('audit-dialog').close();
}

// A native <dialog>'s ::backdrop isn't a real element you can attach a listener to — a click on it
// still fires on the <dialog> itself, so the only way to detect "outside the visible box" is to
// compare the click's coordinates against the dialog's own bounding rect.
function wireDialogBackdropClose() {
	const dialog = document.getElementById('audit-dialog');
	dialog.addEventListener('click', (event) => {
		const rect = dialog.getBoundingClientRect();
		const inside =
			event.clientX >= rect.left &&
			event.clientX <= rect.right &&
			event.clientY >= rect.top &&
			event.clientY <= rect.bottom;
		if (!inside) {
			dialog.close();
		}
	});
}

// Cancel/close is always wired; the run button only when this dialog state has one.
function wireDialogActions(onRun) {
	const body = document.getElementById('audit-dialog-body');
	const cancel = body.querySelector('[data-dialog-cancel]');
	if (cancel) {
		cancel.addEventListener('click', closeDialog);
	}
	const run = body.querySelector('[data-dialog-run]');
	if (run && onRun) {
		run.addEventListener('click', onRun);
	}
}

function errorDialogHtml(title, message) {
	return `
		<p class="dialog-title">${escapeHtml(title)}</p>
		<p class="dialog-error">${escapeHtml(message)}</p>
		<div class="dialog-actions">
			<button type="button" class="button-secondary" data-dialog-cancel>Close</button>
		</div>`;
}

function freeNoteHtml(text) {
	return `<div class="dialog-free-note">${iconSvg(ICONS.shieldCheck, 'currentColor')}<span>${escapeHtml(text)}</span></div>`;
}

function dialogRowHtml(label, value, description) {
	const desc = description ? `<p class="row-desc">${escapeHtml(description)}</p>` : '';
	return `<li><div class="row"><span class="k">${escapeHtml(label)}</span><span class="v">${escapeHtml(String(value))}</span></div>${desc}</li>`;
}

function modelSelectHtml(models, currentModel) {
	const options = models
		.map(
			(model) =>
				`<option value="${escapeHtml(model.id)}" ${model.id === currentModel ? 'selected' : ''}>${escapeHtml(model.id)}</option>`,
		)
		.join('');
	return `
		<div class="dialog-field">
			<label for="dialog-model-select">Model</label>
			<select id="dialog-model-select">${options}</select>
		</div>`;
}

async function startAuditFlow(sessionId, force) {
	showDialog(`
		<p class="dialog-title">Checking session…</p>
		${freeNoteHtml('Free — no LLM call yet, except a one-time classification the first time a rulebook is seen.')}
		<p class="dialog-text">Reading the transcript and running deterministic rule checks (the same checks this tool always runs — e.g. commit approval, shell command labeling) plus structural stats (rate limits, cache usage, subagent calls), to decide whether anything here is worth a paid judgment call.</p>`);
	let preview;
	try {
		preview = await api(
			`/api/projects/${encodeURIComponent(state.currentSlug)}/sessions/${encodeURIComponent(sessionId)}/preview`,
			{ method: 'POST' },
		);
	} catch (error) {
		showDialog(errorDialogHtml('Preview failed', error.message));
		wireDialogActions(null);
		return;
	}

	if (preview.gate === 'wavedThrough') {
		showDialog(`
			<p class="dialog-title">Nothing to judge</p>
			${freeNoteHtml('Free — recording this doesn’t spend anything.')}
			<p class="dialog-text">The checks above found no triggers, so no judgment call is needed. Recording it marks the session as audited-clean in history, so it won’t need re-checking unless the transcript changes.</p>
			<div class="dialog-actions">
				<button type="button" class="button-secondary" data-dialog-cancel>Cancel</button>
				<button type="button" class="button-primary" data-dialog-run>Record as clean — free</button>
			</div>`);
		wireDialogActions(() => runAudit(sessionId, force));
		return;
	}

	const triggerRows = preview.triggers
		.map((trigger) => {
			const meta = triggerKindMeta(trigger.kind);
			return dialogRowHtml(meta.label, `×${trigger.count}`, meta.description);
		})
		.join('');
	const otherRows = [
		dialogRowHtml('Evidence window', `${preview.evidenceWindowEventCount} events`),
	];
	if (preview.estimate) {
		otherRows.push(
			dialogRowHtml('Estimated input', `${formatCount(preview.estimate.inputTokens)} tokens`),
			dialogRowHtml('Input cost', formatUsd(preview.estimate.inputCostUsd)),
			dialogRowHtml(
				'Max total (full output)',
				formatUsd(preview.estimate.maxTotalCostUsd),
				'Assumes the model uses its entire 4,096-token output budget. Real calls usually finish well short of that, so actual spend is typically lower than this ceiling.',
			),
		);
	}
	const estimateWarning = preview.estimateError
		? `<p class="dialog-warning">Cost estimate unavailable: ${escapeHtml(preview.estimateError)}</p>`
		: '';
	const forceWarning = force
		? '<p class="dialog-warning">Re-audit: this records a new audit alongside the earlier one.</p>'
		: '';
	const runLabel = preview.estimate
		? `Run audit — up to ${formatUsd(preview.estimate.maxTotalCostUsd)}`
		: 'Run audit';
	showDialog(`
		<p class="dialog-title">Run judgment call?</p>
		${freeNoteHtml('Still free — nothing has been sent to the judgment model yet. Only "Run audit" below makes one billed API call.')}
		${modelSelectHtml(state.settings.models, preview.model)}
		<ul class="dialog-list">${triggerRows}${otherRows.join('')}</ul>
		${estimateWarning}${forceWarning}
		<div class="dialog-actions">
			<button type="button" class="button-secondary" data-dialog-cancel>Cancel</button>
			<button type="button" class="button-primary" data-dialog-run>${escapeHtml(runLabel)}</button>
		</div>`);

	const select = document.getElementById('dialog-model-select');
	select.addEventListener('change', async () => {
		const chosen = select.value;
		select.disabled = true;
		try {
			await persistJudgmentModel(chosen);
			await startAuditFlow(sessionId, force);
		} catch (error) {
			showDialog(errorDialogHtml('Failed to switch model', error.message));
			wireDialogActions(null);
		}
	});
	wireDialogActions(() => runAudit(sessionId, force));
}

async function runAudit(sessionId, force) {
	showDialog(`
		<p class="dialog-title">Running audit…</p>
		<p class="dialog-text">One judgment call — a large evidence window can take a minute.</p>`);
	let outcome;
	try {
		outcome = await api(
			`/api/projects/${encodeURIComponent(state.currentSlug)}/sessions/${encodeURIComponent(sessionId)}/audit`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ force }),
			},
		);
	} catch (error) {
		const message =
			error.status === 409
				? 'This session was already audited — the list was stale and has been refreshed.'
				: error.message;
		showDialog(errorDialogHtml('Audit failed', message));
		wireDialogActions(null);
		await Promise.all([loadDashboard(), loadSessions()]);
		return;
	}

	await Promise.all([loadDashboard(), loadSessions()]);

	if (outcome.outcome === 'errored') {
		showDialog(
			errorDialogHtml(
				'Judgment call errored',
				`The call failed after being sent${outcome.usageLogged ? ' (its spend was still logged)' : ''}. The raw response and error are stored on the AuditRunCall row.`,
			),
		);
		wireDialogActions(null);
		return;
	}
	if (outcome.outcome === 'skippedCeiling') {
		showDialog(
			errorDialogHtml(
				'Skipped at ceiling',
				'The per-run call ceiling was already consumed — no judgment call was made.',
			),
		);
		wireDialogActions(null);
		return;
	}

	closeDialog();
	if (outcome.auditedSessionId) {
		await viewFindings(outcome.auditedSessionId);
	}
}

/* ---- Findings tab ---- */

async function viewFindings(auditedSessionId) {
	selectTab('findings');
	const panel = document.getElementById('panel-findings');
	panel.innerHTML = '<p class="loading">Loading findings…</p>';
	try {
		const data = await api(`/api/sessions/${encodeURIComponent(auditedSessionId)}`);
		renderFindings(data);
	} catch (error) {
		panel.innerHTML = `<p class="error-state">${escapeHtml(error.message)}</p>`;
	}
}

function findingListHtml(cardsHtml) {
	if (cardsHtml.length <= DEFAULT_FINDINGS_CAP) {
		return `<div class="finding-list">${cardsHtml.join('')}</div>`;
	}
	const visible = cardsHtml.slice(0, DEFAULT_FINDINGS_CAP);
	const rest = cardsHtml.slice(DEFAULT_FINDINGS_CAP);
	return `
		<div class="finding-list">${visible.join('')}</div>
		<details class="more-findings">
			<summary>Show ${rest.length} more</summary>
			<div class="finding-list">${rest.join('')}</div>
		</details>
	`;
}

function sessionProposalCardHtml(proposal) {
	const meta = PROPOSAL_STATUS_META[proposal.status];
	return `
		<article class="finding-card">
			<div class="finding-head">
				${badgeHtml(meta)}
				<span class="finding-ref">${escapeHtml(proposal.targetRuleRef)}</span>
			</div>
			<p class="finding-text">${escapeHtml(proposal.proposedText)}</p>
			<div class="finding-evidence">${formatEvidence(proposal.evidence)}</div>
		</article>
	`;
}

function recurrenceBadgeHtml(marker) {
	if (marker.kind === 'recurred') {
		const plural = marker.laterAuditCount === 1 ? '' : 's';
		return badgeHtml({
			color: 'var(--status-serious)',
			icon: ICONS.repeat,
			label: `Recurred in ${marker.recurredInCount} of ${marker.laterAuditCount} later audit${plural}`,
		});
	}
	if (marker.laterAuditCount === 0) {
		return badgeHtml({
			color: 'var(--ink-muted)',
			icon: ICONS.clock,
			label: 'No later audits yet',
		});
	}
	const plural = marker.laterAuditCount === 1 ? '' : 's';
	return badgeHtml({
		color: 'var(--status-good)',
		icon: ICONS.checkCircle,
		label: `Not seen in ${marker.laterAuditCount} later audit${plural}`,
	});
}

function noteCardHtml(note, meta) {
	const refHtml =
		note.ruleRef != null
			? `<span class="finding-ref">${escapeHtml(note.ruleRef)}</span>`
			: '<span class="finding-ref">legacy — no rule link</span>';
	const recurrenceHtml = note.recurrence ? recurrenceBadgeHtml(note.recurrence) : '';
	const lede = extractLede(note.evidence);
	const ledeHtml = lede ? `<p class="finding-lede">${escapeHtml(lede)}</p>` : '';
	return `
		<article class="finding-card">
			<div class="finding-head">${badgeHtml(meta)}${refHtml}${recurrenceHtml}</div>
			${ledeHtml}
			<div class="finding-evidence">${formatEvidence(note.evidence)}</div>
		</article>
	`;
}

function renderFindings(data) {
	const panel = document.getElementById('panel-findings');
	const session = data.auditedSession;
	const meta = SESSION_STATUS_META[session.status] ?? {
		color: 'var(--ink-muted)',
		icon: ICONS.minusCircle,
		label: session.status,
	};
	const counts =
		session.status === 'completed'
			? ` — ${session.proposalsCreated ?? '?'} proposals · ${session.notesCreated ?? '?'} notes · ${session.droppedProposalCount ?? 0} dropped as invalid`
			: '';
	const project = state.projects.find((entry) => entry.slug === session.projectSlug);
	const projectLabel = project ? projectName(project) : session.projectSlug;
	const projectSubpath = project ? projectPath(project) : session.projectSlug;
	const summaryHtml = `
		<div class="session-summary">
			<div class="summary-head">
				${badgeHtml(meta)}
				<span class="row-title mono">${escapeHtml(session.transcriptSessionId)}</span>
			</div>
			<p class="summary-meta">${escapeHtml(projectLabel)}</p>
			<p class="summary-meta mono">${escapeHtml(projectSubpath)}</p>
			<p class="summary-meta">Audited ${escapeHtml(formatDateTime(session.auditedAt))}${escapeHtml(counts)}</p>
		</div>`;

	const sections = [];
	if (data.proposals.length > 0) {
		sections.push(
			`<h3 class="kind-heading">Rule-rewrite proposals</h3>${findingListHtml(data.proposals.map(sessionProposalCardHtml))}`,
		);
	}
	for (const kind of ['compliance', 'environmentalInstruction', 'promptCoaching']) {
		const notes = data.notesByKind[kind] ?? [];
		if (notes.length === 0) {
			continue;
		}
		const kindMeta = NOTE_KIND_META[kind];
		sections.push(
			`<h3 class="kind-heading">${escapeHtml(kindMeta.label)}</h3>${findingListHtml(notes.map((note) => noteCardHtml(note, kindMeta)))}`,
		);
	}

	let bodyHtml;
	if (sections.length > 0) {
		bodyHtml = sections.join('');
	} else if (session.status === 'wavedThrough') {
		bodyHtml =
			'<p class="empty-state">Clean — the free checks found nothing worth a judgment call.</p>';
	} else if (session.status === 'errored') {
		bodyHtml =
			'<p class="empty-state">The judgment call errored — no findings were stored. The raw response is preserved on the AuditRunCall row.</p>';
	} else {
		bodyHtml = '<p class="empty-state">The judgment call returned no findings.</p>';
	}

	panel.innerHTML = summaryHtml + bodyHtml;
}

/* ---- Rule proposals tab (global) ---- */

function proposalCardHtml(group) {
	const meta = PROPOSAL_STATUS_META[group.status];
	const occurrence =
		group.occurrenceCount > 1
			? `<span class="finding-occurrence">${group.occurrenceCount} occurrences</span>`
			: '';
	return `
		<article class="finding-card">
			<div class="finding-head">
				${badgeHtml(meta)}
				<span class="finding-ref">${escapeHtml(group.targetRuleRef)}</span>
				${occurrence}
			</div>
			<p class="finding-text">${escapeHtml(group.representative.proposedText)}</p>
			<div class="finding-evidence">${formatEvidence(group.representative.evidence)}</div>
		</article>
	`;
}

// The empty state is provable, not a shrug: Unit 1's dropped-proposal counters let it say whether
// the judgment model genuinely returned zero or returned some that were dropped as invalid.
function renderProposalsTab() {
	const el = document.getElementById('panel-proposals');
	if (state.proposals.length > 0) {
		el.innerHTML = findingListHtml(state.proposals.map(proposalCardHtml));
		return;
	}
	const audited = state.stats?.sessionsAudited ?? 0;
	const dropped = state.stats?.droppedProposalTotal ?? 0;
	const plural = audited === 1 ? '' : 's';
	let message;
	if (audited === 0) {
		message = 'No sessions audited yet — run one from the Sessions tab.';
	} else if (dropped === 0) {
		message = `No rule-rewrite proposals. Across ${audited} audited session${plural}, the judgment model returned 0 — nothing was dropped as invalid.`;
	} else {
		message = `No valid rule-rewrite proposals. Across ${audited} audited session${plural}, ${dropped} ${dropped === 1 ? 'was' : 'were'} dropped for targeting a file that isn't in the rulebook.`;
	}
	el.innerHTML = `<p class="empty-state">${escapeHtml(message)}</p>`;
}

/* ---- Boot ---- */

async function loadDashboard() {
	const data = await api('/api/dashboard');
	state.stats = data.stats;
	state.settings = data.settings;
	state.proposals = data.proposals;
	renderStats(data.stats);
	renderSettings(data.settings);
	renderProposalsTab();
}

function wireBackToTop() {
	const button = document.getElementById('back-to-top');
	button.innerHTML = iconSvg(ICONS.arrowUp, 'currentColor');
	window.addEventListener('scroll', () => {
		button.classList.toggle('visible', window.scrollY > 300);
	});
	button.addEventListener('click', () => {
		window.scrollTo({ top: 0, behavior: 'smooth' });
	});
}

async function main() {
	wireTabs();
	wireSettingsPopover();
	wireBackToTop();
	wireDialogBackdropClose();
	document.getElementById('panel-findings').innerHTML =
		'<p class="empty-state">Select a session from the Sessions tab to see its findings.</p>';

	try {
		await loadDashboard();
	} catch {
		document.getElementById('loading-message').textContent =
			'Failed to load — check the server console.';
		return;
	}
	document.getElementById('tabs-container').hidden = false;
	loadProjects();
}

document.addEventListener('DOMContentLoaded', main);
