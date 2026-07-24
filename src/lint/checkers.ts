import type { TimelineEvent } from '../parser/index.js';
import { checkBoundaryFollowedByCompact } from './boundary-compact.js';
import { checkCommitGating } from './commit-gating.js';
import { checkFormatBeforeCommit } from './format-before-commit.js';
import { checkShellCommandLabel } from './shell-command-label.js';
import type { LintFinding } from './types.js';

export interface CheckerDefinition {
	id: string;
	// Fed to the activation-map Haiku call only — never shown to the user.
	ruleShapeDescription: string;
	check: (timeline: TimelineEvent[]) => LintFinding[];
}

export const CHECKERS: CheckerDefinition[] = [
	{
		id: 'commit-gating',
		ruleShapeDescription:
			'A rule requiring at least one user turn (explicit approval) between commits — ' +
			'i.e. the agent must not run `git commit` without the user having sent a message ' +
			'since the previous commit.',
		check: checkCommitGating,
	},
	{
		id: 'format-before-commit',
		ruleShapeDescription:
			'A rule requiring a formatter or auto-fix command (e.g. prettier, eslint --fix, ' +
			'black, gofmt, rustfmt) to run before every `git commit`.',
		check: checkFormatBeforeCommit,
	},
	{
		id: 'shell-command-label',
		ruleShapeDescription:
			'A rule requiring every shell command (Bash/PowerShell) to be preceded by a short ' +
			'labeled text block (e.g. a line starting with "RUNNING:") explaining what the ' +
			'command does before it runs.',
		check: checkShellCommandLabel,
	},
	{
		id: 'boundary-compact',
		ruleShapeDescription:
			'A rule requiring `/compact` to run after completing a logical unit of work (a git ' +
			'commit, a git push, a `gh pr create`, or a subagent finishing) before continuing.',
		check: checkBoundaryFollowedByCompact,
	},
];
