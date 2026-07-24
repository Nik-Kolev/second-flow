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
	gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
	chatBubble: '<path d="M4 5h16v11H8l-4 4V5z"/>',
	arrowUp: '<line x1="12" y1="19" x2="12" y2="5"/><path d="M6 11l6-6 6 6"/>',
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

function escapeHtml(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// Evidence is free-text prose Sonnet writes — there's no structured "this part is a rule, this
// part is the user" data to color per category. What IS reliable: quoted spans ('...') mark
// referenced material (rule wording, a user message, an agent/skill name) regardless of which —
// setting those apart from the surrounding analysis, plus splitting the wall of prose into
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

function formatUsd(amount) {
	return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

function formatTokenCount(count) {
	return new Intl.NumberFormat('en-US').format(count);
}

function iconSvg(pathData, color) {
	return `<svg viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${pathData}</svg>`;
}

function badgeHtml(meta) {
	return `<span class="badge" style="color:${meta.color}">${iconSvg(meta.icon, meta.color)}${escapeHtml(meta.label)}</span>`;
}

function meterFillColor(percent) {
	if (percent >= 100) return 'var(--status-critical)';
	if (percent >= 70) return 'var(--status-warning)';
	return 'var(--status-good)';
}

// Updates only the meter's fill/width/numbers in place — never touches the rest of the overview
// strip, so changing the ceiling can't cause any layout jump elsewhere on the page.
function updateMeterDisplay(consumedThisRun, max) {
	const percent = max > 0 ? (consumedThisRun / max) * 100 : consumedThisRun > 0 ? 100 : 0;
	const fill = document.getElementById('meter-fill');
	fill.style.width = `${Math.min(percent, 100)}%`;
	fill.style.background = meterFillColor(percent);
	document.getElementById('meter-numbers').textContent = `${consumedThisRun} / ${max}`;
}

function renderOverview(overview) {
	const el = document.getElementById('overview');
	const { max, consumedThisRun } = overview.ceiling;

	const bannerHtml = overview.cappedRun.isCapped
		? `<div class="banner">${iconSvg(ICONS.triangleAlert, 'currentColor')}
			<span>This run stopped early at the spend ceiling — ${overview.cappedRun.skippedSessionCount} session(s) were skipped and can be picked up on the next run.</span>
		</div>`
		: '';

	el.innerHTML = `
		${bannerHtml}
		<div class="stat-tile">
			<p class="label">Second Flow's own spend</p>
			<p class="value">${formatUsd(overview.totalSpendUsd)}</p>
		</div>
		<div class="stat-tile">
			<p class="label">Audited session tokens</p>
			<p class="value">${formatTokenCount(overview.transcriptTokenTotal)}</p>
		</div>
		<div class="meter-tile">
			<p class="label">Sonnet call ceiling (this run)</p>
			<div class="meter-track"><div class="meter-fill" id="meter-fill"></div></div>
			<p class="meter-numbers" id="meter-numbers"></p>
			<div class="ceiling-control">
				<input type="number" id="ceiling-input" min="0" max="1000" step="1" value="${max}" />
				<span class="ceiling-status" id="ceiling-status"></span>
			</div>
		</div>
	`;

	updateMeterDisplay(consumedThisRun, max);

	// Auto-saves on change (fires on blur/Enter, not per keystroke) — no separate Save step. The
	// ceiling this input reflects is whatever was last successfully persisted; on failure the
	// input reverts to that value rather than showing a number that isn't actually saved.
	const ceilingInput = document.getElementById('ceiling-input');
	let lastSavedMax = max;
	ceilingInput.addEventListener('change', async () => {
		const status = document.getElementById('ceiling-status');
		const value = Number(ceilingInput.value);
		if (!Number.isInteger(value) || value < 0 || value > 1000) {
			status.textContent = 'Must be a whole number between 0 and 1000.';
			ceilingInput.value = lastSavedMax;
			return;
		}
		try {
			const response = await fetch('/api/dashboard/ceiling', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ maxSonnetCallsPerRun: value }),
			});
			if (!response.ok) {
				throw new Error('Save failed');
			}
			status.textContent = '';
			lastSavedMax = value;
			updateMeterDisplay(consumedThisRun, value);
		} catch {
			status.textContent = 'Failed to save — reverted.';
			ceilingInput.value = lastSavedMax;
		}
	});
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

function noteCardHtml(note, meta) {
	const lede = extractLede(note.evidence);
	const ledeHtml = lede ? `<p class="finding-lede">${escapeHtml(lede)}</p>` : '';
	return `
		<article class="finding-card">
			<div class="finding-head">${badgeHtml(meta)}</div>
			${ledeHtml}
			<div class="finding-evidence">${formatEvidence(note.evidence)}</div>
		</article>
	`;
}

function renderProposals(proposals) {
	const el = document.getElementById('panel-proposals');
	if (proposals.length === 0) {
		el.innerHTML = '<p class="empty-state">No rule-rewrite proposals yet.</p>';
		return;
	}
	el.innerHTML = findingListHtml(proposals.map(proposalCardHtml));
}

function renderNotes(notesByKind) {
	const el = document.getElementById('panel-notes');
	const order = ['compliance', 'environmentalInstruction', 'promptCoaching'];
	const sections = order
		.filter((kind) => notesByKind[kind] && notesByKind[kind].length > 0)
		.map((kind) => {
			const meta = NOTE_KIND_META[kind];
			const cards = notesByKind[kind].map((note) => noteCardHtml(note, meta));
			return `<h3 class="kind-heading">${escapeHtml(meta.label)}</h3>${findingListHtml(cards)}`;
		});

	el.innerHTML =
		sections.length > 0 ? sections.join('') : '<p class="empty-state">No notes yet.</p>';
}

async function main() {
	const response = await fetch('/api/dashboard');
	if (!response.ok) {
		document.getElementById('loading-message').textContent =
			'Failed to load — check the server console.';
		return;
	}
	const data = await response.json();

	document.getElementById('loading-message').remove();
	document.getElementById('tabs-container').hidden = false;
	wireBackToTop();

	renderOverview(data.overview);
	renderProposals(data.proposals);
	renderNotes(data.notesByKind);
}

document.addEventListener('DOMContentLoaded', main);
