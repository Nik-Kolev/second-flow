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
	close: '<line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/>',
	wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.1 2.1-2.8-.7-.7-2.8 2.1-2.1z"/>',
	eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
};

const TOAST_DURATION_MS = 6000;
const TOAST_MAX = 3;

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

// Category identity (which rulebook layer a note is about) — deliberately not colored by
// severity, so it never competes with the outcome-level good/warning/critical signal.
const CATEGORY_META = {
	compliance: { color: 'var(--category-compliance)', label: 'Compliance' },
	environmentalInstruction: { color: 'var(--category-environmental)', label: 'Environmental' },
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
	// Number of extra "Load N more" pages revealed beyond the default view — reset whenever a
	// project's session list is freshly fetched.
	sessionsVisibleExtra: 0,
	currentFindings: null,
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

// A one-line summary for compact cards — falls back to a capped first sentence when there's no
// quoted span, or when the quote is too short to stand alone (e.g. a section name like "Session
// end" rather than an actual description) to be a useful one-line summary on its own.
const MIN_USEFUL_LEDE_LENGTH = 20;

function shortSummary(text) {
	const lede = extractLede(text);
	if (lede && lede.length >= MIN_USEFUL_LEDE_LENGTH) {
		return lede;
	}
	const firstSentence = splitIntoSentences(text)[0] ?? text;
	return firstSentence.length > 100 ? `${firstSentence.slice(0, 100)}…` : firstSentence;
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

function formatTime(date) {
	return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(date);
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

function categoryTagHtml(kind) {
	const meta = CATEGORY_META[kind];
	return `<span class="category-tag" style="color:${meta.color}">${escapeHtml(meta.label)}</span>`;
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
			<p class="hint">Includes small Haiku calls that run on their own — e.g. re-classifying your rulebook after you edit it — not just the audits you run</p>
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
		state.sessionsVisibleExtra = 0;
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
	if (session.audit.auditCount > 1) {
		badges.push(
			badgeHtml({
				color: 'var(--ink-muted)',
				icon: ICONS.repeat,
				label: `×${session.audit.auditCount} audits`,
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

const SESSIONS_RECENT_DAYS = 7;
const SESSIONS_PAGE_SIZE = 10;

// Sessions arrive newest-first (by fileMtime) — count how many fall within the recent window
// before hitting the first older one, since everything after that point is older still.
function countRecentSessions(sessions) {
	const cutoffMs = Date.now() - SESSIONS_RECENT_DAYS * 24 * 60 * 60 * 1000;
	let count = 0;
	for (const session of sessions) {
		if (new Date(session.fileMtime).getTime() < cutoffMs) {
			break;
		}
		count++;
	}
	return count;
}

function renderSessions() {
	const view = document.getElementById('sessions-view');
	const project = state.projects.find((entry) => entry.slug === state.currentSlug);
	const name = project ? projectName(project) : state.currentSlug;
	const path = project ? projectPath(project) : state.currentSlug;

	// The last 7 days are always fully visible (never hidden behind a click), with a floor of
	// SESSIONS_PAGE_SIZE so a quiet project still shows a reasonable amount up front. Anything
	// beyond that loads 10 at a time.
	const baseVisible = Math.max(countRecentSessions(state.sessions), SESSIONS_PAGE_SIZE);
	const visibleCount = Math.min(
		state.sessions.length,
		baseVisible + state.sessionsVisibleExtra * SESSIONS_PAGE_SIZE,
	);
	const visibleSessions = state.sessions.slice(0, visibleCount);
	const remaining = state.sessions.length - visibleCount;
	const loadMoreHtml =
		remaining > 0
			? `<button type="button" class="button-secondary load-more-button" id="load-more-sessions">Load ${Math.min(remaining, SESSIONS_PAGE_SIZE)} more</button>`
			: '';

	view.innerHTML = `
		<button type="button" class="back-link" id="back-to-projects">
			${iconSvg(ICONS.chevronLeft, 'currentColor')}All projects
		</button>
		<div class="session-list-heading">
			<h2>${escapeHtml(name)}</h2>
			<p class="project-path mono">${escapeHtml(path)}</p>
		</div>
		<ul class="row-list">${visibleSessions.map(sessionRowHtml).join('')}</ul>
		${loadMoreHtml}`;

	document.getElementById('back-to-projects').addEventListener('click', showProjects);
	if (loadMoreHtml) {
		document.getElementById('load-more-sessions').addEventListener('click', () => {
			state.sessionsVisibleExtra++;
			renderSessions();
		});
	}
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

/* ---- Toasts ---- */

function toastBodyHtml({ icon, message }) {
	return `
		<button type="button" class="toast-body">
			${iconSvg(icon, 'var(--status-good)')}
			<p class="toast-text">${message}</p>
		</button>
		<button type="button" class="toast-dismiss" aria-label="Dismiss notification">${iconSvg(ICONS.close, 'currentColor')}</button>`;
}

// Newest toast is always appended last, so with plain column flow (no column-reverse) it lands at
// the fixed bottom anchor while older toasts get pushed upward — the stacking order falls out of
// normal DOM order for free, no extra positioning logic needed.
function showToast({ icon, message, auditedSessionId }) {
	const container = document.getElementById('toast-container');
	while (container.children.length >= TOAST_MAX) {
		container.firstElementChild.remove();
	}
	const toast = document.createElement('div');
	toast.className = 'toast';
	toast.innerHTML = toastBodyHtml({ icon, message });
	container.appendChild(toast);

	let dismissed = false;
	const dismiss = () => {
		if (dismissed) {
			return;
		}
		dismissed = true;
		clearTimeout(timer);
		toast.classList.remove('visible');
		toast.addEventListener('transitionend', () => toast.remove(), { once: true });
	};
	const timer = setTimeout(dismiss, TOAST_DURATION_MS);
	toast.querySelector('.toast-dismiss').addEventListener('click', dismiss);
	if (auditedSessionId) {
		toast.querySelector('.toast-body').addEventListener('click', () => {
			dismiss();
			viewFindings(auditedSessionId);
		});
	}
	requestAnimationFrame(() => toast.classList.add('visible'));
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
		<div class="dialog-spinner-row">
			<div class="spinner"></div>
			<div>
				<p class="dialog-title">Running audit…</p>
				<p class="dialog-text">One judgment call — a large evidence window can take a minute.</p>
			</div>
		</div>`);
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
	const time = escapeHtml(formatTime(new Date()));
	const sessionLabel = escapeHtml(sessionId);
	const message =
		outcome.outcome === 'wavedThrough'
			? `Session <span class="mono">${sessionLabel}</span> recorded as clean — nothing found. Done at ${time}.`
			: `Session <span class="mono">${sessionLabel}</span> audited with <span class="mono">${escapeHtml(state.settings.judgmentModel)}</span> — done at ${time}.`;
	showToast({
		icon: outcome.outcome === 'wavedThrough' ? ICONS.shieldCheck : ICONS.checkCircle,
		message,
		auditedSessionId: outcome.auditedSessionId,
	});
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

// A bucket heading always carries its count, and an empty bucket says so explicitly ("None this
// audit") rather than disappearing — a category with nothing to report is itself an answer.
function bucketSectionHtml(icon, iconColor, label, items, cardFn) {
	const heading = `<h3 class="kind-heading">${iconSvg(icon, iconColor)}${escapeHtml(label)} <span class="kind-heading-count">(${items.length})</span></h3>`;
	if (items.length === 0) {
		return `${heading}<p class="empty-bucket">None this audit.</p>`;
	}
	return heading + findingListHtml(items.map(cardFn));
}

function sessionProposalCardHtml(proposal) {
	const meta = PROPOSAL_STATUS_META[proposal.status];
	return `
		<article class="finding-card">
			<div class="finding-head">
				${badgeHtml(meta)}
				<span class="finding-ref">${escapeHtml(proposal.targetRuleRef)}</span>
			</div>
			<p class="finding-field-label">Current wording</p>
			<p class="finding-text">${escapeHtml(proposal.targetTextSnapshot)}</p>
			<p class="finding-field-label">Proposed wording</p>
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
			label: `Recurred in ${marker.recurredInCount} of ${marker.laterAuditCount} later audit${plural} of a different session`,
		});
	}
	if (marker.laterAuditCount === 0) {
		return badgeHtml({
			color: 'var(--ink-muted)',
			icon: ICONS.clock,
			label: 'No later audit of a different session yet',
		});
	}
	const plural = marker.laterAuditCount === 1 ? '' : 's';
	return badgeHtml({
		color: 'var(--status-good)',
		icon: ICONS.checkCircle,
		label: `Not seen in ${marker.laterAuditCount} later audit${plural} of a different session`,
	});
}

// notesByKind groups compliance/environmental notes by rulebook layer (from the API) — this
// further splits those two kinds by the judgment model's own outcome classification, since
// outcome is the axis the Findings tab actually organizes cards around. Pre-migration rows have
// outcome: null and land in their own bucket rather than being guessed into either side.
function bucketNotesByOutcome(notesByKind) {
	const violations = [];
	const positives = [];
	const unclassified = [];
	for (const kind of ['compliance', 'environmentalInstruction']) {
		for (const note of notesByKind[kind] ?? []) {
			const entry = { ...note, kind };
			if (note.outcome === 'violation') {
				violations.push(entry);
			} else if (note.outcome === 'positive') {
				positives.push(entry);
			} else {
				unclassified.push(entry);
			}
		}
	}
	return { violations, positives, unclassified };
}

// Full evidence prose stays available, just never forced open — a card's default state is the
// one-line summary, matching every other compact card here (positives, prompt coaching).
function expandableEvidenceHtml(evidence) {
	return `
		<details class="evidence-toggle">
			<summary>Show full evidence</summary>
			<div class="finding-evidence">${formatEvidence(evidence)}</div>
		</details>
	`;
}

function violationNoteCardHtml(note) {
	const recurrenceHtml = note.recurrence ? recurrenceBadgeHtml(note.recurrence) : '';
	return `
		<article class="finding-card">
			<div class="finding-head">${categoryTagHtml(note.kind)}${recurrenceHtml}</div>
			<p class="finding-lede">${escapeHtml(shortSummary(note.evidence))}</p>
			${expandableEvidenceHtml(note.evidence)}
		</article>
	`;
}

// Compact by design — a positive instance isn't a problem to weigh, just a confirmation, so it
// gets one line and no evidence expansion at all.
function positiveNoteCardHtml(note) {
	return `
		<div class="positive-row">
			${iconSvg(ICONS.checkCircle, 'var(--status-good)')}
			${categoryTagHtml(note.kind)}
			<span>${escapeHtml(shortSummary(note.evidence))}</span>
		</div>
	`;
}

// Pre-migration rows have no outcome at all — shown as their own bucket rather than folded into
// either violations or positives, since that would be guessing at a verdict the judgment model
// never actually made.
function unclassifiedNoteCardHtml(note) {
	return `
		<article class="finding-card">
			<div class="finding-head">${categoryTagHtml(note.kind)}<span class="finding-ref">Not classified — audited before this feature shipped</span></div>
			<p class="finding-lede">${escapeHtml(shortSummary(note.evidence))}</p>
			${expandableEvidenceHtml(note.evidence)}
		</article>
	`;
}

function promptCoachingCardHtml(note) {
	const suggestionHtml = note.suggestion
		? `<p class="suggestion-line"><span class="suggestion-tag">Suggested:</span>${escapeHtml(note.suggestion)}</p>`
		: '<p class="suggestion-line none">No suggested rephrasing given</p>';
	return `
		<article class="finding-card">
			<p class="finding-lede">${escapeHtml(shortSummary(note.evidence))}</p>
			${suggestionHtml}
			${expandableEvidenceHtml(note.evidence)}
		</article>
	`;
}

function outcomeLegendHtml() {
	const item = (icon, color, label) =>
		`<span class="outcome-legend-item">${iconSvg(icon, color)}${escapeHtml(label)}</span>`;
	return `
		<div class="outcome-legend">
			${item(ICONS.wrench, 'var(--status-warning)', 'Rule change proposed')}
			${item(ICONS.eye, 'var(--ink-secondary)', 'No rule change — just missed')}
			${item(ICONS.checkCircle, 'var(--status-good)', 'Followed correctly')}
			${item(ICONS.chatBubble, 'var(--ink-muted)', 'Feedback on phrasing')}
		</div>`;
}

function auditChipHtml(entry) {
	const meta = SESSION_STATUS_META[entry.status] ?? {
		color: 'var(--ink-muted)',
		icon: ICONS.minusCircle,
		label: entry.status,
	};
	const modelLabel = entry.model ?? meta.label;
	const countsText =
		entry.status === 'completed'
			? `${entry.proposalsCreated ?? '?'} proposals · ${entry.notesCreated ?? '?'} notes`
			: meta.label;
	const costText = entry.costUsd != null ? ` · ${formatUsd(entry.costUsd)}` : '';
	const inner = `
		<span class="audit-chip-model">${iconSvg(meta.icon, meta.color)}${escapeHtml(modelLabel)}</span>
		<span class="audit-chip-meta">${escapeHtml(formatDateTime(entry.auditedAt))}</span>
		<span class="audit-chip-meta">${escapeHtml(countsText)}${escapeHtml(costText)}</span>
	`;
	if (entry.isCurrent) {
		return `<div class="audit-chip current">${inner}</div>`;
	}
	return `<button type="button" class="audit-chip" data-history-audit="${escapeHtml(entry.auditedSessionId)}">${inner}</button>`;
}

const AUDIT_CHIP_VISIBLE_CAP = 5;

// A single-audit session has nothing to switch between, so the strip only earns its place once
// there's an actual choice to make. Past the visible cap, the rest collapse behind a "+N more"
// toggle instead of the row wrapping indefinitely.
function auditChipStripHtml(history) {
	if (history.length <= 1) {
		return '';
	}
	if (history.length <= AUDIT_CHIP_VISIBLE_CAP) {
		return `<div class="audit-chip-strip">${history.map(auditChipHtml).join('')}</div>`;
	}
	const visible = history.slice(0, AUDIT_CHIP_VISIBLE_CAP - 1);
	const rest = history.slice(AUDIT_CHIP_VISIBLE_CAP - 1);
	return `
		<div class="audit-chip-strip">
			${visible.map(auditChipHtml).join('')}
			<details>
				<summary class="audit-chip audit-chip-overflow">+${rest.length} more</summary>
				<div class="audit-chip-strip">${rest.map(auditChipHtml).join('')}</div>
			</details>
		</div>`;
}

function renderFindings(data) {
	state.currentFindings = data;
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
	const currentHistoryEntry = (data.history ?? []).find((entry) => entry.isCurrent);
	const currentModel = currentHistoryEntry?.model ?? null;
	const modelLine = currentModel
		? `<p class="summary-meta">Judged by <span class="mono">${escapeHtml(currentModel)}</span></p>`
		: '';
	const tokensLine =
		currentHistoryEntry?.inputTokens != null && currentHistoryEntry?.outputTokens != null
			? `<p class="summary-meta mono">${formatCount(currentHistoryEntry.inputTokens)} in · ${formatCount(currentHistoryEntry.outputTokens)} out${currentHistoryEntry.costUsd != null ? ` · ${formatUsd(currentHistoryEntry.costUsd)}` : ''}</p>`
			: '';
	const backLinkHtml = `
		<button type="button" class="back-link" id="back-to-project-sessions">
			${iconSvg(ICONS.chevronLeft, 'currentColor')}Back to ${escapeHtml(projectLabel)} sessions
		</button>`;
	const summaryHtml = `
		<div class="session-summary">
			<div class="summary-head">
				${badgeHtml(meta)}
				<span class="row-title mono">${escapeHtml(session.transcriptSessionId)}</span>
			</div>
			<p class="summary-meta">${escapeHtml(projectLabel)}</p>
			<p class="summary-meta mono">${escapeHtml(projectSubpath)}</p>
			<p class="summary-meta">Audited ${escapeHtml(formatDateTime(session.auditedAt))}${escapeHtml(counts)}</p>
			${modelLine}
			${tokensLine}
			<div class="summary-actions">
				<button type="button" class="button-secondary" id="reaudit-findings-button">Re-run audit</button>
				<button type="button" class="button-secondary" id="export-findings-button">Export as Markdown</button>
			</div>
		</div>`;

	const buckets = bucketNotesByOutcome(data.notesByKind);
	const promptNotes = data.notesByKind.promptCoaching ?? [];
	const totalFindings =
		data.proposals.length +
		buckets.violations.length +
		buckets.positives.length +
		promptNotes.length +
		buckets.unclassified.length;

	let bodyHtml;
	if (totalFindings > 0) {
		// The 4 core buckets always render, counted, even at zero — an empty bucket is itself an
		// answer ("nothing missed this audit"), not something to hide as if the category didn't
		// apply. "Not classified" is the exception: a transitional bucket for pre-migration data,
		// shown only when it actually has something in it.
		const sections = [
			bucketSectionHtml(
				ICONS.wrench,
				'var(--status-warning)',
				'Rule change proposed',
				data.proposals,
				sessionProposalCardHtml,
			),
			bucketSectionHtml(
				ICONS.eye,
				'var(--ink-secondary)',
				'No rule change — just missed',
				buckets.violations,
				violationNoteCardHtml,
			),
			bucketSectionHtml(
				ICONS.checkCircle,
				'var(--status-good)',
				'Followed correctly',
				buckets.positives,
				positiveNoteCardHtml,
			),
			bucketSectionHtml(
				ICONS.chatBubble,
				'var(--ink-muted)',
				'Feedback on phrasing',
				promptNotes,
				promptCoachingCardHtml,
			),
		];
		if (buckets.unclassified.length > 0) {
			sections.push(
				bucketSectionHtml(
					ICONS.clock,
					'var(--ink-muted)',
					'Not classified — audited before this feature shipped',
					buckets.unclassified,
					unclassifiedNoteCardHtml,
				),
			);
		}
		bodyHtml = outcomeLegendHtml() + sections.join('');
	} else if (session.status === 'wavedThrough') {
		bodyHtml =
			'<p class="empty-state">Clean — the free checks found nothing worth a judgment call.</p>';
	} else if (session.status === 'errored') {
		bodyHtml =
			'<p class="empty-state">The judgment call errored — no findings were stored. The raw response is preserved on the AuditRunCall row.</p>';
	} else {
		bodyHtml = '<p class="empty-state">The judgment call returned no findings.</p>';
	}

	const chipStripHtml = auditChipStripHtml(data.history ?? []);

	panel.innerHTML = backLinkHtml + summaryHtml + chipStripHtml + bodyHtml;
	document.getElementById('back-to-project-sessions').addEventListener('click', async () => {
		selectTab('sessions');
		await openProject(session.projectSlug);
	});
	document
		.getElementById('export-findings-button')
		.addEventListener('click', exportFindingsAsMarkdown);
	document.getElementById('reaudit-findings-button').addEventListener('click', () => {
		state.currentSlug = session.projectSlug;
		startAuditFlow(session.transcriptSessionId, true);
	});
	for (const el of panel.querySelectorAll('[data-history-audit]')) {
		el.addEventListener('click', () => viewFindings(el.dataset.historyAudit));
	}
}

// Mirrors renderFindings' structure and ordering (session summary, then
// proposals-first-then-fixed-note-kind-order sections, then the same three empty-state
// sentences) but emits plain Markdown instead of HTML, and omits the audit-history list —
// sibling audit IDs have no meaningful Markdown analogue outside the running app. Kept
// independent rather than sharing helpers with renderFindings, since the two are fundamentally
// different output shapes — if renderFindings' section logic changes, make the same change here.
function buildFindingsMarkdown(data) {
	const session = data.auditedSession;
	const statusLabel = (SESSION_STATUS_META[session.status] ?? { label: session.status }).label;
	const counts =
		session.status === 'completed'
			? ` — ${session.proposalsCreated ?? '?'} proposals · ${session.notesCreated ?? '?'} notes · ${session.droppedProposalCount ?? 0} dropped as invalid`
			: '';
	const project = state.projects.find((entry) => entry.slug === session.projectSlug);
	const projectLabel = project ? projectName(project) : session.projectSlug;
	const projectSubpath = project ? projectPath(project) : session.projectSlug;
	const currentHistoryEntry = (data.history ?? []).find((entry) => entry.isCurrent);
	const tokensLine =
		currentHistoryEntry?.inputTokens != null && currentHistoryEntry?.outputTokens != null
			? `**Tokens:** ${formatCount(currentHistoryEntry.inputTokens)} in · ${formatCount(currentHistoryEntry.outputTokens)} out${currentHistoryEntry.costUsd != null ? ` · ${formatUsd(currentHistoryEntry.costUsd)}` : ''}`
			: null;

	const lines = [
		'# Second Flow findings',
		'',
		`**Session:** ${session.transcriptSessionId}`,
		`**Status:** ${statusLabel}`,
		`**Project:** ${projectLabel} (${projectSubpath})`,
		`**Audited:** ${formatDateTime(session.auditedAt)}${counts}`,
		...(tokensLine ? [tokensLine] : []),
		'',
	];

	const buckets = bucketNotesByOutcome(data.notesByKind);
	const promptNotes = data.notesByKind.promptCoaching ?? [];
	const totalFindings =
		data.proposals.length +
		buckets.violations.length +
		buckets.positives.length +
		promptNotes.length +
		buckets.unclassified.length;

	// The 4 core buckets always get a heading (with count), even at zero — mirrors renderFindings'
	// "an empty bucket is itself an answer" treatment. "Not classified" stays conditional.
	const sections = [
		['Rule change proposed', data.proposals.map(proposalMarkdown)],
		['No rule change — just missed', buckets.violations.map(noteMarkdown)],
		['Followed correctly', buckets.positives.map(positiveNoteMarkdown)],
		['Feedback on phrasing', promptNotes.map(promptCoachingMarkdown)],
	];
	if (buckets.unclassified.length > 0) {
		sections.push([
			'Not classified — audited before this feature shipped',
			buckets.unclassified.map(noteMarkdown),
		]);
	}

	if (totalFindings === 0) {
		if (session.status === 'wavedThrough') {
			lines.push('Clean — the free checks found nothing worth a judgment call.');
		} else if (session.status === 'errored') {
			lines.push(
				'The judgment call errored — no findings were stored. The raw response is preserved on the AuditRunCall row.',
			);
		} else {
			lines.push('The judgment call returned no findings.');
		}
		return lines.join('\n');
	}

	for (const [heading, cards] of sections) {
		lines.push(
			`## ${heading} (${cards.length})`,
			'',
			cards.length > 0 ? cards.join('\n') : '_None this audit._',
		);
	}
	return lines.join('\n');
}

// A fence sized to one backtick longer than any run already in the text — rule wording can
// itself contain fenced code examples, and a fixed ``` fence would close early on those.
function fenceFor(text) {
	const runs = text.match(/`+/g) ?? [];
	const longestRun = runs.reduce((max, run) => Math.max(max, run.length), 0);
	return '`'.repeat(Math.max(3, longestRun + 1));
}

function proposalMarkdown(proposal) {
	const statusLabel = PROPOSAL_STATUS_META[proposal.status].label;
	const currentFence = fenceFor(proposal.targetTextSnapshot);
	const proposedFence = fenceFor(proposal.proposedText);
	return [
		`### ${proposal.targetRuleRef}`,
		'',
		`**Status:** ${statusLabel}`,
		'',
		'**Current wording:**',
		'',
		`${currentFence}text`,
		proposal.targetTextSnapshot,
		currentFence,
		'',
		'**Proposed wording:**',
		'',
		`${proposedFence}text`,
		proposal.proposedText,
		proposedFence,
		'',
		'**Evidence:**',
		'',
		proposal.evidence,
		'',
	].join('\n');
}

// Mirrors the label text recurrenceBadgeHtml (above) renders onto a badge — plain text here
// since a Markdown file has no badge, just the same three possible sentences.
function recurrenceLabelText(marker) {
	if (marker.kind === 'recurred') {
		const plural = marker.laterAuditCount === 1 ? '' : 's';
		return `Recurred in ${marker.recurredInCount} of ${marker.laterAuditCount} later audit${plural} of a different session`;
	}
	if (marker.laterAuditCount === 0) {
		return 'No later audit of a different session yet';
	}
	const plural = marker.laterAuditCount === 1 ? '' : 's';
	return `Not seen in ${marker.laterAuditCount} later audit${plural} of a different session`;
}

function noteMarkdown(note) {
	const ref = note.ruleRef != null ? note.ruleRef : 'legacy — no rule link';
	const lines = [`### ${ref}`, ''];
	if (note.recurrence) {
		lines.push(`**Recurrence:** ${recurrenceLabelText(note.recurrence)}`, '');
	}
	lines.push(note.evidence, '');
	return lines.join('\n');
}

// Mirrors positiveNoteCardHtml's compactness — a confirmation, not a problem to weigh, so one
// bullet line rather than the full ref/recurrence/evidence card the other note kinds get.
function positiveNoteMarkdown(note) {
	return `- ${shortSummary(note.evidence)}`;
}

function promptCoachingMarkdown(note) {
	const lines = [note.evidence, ''];
	lines.push(
		note.suggestion ? `**Suggested:** ${note.suggestion}` : '_No suggested rephrasing given_',
		'',
	);
	return lines.join('\n');
}

function filenameSafe(value) {
	return String(value).replace(/[^A-Za-z0-9._-]+/g, '-');
}

function findingsMarkdownFilename(session) {
	return `${filenameSafe(session.projectSlug)}_${filenameSafe(session.transcriptSessionId)}-findings.md`;
}

function downloadTextFile(filename, mimeType, content) {
	const blob = new Blob([content], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = filename;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	URL.revokeObjectURL(url);
}

function exportFindingsAsMarkdown() {
	const data = state.currentFindings;
	if (!data) {
		return;
	}
	downloadTextFile(
		findingsMarkdownFilename(data.auditedSession),
		'text/markdown',
		buildFindingsMarkdown(data),
	);
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
