/** DraftStreamer tunables — overridable via DraftStreamerDeps.constants.
 *  Defaults mirror the machine-spirit values (the draft-streaming design
 *  spec): native drafts tolerate frequent writes; the keepalive must beat the
 *  ~30s draft-expiry window; the typing action must re-fire before its ~5s
 *  lifetime lapses. */
export type DraftConstants = {
  throttleMs: number;
  keepaliveMs: number;
  typingHeartbeatMs: number;
  previewCap: number;
  maxFailures: number;
  drainMs: number;
  tickMs: number;
};

export const DEFAULT_DRAFT_CONSTANTS: DraftConstants = {
  throttleMs: 300, // min interval between draft content writes
  keepaliveMs: 20000, // re-send last draft text within the ~30s expiry window
  typingHeartbeatMs: 4500, // re-send `typing` before its ~5s lifetime lapses
  previewCap: 4000, // one-message cap for the live preview (= CHUNK_TARGET)
  maxFailures: 3, // consecutive send failures → disable draft for the turn
  drainMs: 1000, // finalize() wait for an in-flight write before abandoning
  tickMs: 250, // ticker granularity
};
