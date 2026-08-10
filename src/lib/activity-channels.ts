/** Outreach channels, shared by the HubSpot sync, the rep-facing logger and the
 * dashboard so all three agree on one vocabulary.
 *
 * HubSpot has no native activity type for a LinkedIn or Instagram DM (custom
 * activity types are a Sales Hub Pro feature this portal does not have, and
 * `hs_activity_type` is read-only to the API). So a social touch is logged as a
 * HubSpot NOTE and the channel is recovered two ways:
 *   1. the `[type:...]` marker the dashboard's quick logger writes, or
 *   2. a channel word at the start of the note, e.g. "LinkedIn: sent a pitch" -
 *      which is what a rep types naturally when logging straight into HubSpot.
 * Anything we cannot place stays null and counts as a plain note, as before.
 */

/** Texting. Tracked on its own because Quo, not HubSpot, is its source of
 * truth - the same rule that already applies to dials. */
export const SMS_CHANNEL = "sms";

/** Social/messaging channels. Reported together as "other channels" - the
 * volume per network is too small to be worth its own target. */
export const OTHER_CHANNELS = [
  "linkedin", "instagram", "facebook", "whatsapp", "other",
] as const;

export type OtherChannel = (typeof OTHER_CHANNELS)[number];

const OTHER_SET: ReadonlySet<string> = new Set(OTHER_CHANNELS);

export function isOtherChannel(activityType: string | null | undefined): boolean {
  return Boolean(activityType && OTHER_SET.has(activityType));
}

export function isSms(activityType: string | null | undefined): boolean {
  return activityType === SMS_CHANNEL;
}

export const CHANNEL_LABELS: Record<string, string> = {
  sms: "SMS/Text",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  facebook: "Facebook",
  whatsapp: "WhatsApp",
  other: "Other",
};

/** How HubSpot's Communications object (a connected SMS/WhatsApp/LinkedIn
 * integration) names each channel. Unused until such an integration is
 * connected, at which point those touches classify themselves. */
export const HS_COMMUNICATION_CHANNELS: Record<string, string> = {
  SMS: "sms",
  WHATS_APP: "whatsapp",
  LINKEDIN_MESSAGE: "linkedin",
  PHYSICAL_MAIL: "other",
  CUSTOM_CHANNEL_CONVERSATION: "other",
};

/** Words a rep might open a HubSpot note with, mapped to a channel. */
const ALIASES: Record<string, string> = {
  linkedin: "linkedin", "linked in": "linkedin", "linked-in": "linkedin",
  li: "linkedin", inmail: "linkedin",
  instagram: "instagram", insta: "instagram", ig: "instagram",
  facebook: "facebook", fb: "facebook", messenger: "facebook",
  whatsapp: "whatsapp", "whats app": "whatsapp", "whats-app": "whatsapp",
  wa: "whatsapp",
  sms: "sms", text: "sms", txt: "sms", texted: "sms",
};

// "LinkedIn: ...", "IG DM - ...", "FB messenger - ..." etc. A separator is
// required so ordinary prose ("Text me the deck" in a summary) cannot match.
// Longer filler words come first: alternation is ordered, so "message" would
// otherwise win over "messenger" and leave "nger" before the separator.
const PREFIX = new RegExp(
  `^\\s*(${Object.keys(ALIASES).join("|")})` +
  "\\s*(?:messenger|messages|message|msgs|msg|dms|dm|inmail|reply|follow[ -]?up)?" +
  "\\s*[:\\-\u2013]",
  "i",
);

/** Channel implied by the opening of a logged activity, else null. */
export function channelFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = PREFIX.exec(text);
  return m ? ALIASES[m[1].toLowerCase().replace(/\s+/g, " ")] ?? null : null;
}
