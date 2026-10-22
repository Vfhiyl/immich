/**
 * How long the records of deletions are kept for clients to sync, which a deployment configures. Like every retention
 * setting, a longer one applies to deletions recorded before too, while a shorter one only applies to deletions
 * recorded after the change: each setting stays in effect for the deletions recorded while it was set.
 */
export interface SyncDeleteRetentionSetting {
  /** Days, or null to keep them forever */
  days: number | null;
  /** When the setting was made, or null for the first one */
  since: string | null;
  /** When it was replaced, or null for the current one */
  until: string | null;
}

export interface SyncDeleteRetentionState {
  settings: SyncDeleteRetentionSetting[];
  /** Records of deletions before this time have been removed: a client that synced before it must sync anew */
  prunedBefore?: string;
}

/** Upstream removes the records of deletions after 31 days, which is how they were kept before the setting existed */
export const UPSTREAM_SYNC_DELETE_RETENTION_DAYS = 31;

const DAY = 24 * 60 * 60 * 1000;

/** Record the configured retention, if it changed; the first time, the retention of upstream is recorded as the one before */
export const withRetentionSetting = (
  state: SyncDeleteRetentionState | null | undefined,
  days: number | null,
  now: Date,
): SyncDeleteRetentionState => {
  const at = now.toISOString();
  const settings = state?.settings ?? [{ days: UPSTREAM_SYNC_DELETE_RETENTION_DAYS, since: null, until: null }];
  const current = settings.at(-1)!;
  if (current.days === days) {
    return state ?? { settings };
  }
  return {
    ...state,
    settings: [...settings.slice(0, -1), { ...current, until: at }, { days, since: at, until: null }],
  };
};

/**
 * Before when the records of deletions can be removed now, or null to keep them all. A record is removed once the
 * longer of the setting it was recorded under and the current one has passed; records are removed oldest first, so
 * that what is left is complete from the returned time on.
 */
export const getPruneBefore = ({ settings }: SyncDeleteRetentionState, now: Date): Date | null => {
  const current = settings.at(-1)!;
  let before = Infinity;
  for (const setting of settings) {
    const days = setting.days === null || current.days === null ? null : Math.max(setting.days, current.days);
    const since = setting.since ? new Date(setting.since).getTime() : -Infinity;
    const until = setting.until ? new Date(setting.until).getTime() : Infinity;
    const expired = days === null ? -Infinity : now.getTime() - days * DAY;
    if (until <= expired) {
      // every record of this setting has expired
      continue;
    }
    // records from when this setting was made may go, as far as they have expired
    before = Math.min(before, Math.max(since, expired));
  }

  return Number.isFinite(before) ? new Date(before) : null;
};
