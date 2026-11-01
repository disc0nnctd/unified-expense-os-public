const ERROR_TEXT: Record<string, string> = {
  invite_not_found: "That invite code doesn't exist.",
  invite_already_redeemed: "That invite code was already used — ask for a fresh one.",
  invite_expired: "That invite code has expired — ask for a fresh one.",
  already_member: "You're already a member of that group.",
  participant_exists: "That identity already exists on the server.",
  registration_invite_only: "This server only accepts new identities via an invite code — ask a member for one.",
  participant_details_required: "Enter your name to join.",
  display_name_required: "Enter your name first.",
  entry_participant_forbidden: "Someone on this entry is no longer a member of the group.",
  allocation_sum_mismatch: "The split doesn't add up to the total.",
  payer_allocation_invalid: "The payer must be part of the split.",
  settlement_not_in_current_plan: "Balances changed since this suggestion — sync and try again.",
  context_forbidden: "You don't have access to that group.",
  context_owner_required: "Only the group's owner can do that.",
  device_not_onboarded: "Let's set this device up first.",
  // Two distinct server rejections: no credentials were sent at all, vs. the
  // ones we hold were refused. Both end in "log in again", but saying which
  // happened is the difference between a dead end and an instruction.
  auth_required: "You're signed out on this device — sign in again to continue.",
  invalid_token: "This device's sign-in expired — sign in again to continue.",
};

export function humanizeError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  if (ERROR_TEXT[code]) {
    return ERROR_TEXT[code];
  }
  if (code === "Failed to fetch" || code.startsWith("NetworkError")) {
    return "Can't reach the server — check your connection and try again.";
  }
  return code;
}
