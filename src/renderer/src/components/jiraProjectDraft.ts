/**
 * The Jira-project configure form's draft shape and the two pure conversions
 * between it and a stored `JiraProjectBinding`.
 *
 * Pulled out of JiraProjectsRegistry.tsx into its own plain `.ts` module — no
 * JSX, no React import — for the same reason as `mcpInstallRule.ts`: this repo
 * has no DOM test harness, so a rule that only exists inside a component is a
 * rule no test can reach. `bindingFromDraft` is the COMMIT BOUNDARY of the
 * form (everything the user typed becomes the record that is persisted here,
 * and nowhere else), which makes it exactly the place normalization belongs
 * and exactly the place worth unit-testing.
 */
import type { JiraProjectBinding } from '@shared/jiraProjects';
import { normalizeIntakeLists, type TrelloIntakeBinding } from '@shared/trelloIntake';

export interface Draft {
  isNew: boolean;
  key: string;
  repo: string;
  baseBranch: string;
  agents: string[]; // agent ids, empty = any agent
  enabled: boolean;
  /** Trello source, or undefined when this project has none. The raw URL is
   *  kept beside it so the input can show what the user typed even when it
   *  does not parse. */
  trello?: TrelloIntakeBinding;
  trelloUrl: string;
}

export function draftFromBinding(b: JiraProjectBinding): Draft {
  return {
    isNew: false, key: b.key, repo: b.repo, baseBranch: b.baseBranch,
    agents: b.agents ?? [], enabled: b.enabled,
    trello: b.trello,
    trelloUrl: b.trello ? `https://trello.com/b/${b.trello.boardShortLink}` : ''
  };
}

export function emptyDraft(): Draft {
  return { isNew: true, key: '', repo: '', baseBranch: '', agents: [], enabled: true, trelloUrl: '' };
}

/**
 * The draft as it will be PERSISTED.
 *
 * The intake list names are normalized here and only here. The textarea keeps
 * every line the user types, blanks included (dropping them mid-edit would
 * make a trailing newline silently delete a name), so what arrives in the
 * draft is raw: `"Da fare "` from a paste out of Trello, or a trailing `""`
 * from the newline at the end. `validateTrelloIntake` trims only for CHECKING
 * and hands back nothing normalized, so without this step a trailing space
 * would save cleanly, reach god, and then miss the mission's "match list names
 * EXACTLY" rule on every cycle — a permanent, silent zero-intake. Trimming at
 * the commit boundary makes what is validated and what is stored the same
 * string. (Main-side `validateTrelloIntake` still guards the IPC path for
 * non-UI callers.)
 */
export function bindingFromDraft(d: Draft): JiraProjectBinding {
  return {
    key: d.key.trim().toUpperCase(),
    repo: d.repo.trim(),
    baseBranch: d.baseBranch.trim(),
    agents: d.agents.length > 0 ? d.agents : undefined,
    enabled: d.enabled,
    ...(d.trello
      ? {
        trello: {
          ...d.trello,
          boardShortLink: d.trello.boardShortLink.trim(),
          boardLabel: d.trello.boardLabel.trim(),
          intakeLists: normalizeIntakeLists(d.trello.intakeLists)
        }
      }
      : {})
  };
}
